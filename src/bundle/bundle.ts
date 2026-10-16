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

/**
 * The BLIND-SCIENCE projection: exactly the evidence-driven result, and nothing that depends on WHICH
 * finding/target label it got, WHEN it ran, or HOW it was rendered or fetched. The content address
 * (scienceHash) is the SHA-256 of THIS projection, so re-running the same detection -- under a different
 * findingId, a different target name, a fresh timestamp/runId, a re-fetched light curve, or re-rendered
 * plots -- collapses to ONE scienceHash and the anchor dedup can actually fire.
 *
 * audit-4 ROOT CAUSE. The prior scienceHash was `{ ...manifest, createdAt: "", runId: "" }`, which still
 * folded in findingId, targetId, dataProvenance.lightCurveHash and artifacts[].sha256. On the live
 * F-HR-858-b/c/d trio (ONE detection re-run under three catalog labels) all four of those differ, so the
 * three scienceHashes never collided and the dedup was dead code -- three mainnet fees for one content.
 * A unit test on a hand-built stub ("two rows share a scienceHash") stayed green the whole time because
 * it asserted the predicate, never that real manifests PRODUCE an equal hash. tests/live-data-regression
 * now drives the real captured manifests through this function to close that gap.
 *
 * Deliberately EXCLUDED, and why each is not "the science":
 *   - findingId, targetId -- identity/label. The label is precisely what made the trio differ.
 *   - createdAt, runId -- when it ran. A timestamped commitment is bundleHash's job, not this one's.
 *   - codeVersion -- a re-run under a patch is still the same science when the numbers match.
 *   - dataProvenance -- lightCurveHash was unstable (a re-fetch, and a targetId mixed into computeDataHash).
 *   - artifacts -- the SVG sha256 embeds the targetId in the plot title, so it varies by label, not science.
 *   - the post-hoc / non-gating truth check -- it compares the period against the LABEL's catalog period, so
 *     it varies by target while the blind detection is identical. The project's own contract is that "the
 *     verdict is evidence-driven and never peeked at truth", so a truth-peeking annotation is not part of
 *     the science content address. The GATING checks (snr/depth/duration/coverage/odd-even/recovery/
 *     centroid/fap) ARE kept: each is a pure function of the candidate + light curve, so they differ only
 *     when the evidence differs -- never because of a label or a timestamp.
 */
export function scienceProjection(manifest: BundleManifest): Record<string, unknown> {
  const gatingChecks = (manifest.checks ?? []).filter((c) => !/non-gating|post-hoc/i.test(c.name));
  return {
    candidate: manifest.candidate,
    verdict: manifest.verdict,
    verdictReason: manifest.verdictReason,
    recoveryConfidence: manifest.recoveryConfidence,
    aliasMultiple: manifest.aliasMultiple,
    ephemeris: manifest.ephemeris,
    crossmatch: manifest.crossmatch,
    checks: gatingChecks,
  };
}

/**
 * Content-addressed SCIENCE hash: the SHA-256 of the blind-science projection above. Two runs that recover
 * the SAME science therefore share one scienceHash while carrying DIFFERENT bundleHashes:
 *   - bundleHash is a TIMESTAMPED COMMITMENT (it binds the analysis to the moment it ran);
 *   - scienceHash is a CONTENT ADDRESS (it identifies the science itself across runs, labels, and re-fetches).
 * It does NOT alter bundleHash or the stored manifest -- purely additive -- so no existing bundle, verdict,
 * or on-chain anchor changes. verify on-chain still matches on bundleHash (the commitment); cross-run dedup
 * uses scienceHash.
 */
export async function hashScience(manifest: BundleManifest): Promise<string> {
  return sha256Hex(canonicalJson(scienceProjection(manifest)));
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
  /** True when HASH.txt is absent -- verification FAILS, it never self-compares. */
  hashMissing: boolean;
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
  // A missing HASH.txt is a FAILURE, not a pass. The old code fell back to `storedHash = recomputed`,
  // which made hashMatches trivially true -- so deleting HASH.txt (plus editing the manifest) would
  // fool local verification. The on-chain anchor, not this file, is the real guarantee; here we only
  // confirm the stored artifacts still reproduce the hash that was written alongside them.
  const hashMissing = storedText == null;
  const storedHash = hashMissing ? null : storedText!.trim();
  const hashMatches = storedHash != null && storedHash === recomputed;

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
    ok: hashMatches && !hashMissing && missing.length === 0 && mismatched.length === 0,
    hashMatches,
    hashMissing,
    artifactsOk: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  };
}
