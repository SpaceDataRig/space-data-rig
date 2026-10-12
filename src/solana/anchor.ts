// Solana mainnet provenance anchoring -- Node adapter.
//
// The pure on-chain logic (memo build/send, verify, endpoint failover, keypair-from-
// bytes) lives in `anchor-core.ts` so the Cloudflare Durable Object can reuse the exact
// same code with a secret keypair. This file adds the Node-only concerns on top:
//   - a dependency-free repo-root `.env` loader for local runs,
//   - `rpcCandidates()` reading `process.env` (private Alchemy first, public fallback),
//   - a filesystem keypair (load, or auto-generate + persist under out/), and
//   - the fs-backed ledger file (`out/ledger.json`) used by the CLI + local server.
//
// Nothing here runs on Workers (it touches node:fs), and nothing on the on-chain path
// was re-implemented -- we just wire the environment to the shared core. The public API
// (anchorBundleHash / verifyAnchor / readLedger / upsertLedger / explorerUrl / buildMemo)
// is unchanged so server.ts and scripts/p2-anchor.ts keep compiling.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import {
  anchorOnEndpoints,
  anchorMemoOnEndpoints,
  buildMemo,
  buildDeliberationMemo,
  DEFAULT_RPC,
  DELIB_MEMO_PREFIX,
  endpointList,
  explorerUrl,
  keypairFromSecretBytes,
  verifyOnEndpoints,
  MEMO_PREFIX,
  MEMO_PROGRAM_ID,
  type VerifyResult,
} from "./anchor-core.ts";

export { buildMemo, buildDeliberationMemo, DEFAULT_RPC, DELIB_MEMO_PREFIX, explorerUrl, MEMO_PREFIX, MEMO_PROGRAM_ID };

export interface AnchorOptions {
  rpcUrl?: string;
  keypairPath?: string;
  airdropSol?: number; // how much to request if unfunded (devnet)
  commitment?: "confirmed" | "finalized";
  /** build + return the memo without sending (offline preview / tests). */
  dryRun?: boolean;
}

export interface AnchorResult {
  ok: boolean;
  memo: string;
  signature?: string;
  slot?: number;
  publicKey?: string;
  explorerUrl?: string;
  /** the RPC endpoint that actually succeeded (useful for auditing failover). */
  rpcUrl?: string;
  dryRun?: boolean;
  error?: string;
}

export interface LedgerEntry {
  findingId: string;
  bundleHash: string;
  memo: string;
  status: "anchored" | "pending" | "failed";
  signature?: string;
  slot?: number;
  publicKey?: string;
  explorerUrl?: string;
  error?: string;
  anchoredAt?: string;
}

// ---- .env + RPC endpoint resolution (Node: reads process.env) ---------------

let localEnvLoaded = false;
/** Load the repo-root .env once (dependency-free); never overrides real env vars.
 *  Exported so the Node API server and the CLI can hydrate process.env (Solana RPC,
 *  DEEPSEEK/GROK chat keys) at boot -- the LLM path reads process.env but does not
 *  itself touch node:fs, so it relies on this being called first on the Node runtime. */
export function loadLocalEnv(): void {
  if (localEnvLoaded) return;
  localEnvLoaded = true;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Ordered, de-duplicated RPC endpoints: an explicit primary, then the private SOLANA_RPC
 * from the environment/.env, then SOLANA_RPC_FALLBACKS, then public mainnet. The first
 * provider that funds + submits + confirms wins, so one flaky RPC never breaks anchoring.
 */
export function rpcCandidates(primary?: string): string[] {
  loadLocalEnv();
  return endpointList(primary, process.env.SOLANA_RPC, process.env.SOLANA_RPC_FALLBACKS);
}

// ---- keypair (filesystem) ---------------------------------------------------

/**
 * Load a solana-style keypair (JSON byte array). Generates + persists one ONLY when the file is
 * genuinely absent. If the file EXISTS but cannot be read as a keypair, we REFUSE and throw rather
 * than silently regenerating: overwriting a corrupt-but-funded wallet file with a fresh empty keypair
 * would strand any balance on it with no signal. Corruption must be a loud error, not a quiet swap.
 */
export async function getOrCreateKeypair(path: string): Promise<Keypair> {
  const abs = resolve(path);
  if (existsSync(abs)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(abs, "utf8"));
    } catch (e) {
      throw new Error(`keypair file exists but is not valid JSON -- refusing to overwrite (would strand any funds): ${abs} (${e instanceof Error ? e.message : e})`);
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`keypair file exists but is not a non-empty JSON byte array -- refusing to overwrite: ${abs}`);
    }
    try {
      return await keypairFromSecretBytes(Uint8Array.from(raw as number[]));
    } catch (e) {
      throw new Error(`keypair file exists but could not be parsed as a keypair -- refusing to overwrite: ${abs} (${e instanceof Error ? e.message : e})`);
    }
  }
  const kp = await Keypair.generate();
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(Array.from(kp.secretKey)), "utf8");
  return kp;
}

