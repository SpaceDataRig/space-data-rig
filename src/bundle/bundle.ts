// Reproducible analysis bundle: canonical serialization, content hashing, and IO
// helpers that run unchanged on Node and Cloudflare Workers.
//
// This is the "product" the rig anchors on-chain. A bundle is a manifest that
// captures everything needed to reproduce and audit one finding:
//   - the recovered science (period, epoch, depth, duration, SNR)
//   - the mission-critic verdict + the individual checks behind it
//   - the sim-runner recovery confidence and the predicted ephemeris
//   - data provenance (catalog source, light-curve data hash)
//   - a SHA-256 of every artifact file (SVG plots)
//
// The bundle hash is computed over a CANONICAL (key-sorted, whitespace-free)
// JSON serialization, so the same inputs always yield the same hash. That hash
// is what we write to Solana mainnet -- a tamper-evident proof that "this analysis,
// with these numbers, existed at this time". verifyBundle() recomputes it from the
// stored manifest + artifact bytes, so an auditor (or the frontend "verify" button)
// can confirm nothing changed since it was anchored.
//
// Runtime-agnostic by design: hashing uses Web Crypto (globalThis.crypto.subtle,
// native on Node 19+ and Workers) and is therefore async; artifact bytes come from
// the caller in memory and are persisted/read through an ArtifactStore port, so this
// module touches neither node:fs nor any Cloudflare binding.

import type { Finding, TransitCandidate } from "../core/types.ts";
import type { ArtifactStore } from "../core/ports.ts";

export const BUNDLE_SCHEMA = "space-data-rig/bundle@1";

export interface EphemerisRecord {
  t0Bjd: number;
  periodDays: number;
  nextTransitsBjd: number[];
}

export interface ArtifactRecord {
  path: string; // file name within the bundle dir (e.g. "folded.svg")
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  findingId: string;
  targetId: string;
  createdAt: string;
  runId: string;
  codeVersion: string;
  candidate: Pick<
    TransitCandidate,
    "periodDays" | "epochBjd" | "durationHours" | "depthPpt" | "depthFrac" | "snr" | "power" | "nPointsInTransit"
  >;
  verdict: Finding["verdict"];
  verdictReason: string;
  recoveryConfidence?: number;
  aliasMultiple?: number;
  ephemeris?: EphemerisRecord;
  crossmatch: Finding["crossmatch"];
  checks?: { name: string; pass: boolean; detail: string }[];
  dataProvenance: {
    catalogSource?: string;
    lightCurveHash?: string;
    lightCurveSource?: string;
  };
  artifacts: ArtifactRecord[];
}

/** A bundle artifact held in memory (name = file name; bytes = file content). */
export interface InMemoryArtifact {
  name: string;
  bytes: Uint8Array;
}

/** SHA-256 hex of raw bytes, via Web Crypto. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh, non-shared ArrayBuffer so the input satisfies BufferSource
  // across TS lib versions (Uint8Array<ArrayBufferLike> is not assignable) and any
  // SharedArrayBuffer-backed input is handled safely.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  // `crypto` is a global on both Node 19+ (DOM/undici) and Workers (workers-types);
  // it is not surfaced on `typeof globalThis` under the Worker lib, so bind it here.
  // `buf` is a fresh ArrayBuffer-backed view, so it satisfies BufferSource cleanly.
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const out: string[] = [];
  for (const b of new Uint8Array(digest)) out.push(b.toString(16).padStart(2, "0"));
  return out.join("");
}

/** SHA-256 hex of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(input));
}

/**
 * Deterministic JSON: object keys sorted recursively, no insignificant
 * whitespace. Two logically-equal manifests always serialize identically,
 * which is what makes the bundle hash reproducible across runs/machines.
 */
export function canonicalJson(value: unknown): string {
  const enc = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return `[${v.map(enc).join(",")}]`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(obj[k])}`).join(",")}}`;
  };
  return enc(value);
}

/** The bundle hash: SHA-256 over the canonical manifest. */
export async function hashManifest(manifest: BundleManifest): Promise<string> {
  return sha256Hex(canonicalJson(manifest));
}

