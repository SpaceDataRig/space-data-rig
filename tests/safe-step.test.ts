// SAFE-STEP behaviour test -- the retry-exhaustion path that wedged the run mutex in production.
//
// The audit-6 lesson applies verbatim: "the only path that ever broke was the only path with no test."
// workflow.ts imports the WorkflowEntrypoint VALUE from cloudflare:workers, so the Node runner cannot load it,
// and the inline runSafe it used to define put its try/catch INSIDE the step.do callback. That caught an error
// THROWN by the seat, but NOT a step the runtime TERMINATED (CPU/wall budget) and then gave up on: after the
// retries ran out, step.do itself REJECTED, that rejection escaped runSafe, escaped the per-target loop (which
// has no surrounding try/catch), and rejected run() before its finish tail -- so finishRun never ran and the
// slot stayed claimed until the 30-minute STALE_RUN_MS takeover. Observed live: a heavy scout step on a
// wide-period, high-point target was terminated and retried on a growing backoff for the whole window, every
// run was released ONLY by "Releasing stale run ...", and the survey fell to two passes an hour.
//
// runSafe now lives in src/cf/safe-step.ts with only a TYPE import, so THIS test drives the real wrapper with a
// mock step and pins all three outcomes plus the bounded retry policy that makes a deterministic wedge give up
// in about a minute instead of thirty. These are behavioural assertions (feed a mock, check the outcome), not
// a source-string grep -- a grep would only prove the catch exists, not that a rejection is actually absorbed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSafe,
  STEP_RETRY_LIMIT,
  STEP_RETRY_DELAY,
  STEP_RETRY_BACKOFF,
  STEP_TIMEOUT,
} from "../src/cf/safe-step.ts";

// Derived from runSafe's own signature so this test never has to import the cloudflare:workers type directly.
type Step = Parameters<typeof runSafe>[0];
type DoConfig = { retries?: { limit?: number; delay?: unknown; backoff?: unknown }; timeout?: unknown };
type Seen = { name?: string; config?: DoConfig };

// A mock WorkflowStep. `mode` decides how `do` behaves; the name + config it was handed are captured so the
// retry policy can be asserted. "reject" simulates the runtime terminating the step and exhausting its retries
// -- step.do itself throws, which is exactly what the OLD inline wrapper let escape.
function mockStep(mode: "resolve" | "reject", seen: Seen): Step {
  return {
    async do(name: string, config: DoConfig, cb: () => Promise<unknown>) {
      seen.name = name;
      seen.config = config;
      if (mode === "reject") throw new Error("worker exceeded CPU time limit; retries exhausted");
      return await cb();
    },
  } as unknown as Step;
}

test("a step that completes returns its value as ok:true", async () => {
  const seen: Seen = {};
  const r = await runSafe(mockStep("resolve", seen), "scout-3", async () => ({ snr: 12.5 }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.snr, 12.5);
  assert.equal(seen.name, "scout-3");
});

test("an error thrown INSIDE the callback is caught and returned as ok:false (the step still 'succeeded')", async () => {
  const seen: Seen = {};
  const r = await runSafe(mockStep("resolve", seen), "critic-1", async (): Promise<number> => {
    throw new Error("missing detection");
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /missing detection/);
});

test("a step.do REJECTION (runtime termination, retries exhausted) is absorbed as ok:false, never thrown", async () => {
  // THE regression guard for the production wedge: the old wrapper let this rejection escape and kill run()
  // before its finish tail, stranding the run mutex for 30 minutes.
  const seen: Seen = {};
  const r = await runSafe(mockStep("reject", seen), "scout-7", async () => ({ snr: 1 }));
  assert.equal(r.ok, false, "a terminated step must degrade to ok:false, not throw");
  if (!r.ok) assert.match(r.error, /terminated|CPU time limit/i);
});

test("runSafe RESOLVES on a rejecting step, so one wedged target cannot abort the run body", async () => {
  // The promise must settle (not reject): a caller's loop then marks this ONE target failed and CONTINUES to
  // the next target and on to the finish tail that releases the mutex -- instead of the whole run throwing.
  const seen: Seen = {};
  let threw = false;
  let resolved: { ok: boolean } | undefined;
  try {
    resolved = await runSafe(mockStep("reject", seen), "sim-2", async () => 1);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "runSafe must not propagate the rejection out of the wrapper");
  assert.equal(resolved?.ok, false);
});

test("the retry policy is BOUNDED so a deterministic wedge gives up fast instead of burning the stale window", async () => {
  // Pinning the config is the whole point: a silent revert to an unlimited/default retry would reintroduce the
  // 30-minute wedge, and no other assertion would notice because the wrapper still returns ok:false eventually.
  const seen: Seen = {};
  await runSafe(mockStep("resolve", seen), "fetch-0", async () => 1);
  const cfg = seen.config ?? {};
  assert.equal(cfg.retries?.limit, STEP_RETRY_LIMIT);
  assert.equal(cfg.retries?.delay, STEP_RETRY_DELAY);
  assert.equal(cfg.retries?.backoff, STEP_RETRY_BACKOFF);
  assert.equal(cfg.timeout, STEP_TIMEOUT);
  assert.ok(STEP_RETRY_LIMIT <= 3, "retry limit must stay small enough to give up in about a minute, not thirty");
});
