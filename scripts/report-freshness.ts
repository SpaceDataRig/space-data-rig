// REPORT FRESHNESS GATE (audit-6 #2: "fixed but not re-run, re-run but not published" -- the same
// failure class as "computed but not anchored" (round 1) and "deployed but not in effect" (round 4),
// now recurring in the REPORTING domain).
//
// The problem this closes: a research report's numbers can silently go stale. Two real instances the
// auditor hit and could not diagnose from the artifacts alone:
//   (1) The ExoFOP RA unit bug (parseRa returned hours as degrees) put every host in a 0-24 RA band. It
//       was fixed in the source, and the P82 centroid checkpoint (out/scaled/centroid.jsonl) was re-run,
//       but P84/P85 -- which READ that checkpoint -- still carried the OLD, wrong-sky numbers, and NOTHING
//       in the committed report said when it was generated or from which input. There was no way, after the
//       fact, to tell a pre-fix report from a post-fix one.
//   (2) web/reports/ is a hand-run build of reports/*.md; the published P81 page still showed
//       "contradictions (4)" while the repository md had long since been re-run to 0. The public site was
//       serving stale numbers.
//
// The fix, in two halves:
//   A. STAMP on generation: every report script writes, into its JSON meta, `generatedAt` + the repo
//      `gitSha` at generation + `inputs: [{path, sha256}]` for the checkpoints/files its numbers derive
//      from. So each committed report now carries its own provenance.
//   B. VERIFY on publish: scripts/p86-report-library.ts, before it distils reports/*.md into web assets,
//      re-hashes each report's recorded inputs and (for reports that predate stamping) falls back to git
//      provenance. If an input changed after the report was generated, the report is HARD-STALE: p86 marks
//      it red on the site and exits non-zero so the deploy step refuses to publish stale numbers.
//
// This module keeps the DECISION logic pure and dependency-free (compareInputs / isSourceNewer /
// evaluateAgainst) so tests/report-freshness.test.ts can drive the real gate offline with tampered hashes
// and synthetic commit times -- the same "prove the alarm rings" pattern used for the live-probe drill.
// The I/O helpers (git, file hashing) are thin and clearly separated.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface InputRecord {
  path: string;
  /** sha256 of the input at generation time, or null if the file was absent then. */
  sha256: string | null;
}

/** The provenance block stamped into a report's JSON meta by buildStamp(). */
export interface FreshnessStamp {
  generatedAt: string; // ISO-8601, when the report was written
  gitSha: string; // repo HEAD at generation ("" if git unavailable)
  inputs: InputRecord[]; // the checkpoints/files the numbers were derived from
}

/** One input's recorded-vs-current comparison. */
export interface InputState {
  path: string;
  recorded: string | null;
  current: string | null;
}

export type HashFn = (path: string) => string | null;
export type MtimeFn = (path: string) => number | null;
export type GitTimeFn = (path: string) => string | null;

/**
 * CRLF/CR -> LF for text content; binary content returned byte-for-byte untouched.
 *
 * Binary is detected the way git detects it: a NUL byte in the leading 8 KiB. git never EOL-converts a
 * binary file, so its working-tree bytes are already platform-stable and must not be rewritten.
 */
export function normalizeEol(buf: Buffer): Buffer {
  if (buf.subarray(0, 8192).includes(0)) return buf; // binary: leave alone
  if (!buf.includes(13)) return buf; // no CR anywhere: already LF (the common case, avoids the copy)
  // latin1 round-trips every byte 0x00-0xFF to the same code unit, so this is lossless for any content.
  return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "latin1");
}

/**
 * SHA-256 of a file's content WITH LINE ENDINGS NORMALISED, or null when it cannot be read (absent /
 * gitignored & cleaned).
 *
 * WHY NORMALISE (audit-6 follow-up; measured, not assumed). This repo pins `* text=auto eol=lf`, but a
 * Windows checkout with core.autocrlf=true still materialises tracked text files with CRLF bytes, while
 * CI generates the same report from LF bytes. Hashing raw working-tree bytes therefore made a report the
 * CI bot had just published read as HARD-STALE on a Windows machine even though `git show HEAD:<path>` was
 * byte-identical to what the stamp recorded -- a false positive that blocks deploys for a non-reason and
 * trains people to reach for --allow-stale. Measured across every stamped report before this change: the
 * raw-bytes scheme flagged 2 inputs stale (both pure CRLF artifacts of src/data/*.ts), the normalised
 * scheme flagged 0, and every previously recorded stamp -- CI-recorded LF inputs AND locally recorded
 * untracked out/scaled/*.jsonl checkpoints -- still matched, so switching invalidates nothing.
 */
