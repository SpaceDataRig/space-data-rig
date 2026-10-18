// DEPLOY-WINDOW behaviour + measurement test (audit-7 h3).
//
// The plan asserted "a survey pass takes ~45 minutes, the gap is only seconds". Measured against production that is
// false: the cron fires every 15 minutes and a full 8-target pass writes over ~215-307 s, so most of the quarter-hour
// is idle. An unmeasured cadence belief makes every deploy feel like a gamble, and people resolve that gamble badly
// in two ways -- uploading inside a live pass (the failure src/deploy/deployGuard.ts exists for: one pass narrated by
// two renderers while /health.gitSha can name only one), or waiting for a mythical narrow hole and shipping stale code
// longer. This pins the pure rule (src/deploy/deployWindow.ts) and the measured clustering, so the advice a script
// prints is the same rule CI checks, and so the ~45-minute claim cannot quietly return.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { STALE_RUN_MS } from "../src/cf/run-mutex.ts";
import {
  DEFAULT_WINDOW_POLICY,
  WINDOW_STALE_MS,
  judgeWindow,
  measurePassSpans,
  median,
  nextClaimAt,
  runIsLive,
  type ActiveRunState,
} from "../src/deploy/deployWindow.ts";

const HERE = resolve(process.cwd());
const read = (...p: string[]) => readFileSync(resolve(HERE, ...p), "utf8");

/** A claimed run at a known instant; `claimedMinAgo` positions it against the 30-minute stale line. */
function runAt(claimedMinAgo: number, running: boolean, over: Partial<ActiveRunState> = {}): ActiveRunState {
  const nowMs = Date.UTC(2026, 9, 18, 14, 10, 0); // a :10 wall-clock, 10s-padded, so the next 15-min boundary is :15 (300 s)
  return { runId: "run-x", startedAt: new Date(nowMs - claimedMinAgo * 60_000).toISOString(), finishedAt: null, running, ...over };
}
const AT_1410 = Date.UTC(2026, 9, 18, 14, 10, 0);

// ---- the verdict ---------------------------------------------------------------------------

test("a live claim is WAIT: uploading mid-pass would split one pass across two versions", () => {
  const v = judgeWindow(runAt(1, true), AT_1410);
  assert.equal(v.state, "WAIT");
  assert.match(v.reason, /is live/);
  assert.equal(v.usableSec, null, "a busy rig has no usable gap to report");
});

test("an idle rig with room before the next boundary is GO, and the gap is printed", () => {
  const v = judgeWindow(runAt(1, false, { finishedAt: new Date(AT_1410 - 60_000).toISOString() }), AT_1410);
  assert.equal(v.state, "GO");
  assert.equal(v.usableSec, 300, ":10 to the next :15 boundary is 300 s");
  assert.equal(v.nextClaimAtMs, Date.UTC(2026, 9, 18, 14, 15, 0));
  assert.match(v.reason, /previous pass finished/);
});

test("an idle rig that is about to be re-claimed is WAIT, not a GO that lands mid-write", () => {
  // :14:30 -> the :15 boundary is 30 s away, under the 120 s budget.
  const almost = Date.UTC(2026, 9, 18, 14, 14, 30);
  const v = judgeWindow(runAt(0, false), almost);
  assert.equal(v.state, "WAIT");
  assert.match(v.reason, /under the \d+s upload budget/);
});

test("a stale claim is NOT live -- the DO would hand the slot to a successor, so the window is free", () => {
  // 31 minutes ago, past STALE_RUN_MS, still flagged running: the same reading the Durable Object uses to take over.
  assert.equal(runIsLive(runAt(31, true), AT_1410), false);
  assert.equal(runIsLive(runAt(29, true), AT_1410), true, "29 minutes is still live");
  assert.equal(judgeWindow(runAt(31, true), AT_1410).state, "GO");
});

