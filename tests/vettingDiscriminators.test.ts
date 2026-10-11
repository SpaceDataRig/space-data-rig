// Tests for the light-curve-only false-positive discriminators. Everything is a hand-built
// deterministic box-folded curve (no network, no PRNG): a symmetric planet vs a half-period
// alias for odd/even depth, and a with/without phase-0.5 secondary for the EB test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { oddEvenDepth, secondaryEclipse } from "../src/detect/vetting.ts";
import type { LightCurve } from "../src/core/types.ts";

/** Build a normalized curve with box dips at each transit center; optional equal secondary. */
function boxCurve(o: {
  period: number; // days
  durationHours: number;
  depth: number; // fractional primary depth
  secondaryDepth?: number; // fractional phase-0.5 dip (EB-like)
  baselineDays: number;
  cadenceDays?: number;
  t0?: number;
}): LightCurve {
  const t0 = o.t0 ?? 2459000;
  const dt = o.cadenceDays ?? 0.02;
  const halfDur = o.durationHours / 24 / 2;
  const points: { time: number; flux: number }[] = [];
  const nMax = Math.floor(o.baselineDays / dt);
  for (let i = 0; i <= nMax; i++) {
    const t = t0 + i * dt;
    let flux = 1;
    const k = Math.round((t - t0) / o.period);
    if (Math.abs(t - (t0 + k * o.period)) <= halfDur) flux -= o.depth; // primary
    const ks = Math.round((t - t0) / o.period - 0.5);
    if (o.secondaryDepth && Math.abs(t - (t0 + (ks + 0.5) * o.period)) <= halfDur) flux -= o.secondaryDepth; // secondary
    points.push({ time: t, flux });
  }
  return { targetId: "BOX", mission: "synthetic", cadenceSec: Math.round(dt * 86400), points, source: "box test" };
}

test("odd/even depth: a symmetric planet has near-zero asymmetry", () => {
  const lc = boxCurve({ period: 5, durationHours: 3, depth: 0.01, baselineDays: 25 });
  const r = oddEvenDepth(lc, 2459000, 5, 3);
  assert.ok(r.determined, "should be determined with 5 transits");
  assert.ok(r.diffFrac < 0.3, `symmetric planet should have small odd/even asymmetry, got ${r.diffFrac.toFixed(2)}`);
});

test("odd/even depth: a half-period alias shows large asymmetry", () => {
  // Real transits every 5 days; fold on 2.5 -> alternate epochs fall in empty space.
  const lc = boxCurve({ period: 5, durationHours: 3, depth: 0.01, baselineDays: 25 });
  const r = oddEvenDepth(lc, 2459000, 2.5, 3);
  assert.ok(r.determined, "should be determined");
  assert.ok(r.diffFrac > 0.5, `half-period alias should be asymmetric, got ${r.diffFrac.toFixed(2)}`);
});

test("secondary eclipse: a planet shows a negligible secondary", () => {
  const lc = boxCurve({ period: 5, durationHours: 3, depth: 0.01, baselineDays: 25 });
  const r = secondaryEclipse(lc, 2459000, 5, 3);
  assert.ok(r.determined, "primary detected");
  assert.ok(r.ratio < 0.2, `planet secondary should be tiny vs primary, got ratio ${r.ratio.toFixed(2)}`);
});

test("secondary eclipse: an EB shows a secondary comparable to the primary", () => {
  const lc = boxCurve({ period: 5, durationHours: 3, depth: 0.01, secondaryDepth: 0.008, baselineDays: 25 });
  const r = secondaryEclipse(lc, 2459000, 5, 3);
  assert.ok(r.determined, "both eclipses detected");
  assert.ok(r.ratio > 0.5, `EB secondary should approach the primary, got ratio ${r.ratio.toFixed(2)}`);
});
