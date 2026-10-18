/**
 * THE DEPLOY-WINDOW DECISION, as a pure function -- when is it safe to upload new code onto a rig that is
 * autonomously surveying on a cron.
 *
 * WHY THIS EXISTS. The standing belief in the plan was that a survey pass takes ~45 minutes and leaves only a few
 * seconds of idle gap, so a deploy had to be sneaked into a narrow hole. Measured against production on 2026-10-18
 * that is simply not the regime: the cron fires every 15 minutes (wrangler.toml `crons`), the last completed pass ran 14:15:18 ->
 * 14:20:22 (304 s), and clustering the real finding timestamps over the retained catalog gives pass spans of 215-307 s
 * for the full 8-target passes. So the survey occupies roughly a fifth of each quarter-hour slot, and most of the
 * time there IS a window. An unmeasured belief is worse than no belief: it makes every deploy feel like a gamble, so
 * people deploy inside a live run or wait for a mythical narrow hole and ship stale code longer. This module turns
 * the question into a checkable verdict computed from live bytes, not from memory.
 *
 * WHAT "SAFE" MEANS HERE, stated so it can be contested. Uploading while a run is in flight is the risk this rig has
 * already been burned by (the 75-minute dirty-tree deploy in src/deploy/deployGuard.ts): a pass that starts on the old
 * version and finishes on the new one produces records narrated by two renderers, and /health.gitSha can only name one
 * of them. So the rule is:
 *   - GO only when NO run is currently claimed-and-live, AND the time left before the next cron claim is at least the
 *     upload budget (default 120 s), so the upload + secret write land entirely inside the idle gap.
 *   - A claim older than STALE_RUN_MS is NOT live -- the same threshold the Durable Object itself uses to take a slot
 *     over (src/cf/run-mutex.ts::isStaleClaim, imported rather than re-implemented, so the two can never disagree).
 *   - An unreadable state is UNKNOWN, never an optimistic GO -- the p8 live-probe NET/FAIL split, applied to deploys.
 *
 * Deterministic and network-free so CI can pin it; the fetching lives in scripts/deploy-window.ts.
 */

import { STALE_RUN_MS, isStaleClaim } from "../cf/run-mutex.ts";

/** The rig's claimed-run bookkeeping, as /api/state publishes it. */
export interface ActiveRunState {
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  running: boolean;
}

export interface WindowPolicy {
  /** Cron period in seconds (the every-15-minute cron => 900). */
  cronEverySec: number;
  /** Seconds the upload + GIT_SHA secret write is expected to need; the gap must exceed this. */
  uploadBudgetSec: number;
  /** Findings further apart than this (seconds) belong to different passes when clustering history. */
  clusterGapSec: number;
}

export const DEFAULT_WINDOW_POLICY: WindowPolicy = { cronEverySec: 900, uploadBudgetSec: 120, clusterGapSec: 90 };

export type WindowVerdict = {
  state: "GO" | "WAIT" | "UNKNOWN";
  reason: string;
  /** Epoch ms of the next cron claim boundary, null when not computable. */
  nextClaimAtMs: number | null;
  /** Idle seconds still available before that boundary, null when not computable. */
  usableSec: number | null;
};

/** The next cron boundary at or after `nowMs`. Cloudflare crons fire on wall-clock multiples of the period within the hour. */
export function nextClaimAt(nowMs: number, cronEverySec: number): number | null {
  if (!Number.isFinite(nowMs) || !Number.isFinite(cronEverySec) || cronEverySec <= 0) return null;
  const periodMs = cronEverySec * 1000;
  const withinHour = nowMs % 3_600_000;
  const nextBoundary = Math.ceil(withinHour / periodMs) * periodMs;
  // A boundary exactly at the moment of asking is already gone; take the following one so the gap is not negative.
  const candidate = nowMs - withinHour + (nextBoundary === withinHour ? nextBoundary + periodMs : nextBoundary);
  return candidate;
}

/**
 * Is a claimed run LIVE right now? Delegates the staleness threshold to the DO's own rule so a slot the DO would
 * take over is never counted here as a busy rig (and a slot the DO would refuse is never counted as free).
 */
