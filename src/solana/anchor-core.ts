// Runtime-agnostic Solana provenance-anchoring core (web3.js v2/v3, kit-backed).
//
// This module contains EVERYTHING needed to write a bundle hash on-chain inside an
// SPL Memo instruction and to independently verify it, using ONLY the standard
// `fetch` + WebCrypto globals that exist on both Node 19+ and Cloudflare Workers.
// It deliberately imports NO `node:fs` and uses NO `Buffer` -- the memo bytes are
// built with `TextEncoder` (Uint8Array), and every environment/path detail is passed
// in by the caller. That split lets:
//   - `src/solana/anchor.ts`  (Node adapter) layer fs keypairs + a fs ledger file, and
//   - `src/cf/rig-state.do.ts` (Workers) layer a secret keypair + a DO SQLite ledger,
// ...on top of ONE shared, deterministic on-chain path.
//
// The `@solana/web3.js` v3 package is a compatibility layer over `@solana/kit`:
// `Connection`, `Keypair`, `Transaction`, `TransactionInstruction` and
// `sendAndConfirmTransaction` keep their familiar v1 shapes, but `Keypair` factory
// methods are async and some numeric RPC fields widen to `number | bigint`, which we
// coerce back to `number` at the edges here.

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

/** SPL Memo program (standard; no custom program required for provenance). */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Public mainnet RPC: the last-resort fallback when no private endpoint answers. */
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
export const MEMO_PREFIX = "sdr:1"; // space-data-rig, memo schema v1
/** Separate memo schema for the (non-reproducible) AI deliberation receipt. Kept distinct
 *  from the science bundle prefix so an auditor can tell the two on-chain records apart. */
export const DELIB_MEMO_PREFIX = "sdr:delib:1";
/** Third memo namespace: a commissioned NAMED OBSERVATION envelope -- the hash of { dedication, bundleHash }
 *  bound to an observation id. Kept distinct from the science bundle and the deliberation receipt so an
 *  auditor can tell all three apart on-chain. This builder is pure + additive; anchoring a named observation
 *  is a later phase and reuses the shared anchorMemoOnEndpoints path. */
export const OBSERVE_MEMO_PREFIX = "sdr:observe:1";

/** Public endpoints tried (in order) after the operator's private RPC(s). */
export const PUBLIC_FALLBACK_RPCS = ["https://api.mainnet-beta.solana.com"];

/**
 * Compact, parseable on-chain provenance record. The third field is ALWAYS the bundleHash
 * (the timestamped commitment) at position 2, so verifyOnEndpoints' substring check on the
 * bundleHash is unaffected whether or not a scienceHash is appended. When a caller supplies
 * `scienceHash` it is appended as a 4th field (`sdr:1|<id>|<bundleHash>|<scienceHash>`) so a new
 * anchor also carries the stable content address for cross-run comparison -- old 2-field callers
 * (and every historical anchor) produce the identical memo as before. Purely additive.
 */
export function buildMemo(findingId: string, bundleHash: string, scienceHash?: string): string {
  return scienceHash ? `${MEMO_PREFIX}|${findingId}|${bundleHash}|${scienceHash}` : `${MEMO_PREFIX}|${findingId}|${bundleHash}`;
}

/** Minimal shape the scienceHash dedup needs from a ledger row (both runtimes' LedgerEntry satisfy it). */
export interface AnchorableLedgerRow {
  findingId: string;
  status: string;
  signature?: string;
  scienceHash?: string;
}

/**
 * Dedup key for anchoring (audit-3 P0-B). Returns the FIRST already-anchored ledger row that carries
 * the SAME scienceHash -- i.e. the exact same content-addressed science is already committed on-chain --
 * so the caller can skip a second mainnet fee instead of re-anchoring an identical bundle. Deliberately
 * conservative: with no scienceHash (best-effort content address unavailable), no signature, or a
 * non-anchored/failed row, it returns null and the caller anchors normally. It NEVER matches on
 * bundleHash (each run is a distinct timestamped commitment) -- only on the stable content address.
 */
export function findAnchoredScience(rows: AnchorableLedgerRow[], scienceHash?: string): AnchorableLedgerRow | null {
  if (!scienceHash) return null;
  for (const r of rows) {
    if (r.status === "anchored" && r.signature && r.scienceHash && r.scienceHash === scienceHash) return r;
  }
  return null;
}

/** On-chain record for a sealed deliberation receipt (integrity of model commentary). */
export function buildDeliberationMemo(findingId: string, deliberationHash: string): string {
  return `${DELIB_MEMO_PREFIX}|${findingId}|${deliberationHash}`;
}