// ---- public on-chain API (delegates to the shared core) ---------------------

/**
 * Anchor a bundle hash on Solana via an SPL Memo, walking the RPC endpoint list
 * (private first, public fallback). Returns the transaction signature on success, or
 * { ok:false, error } after every endpoint fails. dryRun builds the memo and returns
 * without touching the network or the keypair.
 */
export async function anchorBundleHash(
  findingId: string,
  bundleHash: string,
  opts: AnchorOptions = {},
): Promise<AnchorResult> {
  const memo = buildMemo(findingId, bundleHash);
  if (opts.dryRun) return { ok: true, memo, dryRun: true };

  const endpoints = rpcCandidates(opts.rpcUrl);
  const keypairPath = opts.keypairPath ?? process.env.SOLANA_KEYPAIR ?? resolve("out", "anchor-keypair.json");
  let kp: Keypair;
  try {
    kp = await getOrCreateKeypair(keypairPath);
  } catch (e) {
    return { ok: false, memo, error: `keypair load failed (${keypairPath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  const res = await anchorOnEndpoints(endpoints, kp, findingId, bundleHash, {
    airdropSol: opts.airdropSol,
    commitment: opts.commitment,
  });
  return { ...res, dryRun: false };
}

/** Independently verify an anchor against the chain (no trust in local state). */
export function verifyAnchor(signature: string, bundleHash: string, rpcUrl?: string): Promise<VerifyResult> {
  return verifyOnEndpoints(rpcCandidates(rpcUrl), signature, bundleHash);
}

/**
 * Anchor a sealed DELIBERATION receipt hash on Solana with the SEPARATE sdr:delib:1 memo
 * schema (never the science bundle memo). Same endpoint walk + keypair as anchorBundleHash;
 * dryRun previews the memo without touching the network or the keypair.
 */
export async function anchorDeliberationHash(
  findingId: string,
  deliberationHash: string,
  opts: AnchorOptions = {},
): Promise<AnchorResult> {
  const memo = buildDeliberationMemo(findingId, deliberationHash);
  if (opts.dryRun) return { ok: true, memo, dryRun: true };

  const endpoints = rpcCandidates(opts.rpcUrl);
  const keypairPath = opts.keypairPath ?? process.env.SOLANA_KEYPAIR ?? resolve("out", "anchor-keypair.json");
  let kp: Keypair;
  try {
    kp = await getOrCreateKeypair(keypairPath);
  } catch (e) {
    return { ok: false, memo, error: `keypair load failed (${keypairPath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  const res = await anchorMemoOnEndpoints(endpoints, kp, memo, {
    airdropSol: opts.airdropSol,
    commitment: opts.commitment,
  });
  return { ...res, dryRun: false };
}

/** Independently verify a deliberation anchor against the chain (delib memo prefix). */
export function verifyDeliberationAnchor(signature: string, deliberationHash: string, rpcUrl?: string): Promise<VerifyResult> {
  return verifyOnEndpoints(rpcCandidates(rpcUrl), signature, deliberationHash, DELIB_MEMO_PREFIX);
}

// ---- local anchor ledger (fs; mirrors on-chain state for the CLI + server) ---

export function readLedger(path: string): LedgerEntry[] {
  const abs = resolve(path);
  if (!existsSync(abs)) return [];
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as LedgerEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeLedger(path: string, entries: LedgerEntry[]): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(entries, null, 2), "utf8");
}

/** Insert or update a ledger entry keyed by findingId; returns the new ledger. */
export function upsertLedger(path: string, entry: LedgerEntry): LedgerEntry[] {
  const ledger = readLedger(path);
  const i = ledger.findIndex((e) => e.findingId === entry.findingId);
  if (i >= 0) ledger[i] = { ...ledger[i], ...entry };
  else ledger.push(entry);
  writeLedger(path, ledger);
  return ledger;
}
