// Completeness/purity ROC engine tests. The load-bearing assertions are structural
// invariants that hold for any noise realization (determinism + monotonicity of both
// completeness and false-alarm rate in the threshold), plus a sanity check that deep
// injected planets are recovered and planet-free noise rarely throws a high-SNR peak.
// Kept small/fast so npm test stays quick.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runRoc, formatRoc, empiricalFap, type RocOptions } from "../src/sim/roc.ts";

// A small, fast config: short baseline + coarse cadence => ~1k points per curve.
const SMALL: RocOptions = {
  nInjections: 10,
  nNoise: 10,
  seed: 777,
  thresholds: [5, 8, 11, 14],
  baselineDays: 7,
  cadenceSec: 300,
  noisePpm: 220,
  depthsPpm: [1000, 3000, 8000],
};

test("ROC is deterministic: same seed yields an identical curve", () => {
  const a = runRoc(SMALL);
  const b = runRoc(SMALL);
  assert.deepEqual(a.points, b.points);
});

test("completeness and false-alarm rate are both non-increasing as the threshold rises", () => {
  const r = runRoc(SMALL);
  for (let i = 1; i < r.points.length; i++) {
    assert.ok(r.points[i].completeness <= r.points[i - 1].completeness + 1e-12, "completeness must not increase with threshold");
    assert.ok(r.points[i].falseAlarmRate <= r.points[i - 1].falseAlarmRate + 1e-12, "false-alarm rate must not increase with threshold");
  }
});

test("deep planets with well-covered periods are recovered with high completeness", () => {
  // Constrain periods so the baseline holds several transits; completeness is otherwise
  // dominated by period-vs-baseline coverage, not depth. Deep, well-covered planets must
  // be recovered nearly every time.
  const r = runRoc({
    ...SMALL,
    minPeriodDays: 1,
    maxPeriodDays: 3,
    baselineDays: 12,
    cadenceSec: 200,
    depthsPpm: [9000],
    thresholds: [5],
    noisePpm: 200,
  });
  const c = r.points[0].completeness;
  assert.ok(c >= 0.7, `deep well-covered completeness should be high, got ${(c * 100).toFixed(0)}%`);
});

test("planet-free noise rarely throws a very high-SNR peak", () => {
  const r = runRoc({ ...SMALL, thresholds: [14] });
  // at SNR>=14 on 10 noise curves we expect a small false-alarm count
  assert.ok(r.points[0].nFalse <= 3, `noise false-alarms at SNR>=14 should be rare, got ${r.points[0].nFalse}`);
});

test("formatRoc renders an aligned ASCII table with a row per threshold", () => {
  const r = runRoc(SMALL);
  const txt = formatRoc(r);
  const lines = txt.trim().split("\n");
  assert.equal(lines.length, r.points.length + 1); // header + one row per threshold
  assert.match(lines[0], /completeness/);
  assert.match(lines[0], /false-alarm-rate/);
});

test("empiricalFap is the noise-ensemble false-alarm rate and decreases monotonically with SNR", () => {
  const r = runRoc(SMALL);
  const lo = empiricalFap(r.noiseSnr, 4);
  const hi = empiricalFap(r.noiseSnr, 14);
  // a higher statistic is exceeded by fewer (or equal) noise curves -> smaller or equal FAP
  assert.ok(hi.fap <= lo.fap + 1e-12, `FAP must not increase with SNR: lo=${lo.fap} hi=${hi.fap}`);
  assert.ok(hi.fap >= hi.floor - 1e-12, "FAP never below the 1/(N+1) resolution floor");
  assert.equal(hi.n, r.noiseSnr.length);
});