export function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(normalizeEol(readFileSync(path))).digest("hex");
  } catch {
    return null;
  }
}

/** Full HEAD commit SHA (short is not enough to disambiguate across shallow clones), "" on failure. */
export function gitHeadSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Committer ISO date of the newest commit touching `path`, or null if untracked / no history / git error. */
export function gitLastCommitIso(path: string): string | null {
  try {
    const t = execFileSync("git", ["log", "-1", "--format=%cI", "--", path], { encoding: "utf8" }).trim();
    return t || null;
  } catch {
    return null;
  }
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ---- PURE decision logic (no I/O; what the offline test drives) ----

/**
 * Compare each recorded input against its current hash. HARD-STALE iff an input that was present at
 * generation is present now AND its bytes differ -- i.e. the checkpoint the numbers came from has been
 * rewritten since, exactly the "centroid.jsonl re-run but P84 not re-run" case. An input that is simply
 * GONE (gitignored checkpoint cleaned up) is NOT treated as stale: it cannot be verified, so it is noted
 * as a soft reason and left to the git-provenance fallback.
 */
export function compareInputs(states: InputState[]): { hardStale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let hardStale = false;
  for (const s of states) {
    if (!s.recorded) continue; // nothing was recorded for this input at generation time
    if (s.current === null) {
      reasons.push(`input ${s.path} is not present to re-verify`);
      continue;
    }
    if (s.current !== s.recorded) {
      hardStale = true;
      reasons.push(`input ${s.path} changed since this report was generated (sha256 differs)`);
    }
  }
  return { hardStale, reasons };
}

/**
 * Git-provenance rule (used when an input is untracked -- e.g. a gitignored checkpoint -- so its hash is
 * not recorded, or as the only signal for a legacy report that predates stamping). A report is stale when
 * some input became newer than the report itself. `inputNewestMs` is the max modification epoch-ms across
 * the report's declared inputs (git commit time for tracked files, filesystem mtime for untracked ones);
 * `reportMs` is the report's own commit/generation epoch-ms. Missing/invalid inputs never trip the gate.
 */
export function isProvenanceStale(reportMs: number, inputNewestMs: number | null, toleranceMs = 0): boolean {
  if (inputNewestMs === null || !Number.isFinite(reportMs) || !Number.isFinite(inputNewestMs)) return false;
  return inputNewestMs - toleranceMs > reportMs;
}

export interface FreshnessVerdict {
  stamped: boolean; // did the report carry a generatedAt stamp?
  fresh: boolean; // !stale
  stale: boolean;
  reasons: string[];
}

/**
 * The full decision, with I/O injectable for offline testing.
 *
 * BLOCKING is deliberately limited to the one precise, false-positive-free signal: a recorded input whose
 * bytes changed after the report was generated (compareInputs hardStale). Wall-clock / git-commit-time
 * heuristics are NOT used to declare a report stale -- they fire on unrelated later edits to a shared
 * source (a lint fix, a refactor) and were shown to false-positive on real reports, which would block
 * deploys for non-reasons. `opts.reportMs` / `opts.inputNewestMs` are still accepted and reported as a
 * SOFT note (a human hint that a dependency moved), never as a hard-stale verdict. A report with no
 * recorded inputs is left fresh but flagged `stamped:false` so the gap is visible on the site.
 */
export function evaluateAgainst(
  stamp: FreshnessStamp | null,
  opts: {
    reportMs: number;
    inputNewestMs: number | null;
    hash?: HashFn;
    mtime?: MtimeFn;
    toleranceMs?: number;
  },
): FreshnessVerdict {
  const hash = opts.hash ?? sha256File;
  const reasons: string[] = [];
  const stamped = Boolean(stamp && stamp.generatedAt);

  if (stamp && stamp.inputs && stamp.inputs.length) {
    const states: InputState[] = stamp.inputs.map((i) => ({ path: i.path, recorded: i.sha256, current: i.sha256 ? hash(i.path) : null }));
    const cmp = compareInputs(states);
    reasons.push(...cmp.reasons);
    const stale = cmp.hardStale; // ONLY a changed recorded input blocks.
    // A report that NAMES its inputs but records no hash for any of them is not verified -- say so, rather
    // than letting an empty reason list read as "checked and clean" (the p79 hand-written shape).
    if (!stamp.inputs.some((i) => i.sha256)) {
      reasons.push(`report declares ${stamp.inputs.length} input path(s) but records no sha256 for them, so they cannot be re-verified`);
    }
    // Optional soft note: a dependency is newer than the report even though the hashed inputs still match.
    if (!stale && isProvenanceStale(opts.reportMs, opts.inputNewestMs, opts.toleranceMs)) {
      reasons.push("note: a source this report reads is newer than the report itself (informational, not blocking)");
    }
    return { stamped, fresh: !stale, stale, reasons };
  }

  // No recorded input hashes (legacy or network report not yet re-run): never hard-stale, but make the gap
  // visible so it can be prioritised for stamping.
  if (!stamped) reasons.push("report carries no freshness stamp (generatedAt/gitSha/inputs)");
  else reasons.push("report is stamped but records no input checkpoint to re-verify");
  return { stamped, fresh: true, stale: false, reasons };
}

// ---- I/O helpers used by generators and p86 ----

/** Build the provenance block a generator writes into its report meta. */
export function buildStamp(inputPaths: string[]): FreshnessStamp {
  return {
    generatedAt: new Date().toISOString(),
    gitSha: gitHeadSha(),
    inputs: inputPaths.map((p) => ({ path: p, sha256: sha256File(p) })),
  };
}

/**
 * Coerce the `inputs` array of a stamp into InputRecords, accepting BOTH shapes that exist in the wild:
 * `{path, sha256}` objects (what buildStamp writes) and bare path strings (what older hand-written reports
 * such as p79-benchmark.json declared). A bare string becomes `{path, sha256: null}` so the declared
 * dependency stays VISIBLE: dropping it, as the previous strict filter did, made such a report look fully
 * verified when in fact nothing about it could be checked at all.
 */
export function normalizeInputRecords(raw: unknown[]): InputRecord[] {
  const out: InputRecord[] = [];
  for (const x of raw) {
    if (typeof x === "string") {
      if (x) out.push({ path: x, sha256: null });
      continue;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (typeof o.path === "string" && o.path) out.push({ path: o.path, sha256: typeof o.sha256 === "string" ? o.sha256 : null });
    }
  }
  return out;
}

/** Read a stamp back out of a report's JSON meta, tolerating the flat p88/p89 shape and legacy reports. */
export function stampFromMeta(meta: unknown): FreshnessStamp | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const generatedAt = typeof m.generatedAt === "string" ? m.generatedAt : null;
  if (!generatedAt) return null;
  const inputs = Array.isArray(m.inputs) ? normalizeInputRecords(m.inputs) : [];
  return { generatedAt, gitSha: typeof m.gitSha === "string" ? m.gitSha : "", inputs };
}

/** Newest modification epoch-ms across the given inputs: git commit time when tracked, else file mtime. */
export function newestInputMs(paths: string[], gitTime: GitTimeFn = gitLastCommitIso, mtime: MtimeFn = fileMtimeMs): number | null {
  let best: number | null = null;
  for (const p of paths) {
    const gt = gitTime(p);
    const ms = gt ? Date.parse(gt) : mtime(p);
    if (ms != null && Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

/** Epoch-ms of a report's own provenance: its generatedAt when stamped, else its .md git commit time. */
export function reportMs(reportMdPath: string, stamp: FreshnessStamp | null, gitTime: GitTimeFn = gitLastCommitIso): number {
  if (stamp && stamp.generatedAt) {
    const t = Date.parse(stamp.generatedAt);
    if (Number.isFinite(t)) return t;
  }
  const gt = gitTime(reportMdPath);
  return gt ? Date.parse(gt) : Number.NaN;
}
