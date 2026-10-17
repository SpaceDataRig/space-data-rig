// RUN-MUTEX behaviour test -- the stateful path that froze the survey for 22 hours (audit-6 #4).
//
// The audit's sharpest structural point: "the only path that ever broke was the only path with no test."
// RigStateDO imports `cloudflare:workers`, so it cannot be loaded by the Node runner -- and indeed
// `grep startRunIfIdle tests/` and `grep rig-state tests/` both returned zero hits while CI stayed green
// through the freeze. The fix was to move the claim/advance/finish DECISIONS into src/cf/run-mutex.ts,
// which the DO's startRunIfIdle / advanceSurveyPass / finishRun now call. THIS test drives those very
// functions, so it asserts the production behaviour, not a copy -- the three ingredients of the incident:
//   (1) a rotation claim ADVANCES the cursor at the claim (so a hung pass still consumed a pass);
//   (2) the same runId is IDEMPOTENT (a DO eviction + tail replay cannot double-count), and a live claim
//       is refused with 409 rather than re-advancing;
//   (3) a ZOMBIE finish cannot release a successor's slot after a stale takeover.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideStart,
  decideFinish,
  decideAdvance,
  isStaleClaim,
  STALE_RUN_MS,
  type MutexState,
} from "../src/cf/run-mutex.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const deps = { makeRunId: () => "made-run-id", now: () => NOW };
const idle = (over: Partial<MutexState> = {}): MutexState => ({ activeRun: null, surveyPass: 0, lastPassRun: null, runId: null, ...over });

// ---- (1) the claim advances the cursor exactly once ----

test("a rotation claim advances the survey cursor at the claim, not in the tail", () => {
  const d = decideStart(idle({ surveyPass: 3, lastPassRun: "run-2" }), { runId: "run-4", rotation: true }, deps);
  assert.equal(d.ok, true);
  assert.equal(d.cursorAdvanced, true);
  assert.equal(d.surveyPass, 4);
  assert.equal(d.lastPassRun, "run-4");
  assert.equal(d.activeRun.running, true);
});

test("a manual (non-rotation) claim never moves the cursor", () => {
  const d = decideStart(idle({ surveyPass: 7, lastPassRun: "run-x" }), { runId: "run-9", rotation: false }, deps);
  assert.equal(d.ok, true);
  assert.equal(d.cursorAdvanced, false);
  assert.equal(d.surveyPass, 7);
  assert.equal(d.lastPassRun, "run-x");
});

// ---- (2) idempotency: same runId twice, and a live claim is refused ----

test("decideAdvance is idempotent for a runId already advanced (DO-replay safe)", () => {
  const first = decideAdvance({ surveyPass: 5, lastPassRun: "run-5" }, "run-6");
  assert.deepEqual(first, { surveyPass: 6, lastPassRun: "run-6", changed: true });
  const replay = decideAdvance({ surveyPass: 6, lastPassRun: "run-6" }, "run-6"); // tail replays same runId
  assert.deepEqual(replay, { surveyPass: 6, lastPassRun: "run-6", changed: false });
});

test("re-claiming the SAME rotation runId does not double-count the pass", () => {
  // The exact freeze-scenario guard: after the claim advanced for run-7, a second claim for run-7 (replay)
  // must leave the cursor where it is.
  const state = idle({ surveyPass: 8, lastPassRun: "run-7" });
  const d = decideStart(state, { runId: "run-7", rotation: true }, deps);
  assert.equal(d.cursorAdvanced, false);
  assert.equal(d.surveyPass, 8);
});

test("a live (non-stale) running claim is refused 409 and does NOT touch the cursor", () => {
  const state = idle({ activeRun: { runId: "run-live", startedAt: new Date(NOW - 60_000).toISOString(), running: true }, surveyPass: 2, lastPassRun: "run-2" });
  const d = decideStart(state, { runId: "run-new", rotation: true }, deps);
  assert.equal(d.ok, false);
  assert.equal(d.code, 409);
  assert.equal(d.runId, "run-live"); // reports the incumbent, not the challenger
  assert.equal(d.cursorAdvanced, false);
  assert.equal(d.surveyPass, 2);
});

// ---- (3) stale takeover + zombie finish cannot release a successor's slot ----

test("a claim older than 30 minutes is stale and is taken over", () => {
  assert.equal(isStaleClaim(new Date(NOW - STALE_RUN_MS - 1000).toISOString(), NOW), true);
  assert.equal(isStaleClaim(new Date(NOW - 60_000).toISOString(), NOW), false);
  assert.equal(isStaleClaim("not-a-date", NOW), true); // unparseable start -> treated as abandoned
  const state = idle({ activeRun: { runId: "run-zombie", startedAt: new Date(NOW - STALE_RUN_MS - 60_000).toISOString(), running: true } });
  const d = decideStart(state, { runId: "run-successor", rotation: true }, deps);
  assert.equal(d.ok, true);
  assert.equal(d.releasedStaleRunId, "run-zombie");
  assert.equal(d.runId, "run-successor");
});

test("a zombie finish (old runId) is IGNORED and leaves the successor running", () => {
  const state = idle({ activeRun: { runId: "run-successor", startedAt: new Date(NOW).toISOString(), running: true } });
  const d = decideFinish(state, { runId: "run-zombie", error: "abandoned" }, deps);
  assert.equal(d.ignore, true);
  assert.equal(d.activeRun.runId, "run-successor");
  assert.equal(d.activeRun.running, true); // the live slot is NOT released
});

test("a run finishing its OWN slot releases it (running=false, finishedAt set)", () => {
  const state = idle({ activeRun: { runId: "run-me", startedAt: new Date(NOW - 30_000).toISOString(), running: true } });
  const d = decideFinish(state, { runId: "run-me", summary: { targets: 3 } as never }, deps);
  assert.equal(d.ignore, false);
  assert.equal(d.activeRun.runId, "run-me");
  assert.equal(d.activeRun.running, false);
  assert.equal(d.activeRun.finishedAt, new Date(NOW).toISOString());
  assert.equal(d.activeRun.startedAt, new Date(NOW - 30_000).toISOString()); // start time preserved, not overwritten
});

test("resume reuses the persisted runId meta (not a fresh id)", () => {
  const state = idle({ runId: "run-persisted" });
  const d = decideStart(state, { runId: "run-offered", resume: true }, deps);
  assert.equal(d.runId, "run-persisted");
});
