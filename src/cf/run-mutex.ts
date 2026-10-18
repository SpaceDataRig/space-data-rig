// RUN-MUTEX: the stateful claim/advance/finish decisions behind RigStateDO's run slot + rotation cursor.
//
// WHY THIS IS A SEPARATE PURE MODULE. The 22-hour survey freeze (audit-6) lived entirely in this path: a
// rotation run claimed the slot, the cursor was advanced only in the workflow's finish tail, that tail never
// ran for a hung pass, so surveyPass stuck at 1, blind candidates stayed 0, and the feed went quiet -- and
// NOTHING tested it. The DO class imports `cloudflare:workers`, so it cannot be loaded by the Node test
// runner at all: the only path that was ever broken was the only path with zero coverage, and `npm test`
// stayed green while production was frozen. Extracting the decision logic here (exactly the precedent of
// src/survey/rotation.ts, which workflow.ts imports and tests/rotation.test.ts drives) means the DO's
// startRunIfIdle / finishRun are thin adapters over THESE functions, and the offline
// test asserts the REAL production behaviour -- the claim advances the cursor exactly-once, a live claim
// returns 409, a stale claim is taken over, and a zombie finish cannot release a successor's slot.
//
// No Cloudflare APIs, no storage, no clocks passed except via injected deps. discoveryClaim/safeToGate do
// not exist here: this is scheduling bookkeeping, not science.

import type { ActiveRun } from "../core/state-types.ts";

/** A run slot claimed longer than this is treated as abandoned and may be taken over (mirrors the DO). */
export const STALE_RUN_MS = 30 * 60 * 1000;

/** The slice of DO meta these decisions read. The caller persists whatever is returned. */
export interface MutexState {
  activeRun: ActiveRun | null;
  surveyPass: number;
  lastPassRun: string | null;
  runId: string | null;
}

/** The knobs of a launch that affect the claim/advance decision (subset of RunParams). */
export interface StartParams {
  runId?: string;
  resume?: boolean;
  rotation?: boolean;
}

export interface StartDeps {
  makeRunId: () => string;
  now: () => number;
}

export interface StartDecision {
  ok: boolean;
  code?: number; // 409 when a live (non-stale) run already holds the slot
  runId: string;
  activeRun: ActiveRun; // the slot value to persist
  surveyPass: number; // cursor value to persist
  lastPassRun: string | null; // idempotency key to persist
  cursorAdvanced: boolean; // true only when THIS claim consumed a rotation pass
  releasedStaleRunId: string | null; // a stale run we are taking the slot from (caller may log it)
}

export interface FinishParams {
  runId: string;
  summary?: ActiveRun["summary"];
  error?: string;
}

export interface FinishDecision {
  ignore: boolean; // true when the finishing runId is not the live slot (zombie / superseded run)
  activeRun: ActiveRun; // the slot value to persist (unchanged current when ignored)
}

/** A claim with an unparseable or over-30-minute-old start time is considered abandoned. */
export function isStaleClaim(startedAt: string, now: number): boolean {
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || now - started > STALE_RUN_MS;
}

/**
 * Idempotent cursor advance keyed on runId. Its only call site is inside decideStart: the advance happens at
 * the CLAIM, so `changed: false` means a retried claim for a runId that already consumed a pass (a resume
 * reuses the stored runId) and must not double-count. There is deliberately no tail-side advance -- that was
 * the freeze.
 */
export function decideAdvance(
  state: { surveyPass: number; lastPassRun: string | null },
  runId: string,
): { surveyPass: number; lastPassRun: string; changed: boolean } {
  if (state.lastPassRun === runId) return { surveyPass: state.surveyPass, lastPassRun: runId, changed: false };
  return { surveyPass: state.surveyPass + 1, lastPassRun: runId, changed: true };
}

/**
 * Claim the run slot. A live (non-stale) running claim -> 409, unchanged cursor. A stale claim is taken
 * over. On a successful claim the rotation cursor advances IN THIS ATOMIC STEP (not in the workflow tail),
 * so a hung pass that never finishes still consumed exactly one pass -- the fix for the survey freeze.
 * Non-rotation (manual top-N) runs never move the cursor.
 */
export function decideStart(state: MutexState, params: StartParams, deps: StartDeps): StartDecision {
  const current = state.activeRun;
  let releasedStaleRunId: string | null = null;
  if (current?.running) {
    if (!isStaleClaim(current.startedAt, deps.now())) {
      return {
        ok: false, code: 409, runId: current.runId, activeRun: current,
        surveyPass: state.surveyPass, lastPassRun: state.lastPassRun, cursorAdvanced: false, releasedStaleRunId: null,
      };
    }
    releasedStaleRunId = current.runId;
  }
  const runId = params.resume
    ? (state.runId ?? params.runId ?? deps.makeRunId())
    : (params.runId || deps.makeRunId());
  const activeRun: ActiveRun = { runId, startedAt: new Date(deps.now()).toISOString(), running: true };
  if (params.rotation) {
    const adv = decideAdvance(state, runId);
    return { ok: true, runId, activeRun, surveyPass: adv.surveyPass, lastPassRun: adv.lastPassRun, cursorAdvanced: adv.changed, releasedStaleRunId };
  }
  return { ok: true, runId, activeRun, surveyPass: state.surveyPass, lastPassRun: state.lastPassRun, cursorAdvanced: false, releasedStaleRunId };
}

/**
 * Release the slot. A finish whose runId is not the current live run is IGNORED -- after a stale-takeover
 * starts a successor, the abandoned zombie workflow can reach this tail late, and without the guard it
 * would clobber the live successor's slot and re-open the mutex to a concurrent launch.
 */
export function decideFinish(state: MutexState, params: FinishParams, deps: { now: () => number }): FinishDecision {
  const current = state.activeRun;
  if (current && current.runId && current.runId !== params.runId) {
    return { ignore: true, activeRun: current };
  }
  const runId = params.runId || current?.runId || state.runId || "";
  const activeRun: ActiveRun = {
    runId,
    startedAt: current?.startedAt ?? new Date(deps.now()).toISOString(),
    running: false,
    finishedAt: new Date(deps.now()).toISOString(),
    summary: params.summary,
    error: params.error,
  };
  return { ignore: false, activeRun };
}
