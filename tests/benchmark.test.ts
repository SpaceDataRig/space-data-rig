// Offline tests for the benchmark core statistics (TCE / DAVE-TRICERATOPS / TPM re-implementations).
// Every expected value is hand-derived from the formulas in src/detect/benchmark.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blsTransitSnr, tceAccepts, detectionProbability, daveBlendedFpp, tpmCompletenessProbability, fitTpmLogistic,
} from "../src/detect/benchmark.ts";

const approx = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b}`);

test("BLS SNR = (depth/noise) * sqrt(in-transit points), hand-checked", () => {
  const r = blsTransitSnr({ depthPpm: 2000, periodDays: 4, durationHours: 3, cadenceMin: 2, baselineDays: 27, noisePpm: 100 });
  assert.equal(r.nTransits, 6); // floor(27/4)
  approx(r.inTransitPoints, 6 * 90); // 3h*60/2 = 90 points/transit
  approx(r.snr, 20 * Math.sqrt(540), 1e-6); // (2000/100)=20, sqrt(540)
});

test("BLS SNR scales linearly with depth and as sqrt of transits", () => {
  const base = { periodDays: 4, durationHours: 3, cadenceMin: 2, noisePpm: 100 };
  const a = blsTransitSnr({ ...base, depthPpm: 1000, baselineDays: 27 });
  const b = blsTransitSnr({ ...base, depthPpm: 2000, baselineDays: 27 });
  approx(b.snr / a.snr, 2, 1e-9); // double depth -> double SNR
  const c = blsTransitSnr({ ...base, depthPpm: 1000, baselineDays: 108 }); // floor(108/4)=27 vs floor(27/4)=6 -> 4.5x transits -> sqrt(4.5)x SNR
  approx(c.snr / a.snr, Math.sqrt(27 / 6), 1e-9);
});

test("TCE acceptance: rejects <3 transits and EB-deep signals, accepts deep short-period", () => {
  const tooLong = tceAccepts({ depthPpm: 3000, periodDays: 10, durationHours: 3, cadenceMin: 2, baselineDays: 27, noisePpm: 100 });
  assert.equal(tooLong.accept, false);
  assert.match(tooLong.reason, /transits/); // floor(27/10)=2 < 3
  const good = tceAccepts({ depthPpm: 3000, periodDays: 4, durationHours: 3, cadenceMin: 2, baselineDays: 27, noisePpm: 100 });
  assert.equal(good.accept, true);
  const eb = tceAccepts({ depthPpm: 50000, periodDays: 4, durationHours: 3, cadenceMin: 2, baselineDays: 27, noisePpm: 100 });
  assert.equal(eb.accept, false);
  assert.match(eb.reason, /EB/);
});

test("detection probability is 0.5 at threshold and monotonic in SNR", () => {
  approx(detectionProbability(7, 7), 0.5);
  assert.ok(detectionProbability(15, 7) > detectionProbability(10, 7));
  assert.ok(detectionProbability(0, 7) < 0.01);
});

test("DAVE blended FPP: zero with no viable neighbour, hand-checked with one", () => {
  assert.equal(daveBlendedFpp({ obsDepthFrac: 0.01, periodDays: 4, neighbors: [] }), 0);
  const tooFaint = daveBlendedFpp({ obsDepthFrac: 0.01, periodDays: 4, neighbors: [{ contrast: 0.005 }] });
  assert.equal(tooFaint, 0); // contrast 0.005 < minContrast 0.01/0.99 ~ 0.0101
  const one = daveBlendedFpp({ obsDepthFrac: 0.01, periodDays: 4, neighbors: [{ contrast: 1 }] });
  approx(one, 0.015 * Math.min(1, 0.02 * 2), 1e-9); // deltaNb=0.01*(1+1)/1=0.02 -> shape 0.04
});

test("DAVE blended FPP grows with more viable neighbours and is clipped to [0,1]", () => {
  const n = 30;
  const neighbors = Array.from({ length: n }, () => ({ contrast: 0.5 }));
  const fpp = daveBlendedFpp({ obsDepthFrac: 0.1, periodDays: 4, neighbors });
  assert.ok(fpp <= 1 && fpp >= 0);
  const single = daveBlendedFpp({ obsDepthFrac: 0.1, periodDays: 4, neighbors: [{ contrast: 0.5 }] });
  assert.ok(fpp > single);
});

test("TPM logistic predictor: symmetric sigmoid hand-check, monotonic in depth and period", () => {
  const m = { b0: 0, bLogP: -1, bLogD: 1 };
  approx(tpmCompletenessProbability(m, 5, 5), 0.5); // ln(D/P)=0
  assert.ok(tpmCompletenessProbability(m, 5, 50) > tpmCompletenessProbability(m, 5, 5));
  assert.ok(tpmCompletenessProbability(m, 10, 5) < tpmCompletenessProbability(m, 5, 5));
});

test("TPM fit recovers the sign that completeness rises with depth and falls with period", () => {
  // synthetic grid: completeness = sigmoid(-0.6*lnP + 0.9*lnD - 2)
  const pts = [];
  for (const P of [1.5, 3, 6, 10]) {
    for (const D of [200, 600, 1800, 5000]) {
      const z = -0.6 * Math.log(P) + 0.9 * Math.log(D) - 2;
      pts.push({ periodDays: P, depthPpm: D, completeness: 1 / (1 + Math.exp(-z)) });
    }
  }
  const fit = fitTpmLogistic(pts);
  assert.ok(fit.bLogD > 0.4, `bLogD=${fit.bLogD}`); // depth helps
  assert.ok(fit.bLogP < -0.2, `bLogP=${fit.bLogP}`); // period hurts
  // predicted ordering matches the generator's direction
  assert.ok(tpmCompletenessProbability(fit, 3, 1800) > tpmCompletenessProbability(fit, 3, 300));
  assert.ok(tpmCompletenessProbability(fit, 1.5, 600) > tpmCompletenessProbability(fit, 6, 600));
});
