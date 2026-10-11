import assert from "node:assert/strict";
import { oddEvenRefined } from "../src/detect/vetting.ts";
import { generateSyntheticTransit } from "../src/data/synthetic.ts";

// 1. A real planet on its EXACT ephemeris is symmetric: small odd/even asymmetry.
{
  const { lc, truth } = generateSyntheticTransit({ seed: 31, periodDays: 2.0, depthFrac: 0.02, noisePpm: 120, cadenceSec: 300, baselineDays: 24 });
  const u = oddEvenRefined(lc, truth.t0Bjd, truth.periodDays, truth.durationHours);
  assert.ok(u.determined, `exact-ephemeris planet should be determinable (even=${u.nEven} odd=${u.nOdd})`);
  assert.ok(u.diffFrac < 0.25, `real planet should read symmetric, got diffFrac ${u.diffFrac.toFixed(2)}`);
}

// 2. KEY: a real planet judged on a slightly WRONG (drifting) catalog period is still measured
//    event-by-event at each transit's own refined center. The refit counts TRANSITS (a small
//    per-event tally), not folded points, and stays symmetric while the per-event residual exposes
//    the drift -- the property that lets it be calibrated as a gate on real single-sector data.
{
  const { lc, truth } = generateSyntheticTransit({ seed: 32, periodDays: 2.0, depthFrac: 0.02, noisePpm: 120, cadenceSec: 300, baselineDays: 24 });
  const wrongPeriod = truth.periodDays * 1.015; // +1.5% catalog period error -> ~0.33 d drift by the far epochs
  const refined = oddEvenRefined(lc, truth.t0Bjd, wrongPeriod, truth.durationHours);
  assert.ok(refined.determined, "refit should still find transits under moderate drift");
  assert.ok(refined.diffFrac < 0.25, `refit must stay symmetric under drift, got ${refined.diffFrac.toFixed(2)}`);
  const epochs = Math.floor(24 / truth.periodDays);
  assert.ok(refined.nEven + refined.nOdd <= epochs + 1, `refit counts per-event, not per-point (got ${refined.nEven + refined.nOdd} <= ${epochs})`);
  assert.ok(refined.maxResidualDays > 0.05, "drift should be visible in the per-event residual");
}

// 3. Too few transits on one parity -> NOT determined (never a confident asymmetry, so it cannot
//    false-reject a genuine planet observed only a couple times).
{
  const { lc, truth } = generateSyntheticTransit({ seed: 33, periodDays: 5.0, depthFrac: 0.02, noisePpm: 120, cadenceSec: 300, baselineDays: 12 });
  const u = oddEvenRefined(lc, truth.t0Bjd, truth.periodDays, truth.durationHours);
  assert.ok(!u.determined || (u.nEven >= 2 && u.nOdd >= 2), "short coverage must not claim a confident asymmetry");
}

// 4. Determinism.
{
  const { lc, truth } = generateSyntheticTransit({ seed: 34, periodDays: 2.0, depthFrac: 0.015, noisePpm: 150, cadenceSec: 300, baselineDays: 20 });
  const a = oddEvenRefined(lc, truth.t0Bjd, truth.periodDays, truth.durationHours);
  const b = oddEvenRefined(lc, truth.t0Bjd, truth.periodDays, truth.durationHours);
  assert.deepEqual(a, b);
}

console.log("oddEvenRefined.test.ts OK");