/**
 * On-chain record for a commissioned named observation. `observationHash` is the envelope hash binding the
 * (sanitized) dedication to the science bundle hash, so the public immutable record provably ties "this
 * dedication, this payment" to "exactly this reproducible result" -- including a null (no-transit) result.
 */
export function buildObserveMemo(observationId: string, observationHash: string): string {
  return `${OBSERVE_MEMO_PREFIX}|${observationId}|${observationHash}`;
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=mainnet`;
}

/** True when an RPC URL targets the devnet cluster (airdrop is only valid there). */
export function isDevnetRpc(url: string): boolean {
  return url.includes("devnet");
}

/**
 * Ordered, de-duplicated RPC endpoint list built from PLAIN STRINGS (no process.env):
 * an explicit primary, then a private endpoint, then a comma-separated fallback list,
 * then the public mainnet default(s). Callers pass their runtime's values, so the same
 * list logic powers the Node adapter (process.env) and the DO (Worker bindings).
 */
export function endpointList(
  primary?: string,
  privateRpc?: string,
  fallbacksCsv?: string,
  extraPublic: string[] = PUBLIC_FALLBACK_RPCS,
): string[] {
  const out: string[] = [];
  const add = (u?: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  add(primary);
  add(privateRpc);
  if (fallbacksCsv) for (const u of fallbacksCsv.split(",")) add(u.trim());
  for (const u of extraPublic) add(u);
  return out.length ? out : [DEFAULT_RPC];
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Transport errors can echo the full request URL, which may embed a private API key
  // (Alchemy /v2/<key>). Reduce every URL in the message to its host so raw endpoints
  // never reach user-visible errors, the ledger, or the live event log.
  return m.replace(/\bhttps?:\/\/[^\s"']+/gi, (u) => {
    try {
      return new URL(u).host;
    } catch {
      return "redacted-url";
    }
  });
}

/** Host-only label for an RPC endpoint. Private providers embed API keys in the URL
 *  path (e.g. Alchemy /v2/<key>); error text reaches the dashboard and the live log,
 *  so only the host may ever appear there -- never the full URL. */
function endpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-endpoint";
  }
}

// ---- keypair loading (pure; the secret bytes come from the caller) ---------

/** Build a kit-backed Keypair from a raw 64-byte secret key. */
export function keypairFromSecretBytes(bytes: Uint8Array): Promise<Keypair> {
  return Keypair.fromSecretKey(bytes);
}

/** Build a Keypair from a JSON byte-array string (the Worker secret format). */
export function keypairFromSecretJson(json: string): Promise<Keypair> {
  const arr = JSON.parse(json) as number[];
  if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32))
    throw new Error("SOLANA_KEYPAIR must be a JSON array of 64 (or 32) secret-key bytes");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

export interface AnchorSendOptions {
  airdropSol?: number; // devnet only: how much to request if unfunded
  commitment?: "confirmed" | "finalized";
  /**
   * Optional stable content address appended as the memo's 4th field (audit-10 #1). When supplied,
   * BOTH the Node and Worker anchor paths emit the identical `sdr:1|id|bundleHash|scienceHash` shape
   * -- the memo the on-chain tx carries is built here, so threading it through this one primitive is
   * what keeps the two runtimes consistent. Omitting it yields the classic 3-field memo.
   */
  scienceHash?: string;
}

export interface AnchorCoreResult {
  ok: boolean;
  memo: string;
  signature?: string;
  slot?: number;
  publicKey?: string;
  explorerUrl?: string;
  /** the RPC host that actually succeeded (host-only: private providers embed API
   *  keys in the URL path, and this field reaches the dashboard JSON). */
  rpcUrl?: string;
  error?: string;
}

/**
 * Ensure the fee-payer can pay for at least one transaction. On mainnet the key must
 * already hold SOL (no faucet) -> throw with a clear reason; on devnet, request a
 * modest airdrop (rate-limited) and retry.
 */
async function fundIfNeeded(conn: Connection, kp: Keypair, airdropSol: number, rpcUrl: string): Promise<void> {
  const minNeeded = 20_000; // a memo tx costs ~5000 lamports per signature
  let balance = Number(await conn.getBalance(kp.publicKey));
  if (balance >= minNeeded) return;

  if (!isDevnetRpc(rpcUrl)) {
    throw new Error(
      `fee-payer ${kp.publicKey.toBase58()} holds ${balance} lamports on mainnet (needs >= ${minNeeded}); ` +
        `deposit SOL to this address or supply a funded keypair.`,
    );
  }

  const lamports = Math.round(Math.max(0.01, airdropSol * 0.05) * LAMPORTS_PER_SOL);
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, lamports);
      await conn.confirmTransaction(sig, "confirmed");
      balance = Number(await conn.getBalance(kp.publicKey));
      if (balance >= minNeeded) return;
      lastErr = `airdrop confirmed but balance is still ${balance} lamports`;
    } catch (e) {
      lastErr = messageOf(e);
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(
    `could not fund ${kp.publicKey.toBase58()} on devnet (${lastErr}). The devnet faucet is rate-limited: ` +
      `retry later or fund the key once (solana airdrop 0.5 ${kp.publicKey.toBase58()} --url devnet).`,
  );
}

/**
 * Anchor a bundle hash by walking the ordered endpoint list and submitting an SPL Memo
 * transaction via the first endpoint that funds + sends + confirms. The memo is encoded
 * as UTF-8 -> Uint8Array (no Buffer). Returns the first success, or an aggregate error.
 */
export async function anchorOnEndpoints(
  endpoints: string[],
  kp: Keypair,
  findingId: string,
  bundleHash: string,
  opts: AnchorSendOptions = {},
): Promise<AnchorCoreResult> {
  return anchorMemoOnEndpoints(endpoints, kp, buildMemo(findingId, bundleHash, opts.scienceHash), opts);
}

/**
 * Anchor an arbitrary pre-built memo string -- the shared chain path for BOTH the science
 * bundle (`sdr:1|...`) and the deliberation receipt (`sdr:delib:1|...`). Walks the ordered
 * endpoint list, submitting via the first that funds + sends + confirms; returns the first
 * success or an aggregate (host-only, redacted) error.
 */
export async function anchorMemoOnEndpoints(
  endpoints: string[],
  kp: Keypair,
  memo: string,
  opts: AnchorSendOptions = {},
): Promise<AnchorCoreResult> {
  const failures: string[] = [];
  const commitment = opts.commitment ?? "confirmed";

  for (const rpcUrl of endpoints) {
    try {
      const conn = new Connection(rpcUrl, commitment);
      await fundIfNeeded(conn, kp, opts.airdropSol ?? 1, rpcUrl);

      const ix = new TransactionInstruction({
        keys: [], // the memo program takes no accounts
        programId: MEMO_PROGRAM_ID,
        data: new TextEncoder().encode(memo),
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = kp.publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signature = await sendAndConfirmTransaction(conn, tx, [kp], { commitment });
      const indexed = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      return {
        ok: true,
        memo,
        signature,
        slot: Number(indexed?.slot ?? 0),
        publicKey: kp.publicKey.toBase58(),
        explorerUrl: explorerUrl(signature),
        rpcUrl: endpointLabel(rpcUrl),
      };
    } catch (e) {
      failures.push(`${endpointLabel(rpcUrl)} -> ${messageOf(e)}`);
    }
  }
  return { ok: false, memo, error: `all RPC endpoints failed: ${failures.join(" | ")}` };
}

// ---- minimal base58 (Bitcoin alphabet) decoder, dependency-free ------------
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 char: ${ch}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0); // leading '1's are leading zero bytes
  }
  return Uint8Array.from(bytes.reverse());
}

/** base58 -> UTF-8 text (Web-safe; no Buffer). */
function base58ToText(b58: string): string {
  return new TextDecoder().decode(base58Decode(b58));
}

export interface VerifyResult {
  ok: boolean;
  found: boolean;
  memoMatches: boolean;
  memo?: string;
  error?: string;
}

/**
 * Independently verify an anchor: re-read the transaction from the chain (walking the
 * endpoint list) and confirm the memo contains the expected bundle hash. Trusts nothing
 * local. `found` distinguishes "not indexed yet on any endpoint" from "indexed but memo
 * does not match".
 */
export async function verifyOnEndpoints(
  endpoints: string[],
  signature: string,
  bundleHash: string,
  prefix: string = MEMO_PREFIX,
): Promise<VerifyResult> {
  let lastError = "";
  for (const url of endpoints) {
    try {
      const conn = new Connection(url, "confirmed");
      const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) {
        lastError = `${endpointLabel(url)}: transaction not found (not indexed on this provider yet)`;
        continue;
      }
      const msg = tx.transaction.message as unknown as { instructions?: { data?: string }[] };
      let memoText: string | undefined;
      for (const ix of msg.instructions ?? []) {
        const dataB58 = ix.data;
        if (!dataB58) continue;
        try {
          const decoded = base58ToText(dataB58);
          if (decoded.startsWith(prefix)) memoText = decoded;
        } catch {
          /* not base58 memo data; skip */
        }
      }
      const memoMatches = memoText != null && memoText.includes(bundleHash);
      return { ok: memoMatches, found: true, memoMatches, memo: memoText };
    } catch (e) {
      lastError = messageOf(e);
    }
  }
  return { ok: false, found: false, memoMatches: false, error: lastError || "not found on any RPC" };
}