export interface BuildBundleInput {
  finding: Finding;
  runId: string;
  codeVersion: string;
  catalogSource?: string;
  lightCurveHash?: string;
  lightCurveSource?: string;
  ephemeris?: EphemerisRecord;
  aliasMultiple?: number;
  checks?: { name: string; pass: boolean; detail: string }[];
  /** Artifact files to include + hash, held in memory (no filesystem). */
  artifacts?: InMemoryArtifact[];
}

/**
 * Assemble a BundleManifest from in-memory inputs (no IO). Artifact records are
 * sorted by name so the hash is reproducible regardless of input order.
 */
export async function buildManifest(input: BuildBundleInput): Promise<BundleManifest> {
  const c = input.finding.candidate;
  const artifacts: ArtifactRecord[] = [];
  for (const a of input.artifacts ?? []) {
    artifacts.push({ path: a.name, sha256: await sha256Bytes(a.bytes), bytes: a.bytes.length });
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schema: BUNDLE_SCHEMA,
    findingId: input.finding.id,
    targetId: input.finding.targetId,
    createdAt: input.finding.createdAt,
    runId: input.runId,
    codeVersion: input.codeVersion,
    candidate: {
      periodDays: c.periodDays,
      epochBjd: c.epochBjd,
      durationHours: c.durationHours,
      depthPpt: c.depthPpt,
      depthFrac: c.depthFrac,
      snr: c.snr,
      power: c.power,
      nPointsInTransit: c.nPointsInTransit,
    },
    verdict: input.finding.verdict,
    verdictReason: input.finding.verdictReason,
    recoveryConfidence: input.finding.recoveryConfidence,
    aliasMultiple: input.aliasMultiple,
    ephemeris: input.ephemeris,
    crossmatch: input.finding.crossmatch,
    checks: input.checks,
    dataProvenance: {
      catalogSource: input.catalogSource,
      lightCurveHash: input.lightCurveHash,
      lightCurveSource: input.lightCurveSource,
    },
    artifacts,
  };
}

export interface ComposedBundle {
  manifest: BundleManifest;
  hash: string;
}

/** Build + hash a bundle (no IO). The caller persists it via an ArtifactStore. */
export async function composeBundle(input: BuildBundleInput): Promise<ComposedBundle> {
  const manifest = await buildManifest(input);
  const hash = await hashManifest(manifest);
  return { manifest, hash };
}

/**
 * Persist a composed bundle + its artifacts to an ArtifactStore under
 * "bundles/<findingId>/". Keys are identical on fs and R2, so the same verify/read
 * code works everywhere.
 */
export async function persistBundle(
  store: ArtifactStore,
  composed: ComposedBundle,
  artifacts: InMemoryArtifact[],
): Promise<void> {
  const base = `bundles/${composed.manifest.findingId}`;
  for (const a of artifacts) await store.put(`${base}/${a.name}`, a.bytes, "image/svg+xml");
  await store.put(`${base}/manifest.json`, JSON.stringify(composed.manifest, null, 2), "application/json");
  await store.put(`${base}/HASH.txt`, composed.hash + "\n", "text/plain");
}

export interface VerifyResult {
  ok: boolean;
  hashMatches: boolean;
  artifactsOk: boolean;
  missing: string[];
  mismatched: string[];
}

/**
 * Audit a persisted bundle: recompute the manifest hash and re-hash each artifact
 * from the store, confirming nothing changed since it was anchored.
 */
export async function verifyBundle(store: ArtifactStore, findingId: string): Promise<VerifyResult> {
  const base = `bundles/${findingId}`;
  const manifestText = await store.getText(`${base}/manifest.json`);
  if (manifestText == null) throw new Error(`bundle not found: ${findingId}`);
  const manifest = JSON.parse(manifestText) as BundleManifest;
  const recomputed = await hashManifest(manifest);

  const storedText = await store.getText(`${base}/HASH.txt`);
  const storedHash = storedText != null ? storedText.trim() : recomputed;
  const hashMatches = storedHash === recomputed;

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const a of manifest.artifacts) {
    const bytes = await store.get(`${base}/${a.path}`);
    if (bytes == null) {
      missing.push(a.path);
      continue;
    }
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== a.sha256 || bytes.length !== a.bytes) mismatched.push(a.path);
  }
  return {
    ok: hashMatches && missing.length === 0 && mismatched.length === 0,
    hashMatches,
    artifactsOk: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  };
}
