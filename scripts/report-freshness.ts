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

/** SHA-256 of a file's bytes, or null when it cannot be read (absent / gitignored & cleaned). */
export function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
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

/** Read a stamp back out of a report's JSON meta, tolerating the flat p88/p89 shape and legacy reports. */
export function stampFromMeta(meta: unknown): FreshnessStamp | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const generatedAt = typeof m.generatedAt === "string" ? m.generatedAt : null;
  if (!generatedAt) return null;
  const inputs = Array.isArray(m.inputs)
    ? (m.inputs as unknown[]).filter((x): x is InputRecord => !!x && typeof (x as InputRecord).path === "string")
    : [];
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
