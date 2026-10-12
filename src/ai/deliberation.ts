// Deliberation receipt: a sealed, integrity-verifiable record of the model
// cross-examination for one finding.
//
// Boundary (do not blur this): the debate is MODEL output and is therefore
// NON-deterministic. It is sealed in its OWN namespace ("deliberations/<id>/") and
// NEVER enters the deterministic run pipeline or the scientific bundle hash
// (see bundle.ts). The receipt proves "these named reviewers said exactly this about
// this finding at this moment" -- an integrity/tamper-evidence claim about the
// commentary, not a reproducibility claim about the science. The science remains
// reproducible offline from the bundle alone, with or without any deliberation.
//
// Reuses the bundle layer's canonical JSON + SHA-256 so the seal is byte-stable
// regardless of key order, and the runtime-agnostic ArtifactStore port so the same
// code persists on Node (fs) and Cloudflare Workers (R2).

import type { ArtifactStore } from "../core/ports.ts";
import type { DiscussionTurn } from "./threads.ts";
import { canonicalJson, sha256Hex } from "../bundle/bundle.ts";

export const DELIBERATION_SCHEMA = "space-data-rig/deliberation@1";

/** One sealed line of model commentary. */
export interface DeliberationTurn {
  seat: string;
  tone: string;
  /** which chat model wrote this line (e.g. "deepseek-chat", "grok-4.7"). */
  model: string;
  text: string;
}

export interface DeliberationReceipt {
  schema: typeof DELIBERATION_SCHEMA;
  findingId: string;
  targetId: string;
  /** opaque link to the science bundle this commentary refers to (not a dependency). */
  bundleHash?: string;
  /** models that actually contributed, in first-appearance order, de-duplicated. */
  models: string[];
  /** ISO timestamp of when the debate was sealed. */
  generatedAt: string;
  /** only the model-written turns are sealed; grounded seat turns stay in the thread. */
  turns: DeliberationTurn[];
}

/** Build a receipt from a finding's discussion turns (grounded turns are ignored). */
export function buildDeliberationReceipt(input: {
  findingId: string;
  targetId: string;
  bundleHash?: string;
  turns: DiscussionTurn[];
  generatedAt?: string;
}): DeliberationReceipt {
  const modelTurns = (input.turns ?? []).filter((t) => t.model);
  const models: string[] = [];
  for (const t of modelTurns) if (!models.includes(t.model as string)) models.push(t.model as string);
  return {
    schema: DELIBERATION_SCHEMA,
    findingId: input.findingId,
    targetId: input.targetId,
    bundleHash: input.bundleHash,
    models,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    turns: modelTurns.map((t) => ({ seat: t.seat, tone: t.tone, model: t.model as string, text: t.text })),
  };
}

/** SHA-256 over the canonical receipt. Stable for a given receipt regardless of key order. */
export async function hashDeliberation(receipt: DeliberationReceipt): Promise<string> {
  return sha256Hex(canonicalJson(receipt));
}

/** Store key base for one finding's deliberation ("deliberations/<id>"). */
export function deliberationKey(findingId: string): string {
  return `deliberations/${findingId}`;
}

/** Persist a receipt + its hash. Idempotent: re-sealing the same finding overwrites. */
export async function persistDeliberation(store: ArtifactStore, receipt: DeliberationReceipt, hash: string): Promise<void> {
  const base = deliberationKey(receipt.findingId);
  await store.put(`${base}/receipt.json`, JSON.stringify(receipt, null, 2), "application/json");
  await store.put(`${base}/HASH.txt`, hash + "\n", "text/plain");
}

export interface DeliberationVerifyResult {
  ok: boolean;
  hashMatches: boolean;
  recomputedHash: string;
  storedHash: string | null;
  models: string[];
  turns: number;
}

/** Independent audit: recompute the hash from the stored receipt and compare to HASH.txt. */
export async function verifyDeliberation(store: ArtifactStore, findingId: string): Promise<DeliberationVerifyResult> {
  const base = deliberationKey(findingId);
  const text = await store.getText(`${base}/receipt.json`);
  if (text == null) throw new Error(`deliberation not found: ${findingId}`);
  const receipt = JSON.parse(text) as DeliberationReceipt;
  const recomputed = await hashDeliberation(receipt);
  const storedText = await store.getText(`${base}/HASH.txt`);
  const stored = storedText != null ? storedText.trim() : null;
  // A missing HASH.txt is a FAILURE, never a self-compared pass (mirrors verifyBundle): trusting the
  // recomputed hash when the stored one is gone would let someone delete HASH.txt to "pass" a check.
  const hashMatches = stored != null && stored === recomputed;
  return {
    ok: hashMatches,
    hashMatches,
    recomputedHash: recomputed,
    storedHash: stored,
    models: receipt.models ?? [],
    turns: (receipt.turns ?? []).length,
  };
}
