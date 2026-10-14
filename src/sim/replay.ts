// DETERMINISTIC REPLAY RECORD (validation roadmap, priority 6).
//
// The auditability question (roadmap problem 3: verification scale + independent audit) is: can a third
// party, given only the public inputs and this code, reproduce EXACTLY the number we anchored? The bundle
// hash already proves a STORED bundle was not tampered with; this module proves the stronger, forward-
// useful property -- that the DETECTION CHAIN itself is a pure function of its inputs. We build a replay
// record from ONLY the deterministic ingredients (a canonical hash of the parsed light curve, the code
// version, the algorithm + its numeric parameters, and the recovered candidate numbers) -- deliberately
// NO timestamps, run ids, or narration, which are the non-reproducible fields -- and hash it canonically.
//
// If replaying the same raw bytes through the same code yields the same replay hash every time, then an
// auditor who has the bytes + this record can recompute the candidate and the hash independently and
// confirm we did not cherry-pick or hand-edit the result. scripts/p50-replay.ts runs this end-to-end on
// REAL public S3 bytes and reports the determinism. Pure + offline; not imported by the runtime pipeline;
// no verdict/bundle hash/money path change.

import { canonicalJson, sha256Hex } from "../bundle/bundle.ts";

export const REPLAY_SCHEMA = "space-data-rig/replay@1";

export interface ReplayCandidate {
  periodDays: number;
  epochBjd: number;
  durationHours: number;
  depthFrac: number;
  snr: number;
  verdict: string;
}

export interface ReplayInput {
  /** canonical hash over the parsed light curve (seats.computeDataHash) -- the input fingerprint. */
  dataHash: string;
  codeVersion: string;
  /** detector name, e.g. "iterativeBls". */
  algorithm: string;
  /** the numeric/string parameters that fully determine the run (seed included). */
  params: Record<string, number | string>;
  candidate: ReplayCandidate;
}

export interface ReplayRecord {
  schema: typeof REPLAY_SCHEMA;
  dataHash: string;
  codeVersion: string;
  algorithm: string;
  params: Record<string, number | string>;
  candidate: ReplayCandidate;
}

/**
 * Assemble the canonical, deterministic-only replay record. Any non-reproducible field (timestamp, runId,
 * narration) is intentionally excluded, so two runs over identical inputs build identical records.
 */
export function buildReplayRecord(input: ReplayInput): ReplayRecord {
  return {
    schema: REPLAY_SCHEMA,
    dataHash: input.dataHash,
    codeVersion: input.codeVersion,
    algorithm: input.algorithm,
    params: { ...input.params },
    candidate: { ...input.candidate },
  };
}

/** SHA-256 over the canonical (key-sorted) replay record. Stable across key order and machines. */
export function replayHash(record: ReplayRecord): Promise<string> {
  return sha256Hex(canonicalJson(record));
}

/** Recompute the record's hash and compare to an expected value (independent recompute / audit). */
export async function verifyReplay(record: ReplayRecord, expectedHash: string): Promise<boolean> {
  return (await replayHash(record)) === expectedHash;
}

// ---- self-contained, third-party-verifiable replay manifest (roadmap priority 5) ---------
//
// P50 PROVED the chain is deterministic. This turns that proof into a PUBLISHED AUDIT ARTIFACT: a
// single JSON file that lets anyone recompute our anchored number WITHOUT reading our code -- they
// fetch the named public S3 object, check its SHA-256, run the documented detector + params, and
// compare the replay hash. The manifest carries the retrieval recipe, the deterministic record, its
// hash, and the verification steps. It adds no capability and gates nothing; it is pure provenance.

export const REPLAY_MANIFEST_SCHEMA = "space-data-rig/replay-manifest@1";

export interface ReplayRetrieval {
  /** public, anonymous S3 bucket (no token, no AWS account). */
  bucket: string;
  /** object key within the bucket. */
  key: string;
  /** full anonymous HTTPS URL to fetch the raw bytes. */
  url: string;
  /** SHA-256 the fetched bytes must match before replaying (proves the SAME input). */
  expectedByteSha256: string;
  byteLength: number;
}

export interface ReplayManifest {
  schema: typeof REPLAY_MANIFEST_SCHEMA;
  target: { name: string; tic: number; sector: number };
  retrieval: ReplayRetrieval;
  record: ReplayRecord;
  /** SHA-256 over the canonical record; recomputable from `record` alone. */
  replayHash: string;
  /** ordered, code-free instructions an auditor can follow. */
  verifySteps: string[];
  discoveryClaim: false;
}

/** Assemble a self-contained manifest from a retrieval recipe + a deterministic replay record. */
export async function buildReplayManifest(
  target: { name: string; tic: number; sector: number },
  retrieval: Omit<ReplayRetrieval, "url"> & { url?: string },
  record: ReplayRecord,
): Promise<ReplayManifest> {
  const url = retrieval.url ?? `https://${retrieval.bucket}.s3.amazonaws.com/${retrieval.key}`;
  const hash = await replayHash(record);
  return {
    schema: REPLAY_MANIFEST_SCHEMA,
    target,
    retrieval: { bucket: retrieval.bucket, key: retrieval.key, url, expectedByteSha256: retrieval.expectedByteSha256, byteLength: retrieval.byteLength },
    record,
    replayHash: hash,
    verifySteps: [
      `1. GET ${url} (anonymous; no token).`,
      `2. sha256 the bytes; it must equal ${retrieval.expectedByteSha256} (proves the same input).`,
      `3. Parse the FITS light curve and compute the canonical data hash; it must equal ${record.dataHash}.`,
      `4. Run ${record.algorithm} with params ${canonicalJson(record.params)} to recover the candidate.`,
      `5. Canonical-JSON-encode this manifest's "record" (key-sorted) and sha256 it; it must equal the replayHash field ${hash}.`,
    ],
    discoveryClaim: false,
  };
}

/** Recompute the record hash from the manifest and confirm it matches the stated replayHash. */
export async function verifyManifest(manifest: ReplayManifest): Promise<boolean> {
  return (await replayHash(manifest.record)) === manifest.replayHash;
}
