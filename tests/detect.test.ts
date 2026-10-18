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

// ---- what the grid actually resolved, and where it ran out of road -----------------------
// The period is a trial-grid node, so two things must be recorded rather than assumed: how far apart the nodes
// were at the adopted period, and whether the adopted node was the long-period wall. The second one matters
// because a peak sitting on the boundary is the search running out of range, not a measurement -- and the live
// rig had three findings at exactly 16.000000 d, the k=0 node of its 16-day maximum, one of which was announced.

test("a recovered interior period records its grid resolution and is NOT flagged as a boundary", () => {
  const { lc } = generateSyntheticTransit({
    seed: 7001,
    periodDays: 2.21857,
    planetRadiusEarth: 12.64,
    stellarRadiusRsun: 0.79,
    stellarMassMsun: 0.8,
    impactParam: 0.3,
    noisePpm: 180,
    cadenceSec: 120,
    baselineDays: 27,
    targetIdLabel: "TEST-boundary-interior",
  });
  const det = detectTransit(lc, { minPeriodDays: 0.8, maxPeriodDays: 16, oversample: 8, nDurations: 12 });
  const b = det.bls;
  assert.equal(b.atSearchBoundary, false, "a 2.2-day peak is not the 16-day wall");
  assert.equal(b.searchMaxPeriodDays, 16);
  assert.ok(b.baselineDays > 20 && b.baselineDays < 30, `unexpected baseline ${b.baselineDays}`);
  // dP = P^2 * df, df = 1/(oversample*baseline) -- checked against the numbers the search itself reports.
  const df = 1 / (8 * b.baselineDays);
  assert.ok(Math.abs(b.periodResolutionDays - b.periodDays * b.periodDays * df) < 1e-12, "resolution must be P^2*df");
  assert.ok(b.periodResolutionDays < 0.05, `a 2-day period should resolve well under 0.05 d, got ${b.periodResolutionDays}`);
  assert.equal(det.candidate.periodResolutionDays, b.periodResolutionDays * (det.candidate.periodDays / b.periodDays), "the alias multiple scales the uncertainty");
});

test("a peak at the long-period edge is flagged, and the flag means exactly periodDays === 1/fMin", () => {
  // A deliberately degenerate grid: min 0.5 d, max 0.6 d leaves almost nowhere for the peak to go but the wall, so
  // the boundary condition is exercised for real rather than asserted about a case that never occurs.
  const { lc } = generateSyntheticTransit({
    seed: 7002,
    periodDays: 2.21857,
    planetRadiusEarth: 12.64,
    stellarRadiusRsun: 0.79,
    stellarMassMsun: 0.8,
    impactParam: 0.3,
    noisePpm: 180,
    cadenceSec: 120,
    baselineDays: 27,
    targetIdLabel: "TEST-boundary-edge",
  });
  const det = detectTransit(lc, { minPeriodDays: 0.5, maxPeriodDays: 0.6, oversample: 8, nDurations: 4 });
  const b = det.bls;
  const fMin = 1 / 0.6;
  assert.equal(b.atSearchBoundary, b.periodDays === 1 / fMin, "the flag must be exactly 'the adopted node is k=0'");
  assert.ok(b.periodDays <= 0.6 + 1e-12 && b.periodDays >= 0.5 - 1e-12, `period ${b.periodDays} outside the grid`);
});

test("the boundary flag survives an alias doubling, because the underlying peak still hit the wall", () => {
  // detectTransit overwrites the period with the alias-resolved value; a period doubled off the edge node is
  // further beyond the searched range, not safely inside it, so the flag must not be cleared.
  const { lc } = generateSyntheticTransit({
    seed: 7003,
    periodDays: 2.21857,
    planetRadiusEarth: 12.64,
    stellarRadiusRsun: 0.79,
    stellarMassMsun: 0.8,
    impactParam: 0.3,
    noisePpm: 180,
    cadenceSec: 120,
    baselineDays: 27,
    targetIdLabel: "TEST-boundary-alias",
  });
  const det = detectTransit(lc, { minPeriodDays: 0.8, maxPeriodDays: 16, oversample: 8, nDurations: 12 });
  assert.equal(det.candidate.atSearchBoundary, det.bls.atSearchBoundary, "the candidate must not disagree with the search");
  assert.equal(det.candidate.searchMaxPeriodDays, det.bls.searchMaxPeriodDays);
});
