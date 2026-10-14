// Offline tests for the selection-function skeleton (discovery roadmap, priority 4).
// Pure arithmetic on synthetic inputs -- no network, no detector. The point is that geometry, the
// dilution window, and the completeness grid compose correctly and honestly (a diluted host needs a
// DEEPER true transit; an unrecovered period bin yields null, not a fake number).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  semiMajorAxisAu,
  geometricTransitProbability,
  dilutionInflatedDepth,
  buildSelectionFunction,
  contrastWindowAssessment,
  RSUN_PER_AU,
} from "../src/sim/selectionFunction.ts";
import { binCompleteness, type Trial } from "../src/sim/completenessGrid.ts";

test("semiMajorAxisAu matches Kepler's third law", () => {
  assert.ok(Math.abs(semiMajorAxisAu(365.25, 1) - 1) < 1e-6, "Earth-Sun ~ 1 AU");
  // 10 d around a 1 Msun star: a = (10/365.25)^(2/3) ~ 0.0911 AU
  assert.ok(Math.abs(semiMajorAxisAu(10, 1) - 0.0911) < 0.001, `got ${semiMajorAxisAu(10, 1)}`);
  assert.ok(Number.isNaN(semiMajorAxisAu(0, 1)), "non-positive period -> NaN");
});

test("geometric transit probability: Earth ~ Rsun/AU, monotonic in period, clipped", () => {
  const earth = geometricTransitProbability(365.25, 1, 1);
  assert.ok(Math.abs(earth - RSUN_PER_AU) < 1e-6, `Earth p ~ ${earth}`);
  const hotJup = geometricTransitProbability(3, 1, 1);
  assert.ok(hotJup > 0.1 && hotJup < 0.13, `3d hot jup ~ ${hotJup}`);
  assert.ok(hotJup > earth, "shorter period transits more often");
  // a huge star on a tiny orbit must clip at 1, never exceed it
  assert.ok(geometricTransitProbability(0.1, 50, 1) <= 1, "clipped to <= 1");
});

test("dilutionInflatedDepth: clean host unchanged, diluted host needs a deeper true transit", () => {
  assert.equal(dilutionInflatedDepth(100, 1), 100);
  assert.equal(dilutionInflatedDepth(100, 0.5), 200);
  assert.equal(dilutionInflatedDepth(100, 0.25), 400);
  assert.equal(dilutionInflatedDepth(100, 1.5), 100, "dilution factor clamped to <= 1");
  assert.equal(dilutionInflatedDepth(100, 0), Infinity, "fully blended host is undetectable");
  assert.ok(Number.isNaN(dilutionInflatedDepth(NaN, 0.5)), "bad depth -> NaN");
});

test("buildSelectionFunction composes geometry, dilution and completeness per period bin", () => {
  const trials: Trial[] = [];
  // period bin [3,10]: shallow (500 ppm) never recovered, deep (5000 ppm) always recovered
  for (let i = 0; i < 10; i++) {
    trials.push({ periodDays: 5, depthPpm: 500, recovered: false });
    trials.push({ periodDays: 5, depthPpm: 5000, recovered: true });
    trials.push({ periodDays: 2, depthPpm: 5000, recovered: true });
    trials.push({ periodDays: 20, depthPpm: 5000, recovered: false }); // bin never reaches 50%
  }
  const grid = binCompleteness(trials, [1, 3, 10, 30], [100, 1000, 10000]);
  const sel = buildSelectionFunction(grid, { dilutionFactor: 0.5, starRadiusSolar: 1, starMassSolar: 1 });
  assert.equal(sel.length, 3, "one row per period bin");

  const mid = sel[1]; // [3,10]
  assert.ok(mid.observedDepth50Ppm != null && mid.observedDepth50Ppm > 1000, `mid observed ${mid.observedDepth50Ppm}`);
  assert.equal(mid.trueDepth50Ppm, (mid.observedDepth50Ppm as number) / 0.5, "true depth = observed / dilution");
  assert.ok(mid.geometricTransitProb > 0 && mid.geometricTransitProb < 1, `geo ${mid.geometricTransitProb}`);
  assert.equal(mid.selectionWeightAt50, 0.5 * mid.geometricTransitProb, "weight = target * geo");

  const far = sel[2]; // [10,30] never reaches 50%
  assert.equal(far.observedDepth50Ppm, null, "unrecovered bin -> null observed depth");
  assert.equal(far.trueDepth50Ppm, null, "null propagates, no fake number");
  assert.equal(far.selectionWeightAt50, null);
});

test("contrastWindowAssessment flags measurable vs lower-bound dilution", () => {
  const noNeighbour = contrastWindowAssessment(NaN, 5);
  assert.equal(noNeighbour.dilutionMeasurable, false);
  assert.equal(noNeighbour.worstCaseExtraDilutionPpm, Infinity);

  const bright = contrastWindowAssessment(2.0, 5); // companion within the imaging limit
  assert.equal(bright.dilutionMeasurable, true);
  // at the limit (dmag 5) the undetected flux/host is 10^(-0.4*5) ~ 0.01
  assert.ok(Math.abs(bright.worstCaseExtraDilutionPpm - Math.pow(10, -2)) < 1e-9, `worst case ${bright.worstCaseExtraDilutionPpm}`);

  const faint = contrastWindowAssessment(8.0, 5); // brightest contaminant fainter than the limit
  assert.equal(faint.dilutionMeasurable, false);
});
