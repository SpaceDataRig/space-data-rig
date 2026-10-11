import assert from "node:assert/strict";
import { calibratedFap } from "../src/detect/significance.ts";
import { makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";

const grid = { minPeriodDays: 1, maxPeriodDays: 6, oversample: 8, nDurations: 8 };

// 1. A deep injected planet clears its own red-noise null ensemble -> FAP near the floor.
{
  const lc = makeRedNoiseLightCurve({ seed: 21, periodDays: 2.4, depthFrac: 0.03, noisePpm: 300, rho: 0.5, cadenceSec: 150, baselineDays: 20 });
  const det = bls(preprocess(lc, 0.5), grid);
  const sig = calibratedFap(lc, det.snr, 2.4, { nNull: 40, seed: 99 });
  assert.ok(sig.snr >= 7, `deep planet should be strong, got ${sig.snr.toFixed(1)}`);
  assert.ok(sig.fap <= 0.05, `deep planet FAP should be tiny under its OWN noise, got ${sig.fap}`);
  assert.ok(sig.rho > 0.2, `rho=0.5 curve should read correlated, got ${sig.rho.toFixed(2)}`);
}

// 2. Monotonicity: for the SAME curve, a higher observed SNR never raises the FAP.
{
  const lc = makeRedNoiseLightCurve({ seed: 22, periodDays: 3.1, depthFrac: 0.02, noisePpm: 300, rho: 0.4, cadenceSec: 150, baselineDays: 18 });
  const a = calibratedFap(lc, 6, 3.1, { nNull: 40, seed: 7 });
  const b = calibratedFap(lc, 12, 3.1, { nNull: 40, seed: 7 });
  assert.ok(b.fap <= a.fap + 1e-9, `FAP must not increase with SNR: snr6=${a.fap} snr12=${b.fap}`);
}

// 3. A pure-noise (null) curve's own peak is NOT ultra-significant against its matched nulls --
//    the FAP sits well above the floor (a fixed global SNR would wrongly call it equally reliable).
{
  const lc = makeRedNoiseLightCurve({ seed: 23, periodDays: 2.0, depthFrac: 0, noisePpm: 300, rho: 0.6, cadenceSec: 150, baselineDays: 20 });
  const det = bls(preprocess(lc, 0.5), grid);
  const sig = calibratedFap(lc, det.snr, 2.0, { nNull: 60, seed: 5 });
  assert.ok(sig.rho > 0.3, `rho=0.6 null should read strongly correlated, got ${sig.rho.toFixed(2)}`);
  assert.ok(sig.fap > 0.01, `a null's own peak should not be near-zero FAP, got ${sig.fap}`);
}

// 4. Determinism: identical inputs -> identical significance.
{
  const lc = makeRedNoiseLightCurve({ seed: 24, periodDays: 2.5, depthFrac: 0.02, noisePpm: 250, rho: 0.3, cadenceSec: 150, baselineDays: 16 });
  const x = calibratedFap(lc, 8, 2.5, { nNull: 30, seed: 3 });
  const y = calibratedFap(lc, 8, 2.5, { nNull: 30, seed: 3 });
  assert.deepEqual(x, y, "calibratedFap must be deterministic");
}

console.log("calibratedFap.test.ts OK");
