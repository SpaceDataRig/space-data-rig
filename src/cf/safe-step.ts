// A Workflow step wrapper that ACTUALLY honours its contract: nothing escapes the step boundary -- not an
// error thrown inside the callback, and not a step the Cloudflare runtime TERMINATED (CPU/wall budget) and
// then gave up on after its retries.
//
// WHY THIS IS A SEPARATE MODULE (the exact precedent of src/cf/run-mutex.ts). workflow.ts imports the
// WorkflowEntrypoint VALUE from "cloudflare:workers", so the Node test runner cannot load it at all -- which
// means the retry-exhaustion path below had ZERO coverage while it was wedging production. The old inline
// runSafe put its try/catch INSIDE the step.do callback, so it caught a thrown error but NOT a step the
// runtime killed: after the retries ran out, step.do itself REJECTED, that rejection escaped runSafe, escaped
// the per-target loop (which has no surrounding try/catch), and rejected run() before it reached its finish
// tail -- so RigStateDO.finishRun was never called and the run slot stayed claimed until the 30-minute
// STALE_RUN_MS takeover. Observed live: a heavy scout step (BLS + up to six sequential SPOC sector fetches in
// ONE step) on a wide-period, high-point target was terminated and retried on a ~26/50/71/111/191s backoff for
// the whole window; every run was released ONLY by "Releasing stale run ...", so the survey ran at two passes
// an hour and each wedged pass also lost the targets queued after the heavy one.
//
// This module imports only the WorkflowStep TYPE (erased at runtime), so tests/safe-step.test.ts drives the
// REAL wrapper with a mock step and pins the three outcomes -- resolve, callback-throws, and step.do-REJECTS --
// plus the bounded retry policy that makes a deterministic wedge give up in ~a minute instead of ~thirty.

import type { WorkflowStep } from "cloudflare:workers";

/** A step outcome wrapper that never throws across the step boundary. */
export type Safe<T> = { ok: true; value: T } | { ok: false; error: string };

// Bounded retry policy. A transient blip still gets a couple of quick retries, but a DETERMINISTICALLY heavy
// step (same input -> same cost -> terminated every time) gives up fast so the caller can mark the ONE target
// failed and the run can continue to its finish tail and release the slot. Exported so the test pins them:
// "give up fast" is the whole point, and a silent bump back to an unlimited default would reintroduce the wedge.
export const STEP_RETRY_LIMIT = 2;
export const STEP_RETRY_DELAY = "5 seconds" as const;
export const STEP_RETRY_BACKOFF = "linear" as const;
// Per-attempt wall-clock ceiling, generous against the ~seconds a normal seat takes (the heaviest, a critic
// significance ensemble or a six-sector depth pass, is tens of seconds), so only a true hang trips it.
export const STEP_TIMEOUT = "2 minutes" as const;

/**
 * Run a durable step whose callback never lets an error escape the boundary -- and whose step.do rejection
 * (a runtime termination with its retries exhausted) is likewise absorbed into { ok: false } rather than
 * propagating out of run() and stranding the run mutex.
 */
export async function runSafe<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  fn: () => Promise<T>,
): Promise<Safe<T>> {
  try {
    return await step.do(
      name,
      {
        retries: { limit: STEP_RETRY_LIMIT, delay: STEP_RETRY_DELAY, backoff: STEP_RETRY_BACKOFF },
        timeout: STEP_TIMEOUT,
      },
      async (): Promise<Safe<T>> => {
        try {
          return { ok: true, value: await fn() };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    );
  } catch (e) {
    // step.do rejected: the runtime terminated the step and its bounded retries are exhausted. Degrade to
    // ok:false so the caller marks this ONE target failed and CONTINUES -- the run still reaches its finish
    // tail and releases the slot, instead of being thrown out before it and held for 30 minutes.
    return { ok: false, error: `step terminated before completing: ${e instanceof Error ? e.message : String(e)}` };
  }
}