export function runIsLive(active: ActiveRunState, nowMs: number): boolean {
  if (!active.running) return false;
  if (!active.startedAt) return true; // running with no start time: assume live, the conservative reading
  return !isStaleClaim(active.startedAt, nowMs);
}

/**
 * The verdict. `active` may be null/undefined when the payload shape changed -- that is UNKNOWN, not GO: the whole
 * point is to never deploy on an optimistic guess about whether the survey is mid-pass.
 */
export function judgeWindow(
  active: ActiveRunState | null | undefined,
  nowMs: number,
  policy: WindowPolicy = DEFAULT_WINDOW_POLICY,
): WindowVerdict {
  if (active == null) {
    return { state: "UNKNOWN", reason: "no activeRun in the state payload, so whether a pass is in flight is unknown -- not deploying on a guess", nextClaimAtMs: null, usableSec: null };
  }
  const next = nextClaimAt(nowMs, policy.cronEverySec);
  const usable = next == null ? null : Math.round((next - nowMs) / 1000);

  if (runIsLive(active, nowMs)) {
    const started = active.startedAt ? new Date(active.startedAt).toISOString() : "unknown start";
    return {
      state: "WAIT",
      reason: `run ${active.runId ?? "?"} is live (claimed ${started}); uploading now would split one pass across two versions`,
      nextClaimAtMs: next,
      usableSec: null,
    };
  }
  if (usable == null) {
    return { state: "UNKNOWN", reason: "could not compute the next cron boundary", nextClaimAtMs: null, usableSec: null };
  }
  if (usable < policy.uploadBudgetSec) {
    return {
      state: "WAIT",
      reason: `idle but only ${usable}s until the next cron claim, under the ${policy.uploadBudgetSec}s upload budget; the window would open mid-write`,
      nextClaimAtMs: next,
      usableSec: usable,
    };
  }
  const finished = active.finishedAt ? `, previous pass finished ${new Date(active.finishedAt).toISOString()}` : "";
  return {
    state: "GO",
    reason: `no live claim${finished} and ${usable}s of idle before the next claim, over the ${policy.uploadBudgetSec}s budget`,
    nextClaimAtMs: next,
    usableSec: usable,
  };
}

/** A measured pass: when it started, when it ended, how many rows it wrote. */
export interface PassSpan {
  startMs: number;
  endMs: number;
  spanSec: number;
  rows: number;
}

/**
 * Cluster recorded finding timestamps into passes. Two rows more than `clusterGapSec` apart are different passes:
 * within a pass the pipeline writes targets back to back, between passes the cron idles. This is the measurement
 * that replaces the "about 45 minutes" belief with numbers, and it degrades honestly -- fewer than two rows yields
 * no spans rather than an invented one.
 */
export function measurePassSpans(createdAts: number[], policy: WindowPolicy = DEFAULT_WINDOW_POLICY): { spans: PassSpan[]; idleGapsSec: number[] } {
  const ts = createdAts.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (ts.length < 2) return { spans: [], idleGapsSec: [] };
  const groups: number[][] = [[ts[0]]];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - groups[groups.length - 1][groups[groups.length - 1].length - 1] > policy.clusterGapSec * 1000) groups.push([ts[i]]);
    else groups[groups.length - 1].push(ts[i]);
  }
  const spans: PassSpan[] = groups.map((g) => ({
    startMs: g[0],
    endMs: g[g.length - 1],
    spanSec: Math.round((g[g.length - 1] - g[0]) / 1000),
    rows: g.length,
  }));
  const idleGapsSec: number[] = [];
  for (let i = 1; i < spans.length; i++) idleGapsSec.push(Math.round((spans[i].startMs - spans[i - 1].endMs) / 1000));
  return { spans, idleGapsSec };
}

/** Median of a number list, null when empty -- used to quote one honest central number for pass duration. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/** The stale threshold this module inherits, re-exported so a test can assert it is the DO's and not a local copy. */
export const WINDOW_STALE_MS = STALE_RUN_MS;
