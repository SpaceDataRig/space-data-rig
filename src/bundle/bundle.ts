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
  > & {
    /**
     * AUDITABILITY FIELDS (audit pass 4, 2026-10-18), all OPTIONAL and all EXCLUDED from the content address (see
     * scienceProjection). A record now publishes a depth and an SNR that are supposed to describe each other, and the
     * relation `snr = depthFrac / noiseSigmaFrac * sqrt(nPointsInTransit)` is the only way to prove it. Two of the
     * three quantities were absent from the anchored manifest, so a reader holding the committed file could neither
     * check the pair nor see what the detector measured before a refinement replaced it -- which is precisely the
     * defect the guard fixes. They are added here so the commitment is checkable, and kept out of the science hash
     * because they are metadata about HOW the number was produced, not a different number: adding them to the
     * content address would break the cross-run anchor dedup for re-runs of identical science (audit-3 P0-B), the
     * exact failure that once made three fees for one detection.
     */
    depthSource?: TransitCandidate["depthSource"];
    blsBoxDepthFrac?: number;
    perSectorDepthFrac?: number;
    noiseSigmaFrac?: number;
    detectionSnr?: number;
  };
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
 * Manifest candidate fields that describe HOW a published number was produced rather than which number was
 * published: committed in the bundle so it can be audited, excluded from the content address so a re-run of
 * identical science still collapses to one scienceHash. Absent on every manifest written before this existed,
 * so excluding them changes no already-anchored address (verified by tests/bundle.test.ts).
 */
export const PROVENANCE_ONLY_CANDIDATE_KEYS = [
  "depthSource",
  "blsBoxDepthFrac",
  "perSectorDepthFrac",
  "noiseSigmaFrac",
  "detectionSnr",
] as const;

/**
 * The BLIND-SCIENCE projection: exactly the evidence-driven result, and nothing that depends on WHICH
 * finding/target label it got, WHEN it ran, or HOW it was rendered. The photometry ITSELF is bound
 * (dataProvenance, audit-6): the same numbers computed from different bytes are different science.
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
 *   - dataProvenance is INCLUDED as of audit-6 (audit-4 excluded it while lightCurveHash was still
 *     unstable). Once computeDataHash() dropped targetId, the light-curve hash became a pure function of
 *     the photometry bytes -- label- and timestamp-independent -- and catalogSource / lightCurveSource are
 *     constant across the label trio (measured on live manifests), so binding it re-attaches "this science
 *     was computed from THESE bytes" to the content address WITHOUT resurrecting the dead-dedup problem:
 *     the live trio still collapses to ONE hash (tests/live-data-regression.test.ts), while a synthetic
 *     stand-in can no longer share a real-data address.
 *   - artifacts -- the SVG sha256 embeds the targetId in the plot title, so it varies by label, not science.
 *   - the post-hoc / non-gating truth check -- it compares the period against the LABEL's catalog period, so
 *     it varies by target while the blind detection is identical. The project's own contract is that "the
 *     verdict is evidence-driven and never peeked at truth", so a truth-peeking annotation is not part of
 *     the science content address. The GATING checks (snr/depth/duration/coverage/odd-even/recovery/
 *     centroid/fap) ARE kept: each is a pure function of the candidate + light curve, so they differ only
 *     when the evidence differs -- never because of a label or a timestamp.
 *   - the candidate's provenance-only fields (PROVENANCE_ONLY_CANDIDATE_KEYS) -- which estimator produced the
 *     published depth, what the other one measured, and the scatter the SNR was divided by. They are committed in
 *     the manifest so a reader can check `snr = depthFrac/noiseSigmaFrac*sqrt(nIn)`, but binding them into the
 *     content address would give two runs of the SAME published numbers different scienceHashes and re-open the
 *     dead-dedup fee bug (audit-3 P0-B).
 */
export function scienceProjection(manifest: BundleManifest): Record<string, unknown> {
  const gatingChecks = (manifest.checks ?? []).filter((c) => !/non-gating|post-hoc/i.test(c.name));
  const candidate: Record<string, unknown> = { ...manifest.candidate };
  for (const k of PROVENANCE_ONLY_CANDIDATE_KEYS) delete candidate[k];
  return {
    candidate,
    verdict: manifest.verdict,
    verdictReason: manifest.verdictReason,
    recoveryConfidence: manifest.recoveryConfidence,
    aliasMultiple: manifest.aliasMultiple,
    ephemeris: manifest.ephemeris,
    crossmatch: manifest.crossmatch,
    dataProvenance: manifest.dataProvenance,
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

/**
 * The PRE-audit-6 projection (the blind science WITHOUT dataProvenance). Kept for ONE reason: ledger rows
 * sealed before audit-6 store a scienceHash computed without provenance, so the anchor dedup must also
 * match on this legacy address or a re-run of already-anchored science would pay a second mainnet fee.
 * New rows always store the provenance-bound hashScience(); this is never written to a ledger or a memo.
 */
export function legacyScienceProjection(manifest: BundleManifest): Record<string, unknown> {
  const p = { ...scienceProjection(manifest) };
  delete p.dataProvenance;
  return p;
}

/** SHA-256 of the legacy (pre-audit-6) projection; dedup fallback only. See legacyScienceProjection. */
export async function hashScienceLegacy(manifest: BundleManifest): Promise<string> {
  return sha256Hex(canonicalJson(legacyScienceProjection(manifest)));
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
      // Committed, not content-addressed (see PROVENANCE_ONLY_CANDIDATE_KEYS): the reader of the anchored file must
      // be able to re-derive the published SNR from the published depth and see both estimator readings.
      ...(c.depthSource != null ? { depthSource: c.depthSource } : {}),
      ...(Number.isFinite(c.blsBoxDepthFrac) ? { blsBoxDepthFrac: c.blsBoxDepthFrac } : {}),
      ...(Number.isFinite(c.perSectorDepthFrac) ? { perSectorDepthFrac: c.perSectorDepthFrac } : {}),
      ...(Number.isFinite(c.noiseSigmaFrac) ? { noiseSigmaFrac: c.noiseSigmaFrac } : {}),
      ...(Number.isFinite(c.detectionSnr) ? { detectionSnr: c.detectionSnr } : {}),
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
