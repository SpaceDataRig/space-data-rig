// audit-14 N3: the named-observation money path had an intra-flight race -- the burn-signature replay guard is
// checked many awaits BEFORE it is written, so two concurrent same-signature commissions could BOTH pass and BOTH
// anchor, paying SOL twice. The fix routes both runtimes through a per-signature serialiser. These are BEHAVIOUR
// tests on the algorithm (not a string-match of a handler), driving REAL concurrency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { serializeByKey } from "../src/core/inFlightLock.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tick = () => new Promise((r) => setTimeout(r, 5));

test("serializeByKey: two concurrent same-key calls run SERIALLY, never interleaved", async () => {
  const tail = new Map<string, Promise<void>>();
  const order: string[] = [];
  const call = (tag: string) =>
    serializeByKey(tail, "burn1", async () => {
      order.push(`start-${tag}`);
      await tick();
      order.push(`end-${tag}`);
      return tag;
    });
  const [a, b] = await Promise.all([call("A"), call("B")]);
  assert.deepEqual(order, ["start-A", "end-A", "start-B", "end-B"], "the second call must not begin until the first finishes");
  assert.deepEqual([a, b], ["A", "B"], "each caller gets its OWN result (chain-and-rerun, not shared)");
});

test("serializeByKey: a concurrent duplicate re-runs and sees the first's side effect -- exactly ONE spend", async () => {
  const tail = new Map<string, Promise<void>>();
  const spent = new Set<string>();
  let spends = 0;
  // model the critical section: read the guard, and only spend if the burn is not yet used, then write the guard.
  const commission = (who: string) =>
    serializeByKey(tail, "SIG-XYZ", async () => {
      await tick();
      if (spent.has("SIG-XYZ")) return { who, outcome: "already-used" as const };
      spends += 1;
      spent.add("SIG-XYZ");
      await tick();
      return { who, outcome: "commissioned" as const };
    });
  const results = await Promise.all([commission("first"), commission("second")]);
  assert.equal(spends, 1, "the serialiser must prevent the double SOL spend this bug allowed");
  assert.deepEqual(results.map((r) => r.outcome), ["commissioned", "already-used"], "the duplicate honestly reports the burn was already used");
});

test("serializeByKey: distinct keys do NOT block one another", async () => {
  const tail = new Map<string, Promise<void>>();
  const active = new Set<string>();
  let maxParallel = 0;
  const run = (key: string) =>
    serializeByKey(tail, key, async () => {
      active.add(key);
      maxParallel = Math.max(maxParallel, active.size);
      await tick();
      active.delete(key);
    });
  await Promise.all([run("k1"), run("k2"), run("k3")]);
  assert.equal(maxParallel, 3, "different burn signatures must proceed in parallel");
});

test("serializeByKey: a rejected call releases the key so the lane is never wedged", async () => {
  const tail = new Map<string, Promise<void>>();
  await assert.rejects(serializeByKey(tail, "bad", async () => { await tick(); throw new Error("anchor failed"); }), /anchor failed/);
  assert.equal(tail.size, 0, "the key is cleared even on rejection");
  const ok = await serializeByKey(tail, "bad", async () => "recovered");
  assert.equal(ok, "recovered", "a later same-key call runs normally after a prior failure");
});

// ---- wiring: BOTH money runtimes must actually route commissions through a per-signature lock ----

test("server.ts commissions under serializeByKey keyed by the burn signature (Node parity)", () => {
  const SRC = readFileSync(resolve(root, "src", "api", "server.ts"), "utf8");
  assert.match(SRC, /return await serializeByKey\(commissionTail, burnSig, async \(\) => \{/, "the spend-critical section must run inside the per-signature serialiser");
  assert.match(SRC, /const commissionTail = new Map<string, Promise<void>>\(\);/, "and hold the per-signature tail map it is keyed on");
});

test("rig-state.do.ts commissions under an in-flight lock keyed by the burn signature (edge, mirrors anchorInFlight)", () => {
  const SRC = readFileSync(resolve(root, "src", "cf", "rig-state.do.ts"), "utf8");
  assert.match(SRC, /private readonly commissionInFlight = new Map<string, Promise<ObserveCommissionResult>>\(\);/, "the DO must own a per-signature in-flight map");
  assert.match(SRC, /const inFlight = this\.commissionInFlight\.get\(burnSig\);[\s\S]*?if \(inFlight\) return await inFlight;[\s\S]*?const runCommission = async \(\): Promise<ObserveCommissionResult> => \{/, "a concurrent same-signature call must await the first before the spend section runs");
  assert.match(SRC, /this\.commissionInFlight\.set\(burnSig, p\);[\s\S]*?finally \{[\s\S]*?this\.commissionInFlight\.delete\(burnSig\);/, "the lock must be released in a finally so a failed commission cannot wedge the signature");
});
