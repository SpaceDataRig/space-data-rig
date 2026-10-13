// Offline proof of the load-bearing property behind PDM as an INDEPENDENT cross-check of the box-fit family:
// on a curve with a real transit the phase-dispersion statistic theta collapses well below 1 at the true period
// (or a low-order harmonic), on pure noise theta stays ~1, and a deeper transit drives theta lower. Deterministic
// synthetic curves (a flat seeded-noise base with limb-darkened transits multiplied on); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pdm, pdmOnLightCurve } from "../src/detect/pdm.ts";
import { isAliasOf } from "../src/detect/iterative.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import type { LightCurve } from "../src/core/types.ts";

const DT = 1800; // 30-min cadence (FFI-like)
const N = 1300; // ~27 d baseline
const T0 = 2458000;

/** A flat star with tiny deterministic noise (~+-300 ppm) so an injected transit dominates cleanly. */
function flatBase(seed = 1, n = N): LightCurve {
  let s = seed >>> 0;
  const points = [];
  for (let k = 0; k < n; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const noise = (((s >>> 8) % 1000) / 1000 - 0.5) * 2 * 300e-6;
    points.push({ time: T0 + (k * DT) / 86400, flux: 1 + noise });
  }
  return { targetId: "FLAT", mission: "synthetic", cadenceSec: DT, points };
}

const OPTS = { minPeriodDays: 1, maxPeriodDays: 12, bins: 12, oversample: 10 };

// 1. Determinism: the same curve yields an identical theta curve and best period run to run (the money-path guarantee).
test("pdm is deterministic", () => {
  const lc = injectTransitInto(flatBase(11), { seed: 5, periodDays: 3.1, depthFrac: 0.012, t0Bjd: T0 + 1.0 });
  const a = pdmOnLightCurve(lc, OPTS);
  const b = pdmOnLightCurve(lc, OPTS);
  assert.equal(a.periodDays, b.periodDays);
  assert.equal(a.theta, b.theta);
  assert.equal(a.nGrid, b.nGrid);
  assert.ok(a.nGrid > 0, "the trial grid must be populated");
});

// 2. A real injected transit drives theta well below 1 at the true period (or a low-order harmonic).
test("pdm finds an injected transit period and collapses theta below 1", () => {
  const P = 3.1;
  const lc = injectTransitInto(flatBase(22), { seed: 9, periodDays: P, depthFrac: 0.012, t0Bjd: T0 + 1.0 });
  const r = pdmOnLightCurve(lc, OPTS);
  assert.ok(Number.isFinite(r.periodDays), "a finite best period must be returned");
  assert.ok(isAliasOf(r.periodDays, P, 3), `recovered ${r.periodDays.toFixed(3)} d should be ${P} d or a harmonic`);
  assert.ok(r.theta < 0.7, `theta at a real transit must collapse well below 1, got ${r.theta.toFixed(3)}`);
});

// 3. Sensitivity is monotonic in depth: a deeper transit on the same star yields a strictly lower theta minimum.
test("pdm theta minimum drops as the injected transit deepens", () => {
  const deep = pdmOnLightCurve(injectTransitInto(flatBase(33), { seed: 3, periodDays: 4.2, depthFrac: 0.02, t0Bjd: T0 + 1.0 }), OPTS);
  const shallow = pdmOnLightCurve(injectTransitInto(flatBase(33), { seed: 3, periodDays: 4.2, depthFrac: 0.004, t0Bjd: T0 + 1.0 }), OPTS);
  assert.ok(deep.theta < shallow.theta, `deeper transit must lower theta (deep ${deep.theta.toFixed(3)} vs shallow ${shallow.theta.toFixed(3)})`);
});

// 4. Pure noise (no transit) leaves theta ~ 1 and never below the level a real signal reaches -- the discriminating contrast.
test("pdm on pure noise keeps theta near 1, above the transit case", () => {
  const noise = pdmOnLightCurve(flatBase(44), OPTS);
  const signal = pdmOnLightCurve(injectTransitInto(flatBase(44), { seed: 7, periodDays: 3.4, depthFrac: 0.012, t0Bjd: T0 + 1.0 }), OPTS);
  assert.ok(noise.theta > 0.8, `pure noise should leave theta near 1, got ${noise.theta.toFixed(3)}`);
  assert.ok(signal.theta < noise.theta, "a real transit must reach a lower theta than noise on the same star");
});

// 5. Guards: a too-short curve returns no period; constant flux (zero variance) returns theta 1 rather than dividing by zero.
test("pdm guards degenerate inputs", () => {
  const short = pdm([T0, T0 + 0.02, T0 + 0.04], [1, 1, 1], OPTS);
  assert.ok(Number.isNaN(short.periodDays), "fewer than the minimum points yields no period");
  assert.equal(short.nGrid, 0);

  const times = Array.from({ length: 200 }, (_, k) => T0 + k * 0.02);
  const constant = pdm(times, times.map(() => 1), OPTS);
  assert.equal(constant.theta, 1, "constant flux has no variance to disperse; theta is defined as 1");
  assert.ok(Number.isNaN(constant.periodDays), "constant flux yields no meaningful period");
});
