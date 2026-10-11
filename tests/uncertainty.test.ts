import assert from "node:assert/strict";
import { bootstrapUncertainty } from "../src/detect/uncertainty.ts";
import { generateSyntheticTransit } from "../src/data/synthetic.ts";
import type { TransitCandidate } from "../src/core/types.ts";

function candFromTruth(t: { periodDays: number; t0Bjd: number; durationHours: number; depthFrac: number }, targetId: string): TransitCandidate {
  return {
    targetId,
    periodDays: t.periodDays,
    epochBjd: t.t0Bjd,
    durationHours: t.durationHours,
    depthPpt: t.depthFrac * 1000,
    depthFrac: t.depthFrac,
    snr: 20,
    power: 1,
    nPointsInTransit: 20,
  };
}

// 1. A strong deep transit yields a tight period interval centered on the true period. (Coarse
//    cadence keeps the curve small so the bootstrap is fast; grid resolution -- not sampling --
//    sets period precision, so the interval is still meaningful.)
{
  const { lc, truth } = generateSyntheticTransit({ seed: 3, periodDays: 2.5, depthFrac: 0.02, noisePpm: 200, cadenceSec: 900, baselineDays: 10 });
  const u = bootstrapUncertainty(lc, candFromTruth(truth, lc.targetId), { bootstraps: 40, seed: 1 });
  assert.ok(u.nBootstrap > 20, `too few bootstrap fits: ${u.nBootstrap}`);
  assert.ok(Number.isFinite(u.periodSigma) && u.periodSigma < 0.05, `deep signal period error should be small, got ${u.periodSigma}`);
  // BLS reports period on a discrete grid, so the CI is grid-quantized and need not strictly bracket
  // truth; the right check is that the interval sits close to the true period and is ordered.
  const mid = (u.periodCI[0] + u.periodCI[1]) / 2;
  assert.ok(Math.abs(mid - truth.periodDays) / truth.periodDays < 0.03, `bootstrap period ${mid} is >3% off truth ${truth.periodDays}`);
  assert.ok(u.periodCI[1] >= u.periodCI[0], "CI must be ordered");
}

// 2. Determinism: same curve + same seed -> identical interval.
{
  const { lc, truth } = generateSyntheticTransit({ seed: 4, periodDays: 3.0, depthFrac: 0.015, noisePpm: 250, cadenceSec: 900, baselineDays: 10 });
  const a = bootstrapUncertainty(lc, candFromTruth(truth, lc.targetId), { bootstraps: 20, seed: 42 });
  const b = bootstrapUncertainty(lc, candFromTruth(truth, lc.targetId), { bootstraps: 20, seed: 42 });
  assert.equal(a.periodSigma, b.periodSigma);
  assert.deepEqual(a.periodCI, b.periodCI);
}

// 3. Monotone with signal strength: a deeper transit has smaller (or equal) period uncertainty than
//    a shallower one in the same noise -- error bars must track SNR.
{
  const deep = generateSyntheticTransit({ seed: 5, periodDays: 2.0, depthFrac: 0.03, noisePpm: 400, cadenceSec: 900, baselineDays: 10 });
  const shallow = generateSyntheticTransit({ seed: 5, periodDays: 2.0, depthFrac: 0.003, noisePpm: 400, cadenceSec: 900, baselineDays: 10 });
  const ud = bootstrapUncertainty(deep.lc, candFromTruth(deep.truth, "x"), { bootstraps: 40, seed: 8 });
  const us = bootstrapUncertainty(shallow.lc, candFromTruth(shallow.truth, "x"), { bootstraps: 40, seed: 8 });
  assert.ok(ud.periodSigma <= us.periodSigma + 1e-9, `deep sigma ${ud.periodSigma} must be <= shallow sigma ${us.periodSigma}`);
}

// 4. Too few points -> NaN interval, zero bootstraps (never a fake error bar).
{
  const tiny = generateSyntheticTransit({ seed: 6, periodDays: 2.0, depthFrac: 0.02, noisePpm: 200, cadenceSec: 3600, baselineDays: 1 });
  const u = bootstrapUncertainty(tiny.lc, candFromTruth(tiny.truth, "x"), { bootstraps: 20 });
  assert.ok(Number.isNaN(u.periodSigma) || u.nBootstrap === 0, "short curve must not report a confident error bar");
}

console.log("uncertainty.test.ts OK");
