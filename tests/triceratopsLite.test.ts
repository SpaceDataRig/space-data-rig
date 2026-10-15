// Offline tests for the TRICERATOPS-lite helpers (audit-9 gap 3 grade-up).
import { test } from "node:test";
import assert from "node:assert/strict";

import { neighborContrasts, dilutionCorrectedDepthPpm, countHarmonicSiblings, aliasRiskLevel } from "../src/candidate/triceratopsLite.ts";

test("neighborContrasts orders by flux ratio and converts magnitude deltas", () => {
  const cs = neighborContrasts(10, [10, 12, 15]); // host 10; neighbours at +2 and +5 mag
  assert.equal(cs.length, 3);
  assert.equal(cs[0], 1); // equal mag -> contrast 1 (brightest first)
  assert.ok(Math.abs(cs[1] - Math.pow(10, -0.8)) < 1e-9); // +2 mag -> 10^-0.8
  assert.ok(cs[1] > cs[2]);
});

test("dilution-corrected depth deepens as the aperture dilutes", () => {
  assert.equal(dilutionCorrectedDepthPpm(1000, 1), 1000);
  assert.equal(dilutionCorrectedDepthPpm(1000, 0.5), 2000);
  assert.equal(dilutionCorrectedDepthPpm(1000, 0), 1000, // guard: invalid factor leaves depth unchanged
  );
});

test("harmonic siblings count alias-period peaks and exclude the self period", () => {
  const peaks = [4.0, 2.0, 8.0, 6.0, 5.0];
  // relative to 4.0: 2.0 = P/2, 8.0 = 2P, 6.0 = 1.5P -> 3 siblings; 5.0 (1.25P) is not a simple harmonic
  assert.equal(countHarmonicSiblings(4.0, peaks), 3);
  assert.equal(countHarmonicSiblings(4.0, [4.0]), 0, "self excluded");
  assert.equal(countHarmonicSiblings(0, [1, 2]), 0);
});

test("aliasRiskLevel is monotone: cleaner inputs grade lower", () => {
  const base = 0.53;
  const clean = aliasRiskLevel({ harmonicSiblings: 0, falseCoincidenceBase: 0, centroidOnTarget: true, blendFpp: 1e-5 });
  const suspect = aliasRiskLevel({ harmonicSiblings: 2, falseCoincidenceBase: base, centroidOnTarget: false, blendFpp: 0.05 });
  const order: Record<string, number> = { low: 0, moderate: 1, high: 2 };
  assert.equal(clean.level, "low");
  assert.equal(suspect.level, "high");
  assert.ok(order[clean.level] < order[suspect.level]);
});

test("an unmeasured centroid cannot upgrade a candidate to low", () => {
  const r = aliasRiskLevel({ harmonicSiblings: 0, falseCoincidenceBase: 0, centroidOnTarget: null, blendFpp: 1e-5 });
  assert.notEqual(r.level, "low");
  assert.match(r.note, /centroid not measured/);
});
