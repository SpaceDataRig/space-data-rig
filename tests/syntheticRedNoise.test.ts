import assert from "node:assert/strict";
import { generateSyntheticTransit, standInRhoForIndex, STANDIN_RHO_BY_INDEX } from "../src/data/synthetic.ts";
import { lagAutocorr } from "../src/sim/redNoise.ts";
import { detectTransit } from "../src/detect/pipeline.ts";

// 1. rho=0 is white: lag-1 autocorrelation of the (flat-model) residuals is ~0.
{
  const { lc } = generateSyntheticTransit({ seed: 11, periodDays: 3, depthFrac: 0, noisePpm: 300, cadenceSec: 300, baselineDays: 20, rho: 0 });
  const resid = lc.points.map((p) => p.flux - 1);
  const a = lagAutocorr(resid, 1);
  assert.ok(Math.abs(a) < 0.1, `white noise lag-1 autocorr should be ~0, got ${a}`);
  assert.ok(!/rho=/.test(String(lc.source)), "white stand-in source must not claim a rho");
}

// 2. rho>0 is correlated: the same measurement is clearly positive and clearly above the white case.
{
  const { lc } = generateSyntheticTransit({ seed: 11, periodDays: 3, depthFrac: 0, noisePpm: 300, cadenceSec: 300, baselineDays: 20, rho: 0.6 });
  const resid = lc.points.map((p) => p.flux - 1);
  const a = lagAutocorr(resid, 1);
  assert.ok(a > 0.25, `red noise (rho=0.6) lag-1 autocorr should be clearly positive, got ${a}`);
  assert.match(String(lc.source), /AR1 rho=0\.60/, "red stand-in source must state its rho honestly");
}

// 3. Deterministic: identical seed + rho reproduce identical bytes (the bundle-hash guarantee).
{
  const mk = () => generateSyntheticTransit({ seed: 5, periodDays: 2.5, depthFrac: 0.01, noisePpm: 200, cadenceSec: 400, baselineDays: 15, rho: 0.45 }).lc.points;
  const a = mk();
  const b = mk();
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(a[i]!.flux, b[i]!.flux, `point ${i} differs across identical runs`);
}

// 4. A deep transit is still recovered under strong red noise (the detector is not defeated by it).
{
  const { lc, truth } = generateSyntheticTransit({ seed: 21, periodDays: 2.0, planetRadiusEarth: 12, stellarRadiusRsun: 0.8, noisePpm: 200, cadenceSec: 200, baselineDays: 20, rho: 0.5 });
  const det = detectTransit(lc);
  const errPct = (Math.abs(det.candidate.periodDays - truth.periodDays) / truth.periodDays) * 100;
  assert.ok(errPct < 2, `deep hot-Jupiter period should survive red noise, err ${errPct.toFixed(2)}%`);
  assert.ok(det.candidate.snr > 7, `expected strong SNR under red noise, got ${det.candidate.snr.toFixed(1)}`);
}

// 5. The per-index stand-in rho cycles the measured real range deterministically.
{
  assert.equal(standInRhoForIndex(0), STANDIN_RHO_BY_INDEX[0]);
  assert.equal(standInRhoForIndex(1), STANDIN_RHO_BY_INDEX[1]);
  assert.equal(standInRhoForIndex(4), STANDIN_RHO_BY_INDEX[0], "cycles modulo the table length");
  assert.ok(STANDIN_RHO_BY_INDEX.every((r) => r >= 0 && r <= 0.95), "rho table stays in the physical AR(1) range");
  assert.ok(Math.max(...STANDIN_RHO_BY_INDEX) >= 0.5, "the table spans up to the active-star regime measured on real hosts");
}

console.log("syntheticRedNoise.test.ts OK");
