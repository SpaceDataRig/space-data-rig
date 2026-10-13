// Offline proof of the load-bearing property behind iterative multi-signal extraction: on a MULTI-planet
// curve a single BLS pass returns ONE period, while iterative mask-and-refind recovers BOTH distinct
// planets -- and on a SINGLE-planet curve it does not invent a second deep signal. Deterministic synthetic
// curves (a flat noisy base with limb-darkened transits multiplied on); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { iterativeBls, inTransitMask, isAliasOf } from "../src/detect/iterative.ts";
import { bls } from "../src/detect/bls.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import type { LightCurve } from "../src/core/types.ts";

const DT = 1800; // 30-min cadence (FFI-like)
const N = 1300; // ~27 d baseline
const T0 = 2458000;

/** A flat star with tiny deterministic noise (~+-300 ppm) so injected transits dominate cleanly. */
function flatBase(seed = 1, n = N): LightCurve {
  let s = seed >>> 0;
  const points = [];
  for (let k = 0; k < n; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const noise = ((((s >>> 8) % 1000) / 1000) - 0.5) * 2 * 300e-6;
    points.push({ time: T0 + (k * DT) / 86400, flux: 1 + noise });
  }
  return { targetId: "FLAT", mission: "synthetic", cadenceSec: DT, points };
}

const close = (a: number, b: number, tolPct = 2) => Math.abs(a - b) / b <= tolPct / 100;

// 1. TWO planets: a single BLS pass reports one period; iterative extraction recovers BOTH distinct planets.
test("iterativeBls recovers both planets of a two-planet system that a single BLS cannot", () => {
  let lc = injectTransitInto(flatBase(11), { seed: 5, periodDays: 3.1, depthFrac: 0.012, t0Bjd: T0 + 1.0 });
  lc = injectTransitInto(lc, { seed: 6, periodDays: 7.3, depthFrac: 0.009, t0Bjd: T0 + 2.0 });

  const iter = iterativeBls(lc, { minPeriodDays: 1, maxPeriodDays: 12 });
  const deep = iter.signals.filter((s) => s.depthPpm >= 5000); // both injected are ~1% = ~10000 ppm
  assert.ok(deep.length >= 2, `expected >=2 deep signals, got ${deep.length} (all: ${iter.signals.map((s) => s.periodDays.toFixed(2)).join(",")})`);
  assert.ok(deep.some((s) => close(s.periodDays, 3.1)), "planet at 3.1 d must be recovered");
  assert.ok(deep.some((s) => close(s.periodDays, 7.3)), "planet at 7.3 d must be recovered");

  // A single pass returns exactly one period, so it can report at most one of the two -- the contrast is the point.
  const single = bls(lc, { minPeriodDays: 1, maxPeriodDays: 12 });
  const singleHits = [3.1, 7.3].filter((p) => close(single.periodDays, p));
  assert.ok(singleHits.length <= 1, "a single BLS run returns one period and cannot report both planets");
});

// 2. ONE planet: iterative extraction must return the planet and NOT invent a second deep signal from noise.
test("iterativeBls on a single-planet curve finds that planet and no second deep signal", () => {
  const lc = injectTransitInto(flatBase(22), { seed: 9, periodDays: 4.2, depthFrac: 0.01, t0Bjd: T0 + 1.5 });
  const iter = iterativeBls(lc, { minPeriodDays: 1, maxPeriodDays: 12 });
  const deep = iter.signals.filter((s) => s.depthPpm >= 5000);
  assert.equal(deep.length, 1, `exactly one deep signal expected, got ${deep.length}`);
  assert.ok(close(deep[0]!.periodDays, 4.2), `recovered ${deep[0]!.periodDays.toFixed(3)} d, expected ~4.2 d`);
});

// 3. inTransitMask masks the transit centre and its immediate neighbours, and leaves out-of-transit cadences.
test("inTransitMask flags only the in-transit cadence window", () => {
  const times = Array.from({ length: 100 }, (_, k) => T0 + k * 0.02); // 28.8-min sampling
  const mask = inTransitMask(times, 2.0, T0 + 1.0, 0.1, 0); // P=2 d, dur=0.1 d, transit centred at k=50
  assert.equal(mask[50], true, "the transit centre must be masked");
  assert.equal(mask[0], false, "a point half a phase away must not be masked");
  assert.equal(mask[20], false, "an out-of-transit cadence must not be masked");
  const n = mask.filter(Boolean).length;
  assert.ok(n >= 3 && n <= 8, `expected ~5 masked cadences (dur/period*N), got ${n}`);
});

// 4. Determinism: the same curve yields identical extracted signals run to run (the money-path guarantee).
test("iterativeBls is deterministic", () => {
  let lc = injectTransitInto(flatBase(33), { seed: 3, periodDays: 2.7, depthFrac: 0.011, t0Bjd: T0 + 0.8 });
  lc = injectTransitInto(lc, { seed: 4, periodDays: 6.1, depthFrac: 0.008, t0Bjd: T0 + 1.7 });
  const a = iterativeBls(lc, { minPeriodDays: 1, maxPeriodDays: 10 });
  const b = iterativeBls(lc, { minPeriodDays: 1, maxPeriodDays: 10 });
  assert.equal(a.signals.length, b.signals.length);
  for (let i = 0; i < a.signals.length; i++) {
    assert.equal(a.signals[i]!.periodDays, b.signals[i]!.periodDays);
    assert.equal(a.signals[i]!.depth, b.signals[i]!.depth);
  }
});

// 5. isAliasOf recognises harmonics/self within tolerance and rejects unrelated periods (the dedup guard).
test("isAliasOf matches harmonics and rejects unrelated periods", () => {
  assert.ok(isAliasOf(3.0, 3.02, 1), "within 1% is the same period");
  assert.ok(isAliasOf(2.0, 4.0, 1), "2 d is the P/2 alias of 4 d");
  assert.ok(isAliasOf(4.0, 2.0, 1), "4 d is the 2P alias of 2 d");
  assert.ok(!isAliasOf(3.1, 7.3, 1), "3.1 d and 7.3 d are unrelated");
  assert.ok(!isAliasOf(0, 5, 1), "a non-positive period is never an alias");
});