test("missing state is UNKNOWN, never an optimistic GO -- could-not-look is not safe-to-deploy", () => {
  assert.equal(judgeWindow(null, AT_1410).state, "UNKNOWN");
  assert.equal(judgeWindow(undefined, AT_1410).state, "UNKNOWN");
  // running with no start time is the conservative live reading, not a free pass.
  assert.equal(judgeWindow({ runId: "r", startedAt: null, finishedAt: null, running: true }, AT_1410).state, "WAIT");
});

// ---- the boundary + the measurement --------------------------------------------------------

test("nextClaimAt lands on the following quarter-hour, and rolls past the hour", () => {
  assert.equal(nextClaimAt(Date.UTC(2026, 9, 18, 14, 3, 0), 900), Date.UTC(2026, 9, 18, 14, 15, 0));
  assert.equal(nextClaimAt(Date.UTC(2026, 9, 18, 14, 45, 0), 900), Date.UTC(2026, 9, 18, 15, 0, 0), "exactly on a boundary takes the next one");
  assert.equal(nextClaimAt(Date.UTC(2026, 9, 18, 14, 50, 0), 900), Date.UTC(2026, 9, 18, 15, 0, 0));
  assert.equal(nextClaimAt(Number.NaN, 900), null);
  assert.equal(nextClaimAt(AT_1410, 0), null, "a zero cron period is not a number of anything");
});

test("pass spans are clustered from recorded timestamps, and a thin catalog yields no invented cadence", () => {
  const t = (min: number) => Date.UTC(2026, 9, 18, 12, 0, 0) + min * 60_000;
  const rows = [t(0), t(0.5), t(1), t(20), t(20.5), t(41)];
  const { spans, idleGapsSec } = measurePassSpans(rows, DEFAULT_WINDOW_POLICY);
  assert.equal(spans.length, 3, "three clusters, ~20 minutes apart");
  assert.deepEqual(spans.map((s) => s.rows), [3, 2, 1]);
  assert.equal(spans[0].spanSec, 60);
  assert.ok(idleGapsSec.every((g) => g > 900), "gaps between clustered passes exceed the cron period here");
  // The honesty case: fewer than two rows cannot produce a cadence, and must not fabricate a duration of zero.
  assert.deepEqual(measurePassSpans([], DEFAULT_WINDOW_POLICY).spans, []);
  assert.deepEqual(measurePassSpans([t(0)], DEFAULT_WINDOW_POLICY).spans, []);
  assert.deepEqual(measurePassSpans([Number.NaN, t(0)], DEFAULT_WINDOW_POLICY).spans, [], "unparseable rows drop out, they do not make a pass");
});

test("the stale threshold is the Durable Object's, not a second number someone must keep in sync", () => {
  assert.equal(WINDOW_STALE_MS, STALE_RUN_MS);
});

test("median is the honest central value and degrades to unknown, never to zero", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([2, 4]), 3, "even count averages the middle pair");
  assert.equal(median([]), null);
});

// ---- the call site: the script must USE the rules under test -------------------------------

test("scripts/deploy-window.ts delegates the verdict and the cadence to the tested module", () => {
  const src = read("scripts", "deploy-window.ts");
  assert.match(src, /import \{[^}]*judgeWindow[^}]*\} from "\.\.\/src\/deploy\/deployWindow\.ts"/, "must import the rule, not reimplement it");
  assert.ok(src.includes("judgeWindow(active, nowMs, policy)"), "the verdict is computed by the pure rule");
  assert.ok(src.includes("measurePassSpans("), "cadence is measured by the pure clustering");
  // No local idea of what "live" or "stale" means may appear in the script.
  assert.doesNotMatch(src, /running &&[\s\S]{0,80}(30|1800|stale)/i, "the script must not judge staleness itself");
  assert.match(src, /return verdict\.state === "GO" \? 0 : 1/, "exit 0 only on GO");
  assert.match(src, /return 2/, "unreachable rig is NET (2), never a WAIT verdict about the rig");
});
