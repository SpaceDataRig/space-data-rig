// End-to-end regression tests for the detection core: a transit injected with
// known parameters must be recovered by the BLS + alias-resolution chain within
// tight tolerances. These pin the detector itself (the previous suite only
// covered hashing, endpoints, and ephemeris arithmetic).
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSyntheticTransit } from "../src/data/synthetic.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";

test("mainSequenceMassFromRadius: 1 Rsun maps to 1 Msun and grows sublinearly-inverted", () => {
  assert.equal(mainSequenceMassFromRadius(1), 1);
  // R = M^0.89 must invert: f(R(M)) ~= M within float noise.
  const r05 = Math.pow(0.5, 0.89);
  assert.ok(Math.abs(mainSequenceMassFromRadius(r05) - 0.5) < 1e-9);
});

test("BLS recovers an injected hot-Jupiter (HD 189733 b parameters) to <1% period", () => {
  const { lc, truth } = generateSyntheticTransit({
    seed: 7001,
    periodDays: 2.21857, // real catalog value, HD 189733 b
    planetRadiusEarth: 12.64,
    stellarRadiusRsun: 0.79,
    stellarMassMsun: 0.8,
    impactParam: 0.3,
    noisePpm: 180,
    cadenceSec: 120,
    baselineDays: 27,
    targetIdLabel: "TEST-HD189733b",
  });
  const det = detectTransit(lc);
  const periodErrPct = (Math.abs(det.candidate.periodDays - truth.periodDays) / truth.periodDays) * 100;
  assert.ok(periodErrPct < 1, `period error ${periodErrPct.toFixed(2)}% exceeds 1%`);
  const depthErrFrac = Math.abs(det.candidate.depthFrac - truth.depthFrac) / truth.depthFrac;
  assert.ok(depthErrFrac < 0.4, `depth error ${(depthErrFrac * 100).toFixed(1)}% exceeds 40%`);
  assert.ok(det.candidate.snr > 7, `expected strong SNR, got ${det.candidate.snr.toFixed(1)}`);
});

test("BLS recovers an injected short-period Neptune (GJ 1214 b parameters) to <2% period", () => {
  const { lc, truth } = generateSyntheticTransit({
    seed: 7002,
    periodDays: 1.5804, // real catalog value, GJ 1214 b
    planetRadiusEarth: 2.74,
    stellarRadiusRsun: 0.22,
    stellarMassMsun: 0.15,
    impactParam: 0.25,
    noisePpm: 180,
    cadenceSec: 120,
    baselineDays: 27,
    targetIdLabel: "TEST-GJ1214b",
  });
  const det = detectTransit(lc);
  const periodErrPct = (Math.abs(det.candidate.periodDays - truth.periodDays) / truth.periodDays) * 100;
  assert.ok(periodErrPct < 2, `period error ${periodErrPct.toFixed(2)}% exceeds 2%`);
  assert.ok(det.candidate.snr > 5, `expected SNR > 5, got ${det.candidate.snr.toFixed(1)}`);
});
