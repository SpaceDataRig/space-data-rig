// Offline tests for the 2-D completeness grid (validation roadmap, priority 4).
// Pure statistical binning; no detector, no network. Checks the Wilson interval behaves honestly at
// the boundaries, that binning counts trials correctly and stays rectangular, and that the 50%
// threshold curve interpolates.
import { test } from "node:test";
import assert from "node:assert/strict";

import { wilsonInterval, binCompleteness, thresholdDepthAt, type Trial } from "../src/sim/completenessGrid.ts";

test("wilson interval: n=0 is total ignorance [0,1]", () => {
  assert.deepEqual(wilsonInterval(0, 0), [0, 1]);
});

test("wilson interval: k=0 still gives a non-zero upper bound (absence of evidence)", () => {
  const [lo, hi] = wilsonInterval(0, 10);
  assert.equal(lo, 0);
  assert.ok(hi > 0.15 && hi < 0.4, `k=0 upper bound should be ~0.28, got ${hi}`);
});

test("wilson interval: k=5/10 is symmetric around 0.5 and brackets it", () => {
  const [lo, hi] = wilsonInterval(5, 10);
  assert.ok(Math.abs((lo + hi) / 2 - 0.5) < 1e-9);
  assert.ok(lo > 0.15 && lo < 0.35 && hi > 0.65 && hi < 0.85, `got [${lo},${hi}]`);
});

test("wilson interval: bounds are monotonic in k and clipped to [0,1]", () => {
  let prevHi = -1;
  for (let k = 0; k <= 20; k++) {
    const [lo, hi] = wilsonInterval(k, 20);
    assert.ok(lo >= 0 && hi <= 1);
    assert.ok(lo <= 0.5 + 1e-9 || k > 10);
    assert.ok(hi >= prevHi - 1e-12, `upper bound must not decrease with k at k=${k}`);
    prevHi = hi;
  }
  assert.equal(wilsonInterval(20, 20)[1], 1);
});

function fill(pi: number, di: number, n: number, k: number, periodEdges: number[], depthEdges: number[], out: Trial[]) {
  const pc = (periodEdges[pi] + periodEdges[pi + 1]) / 2;
  const dc = (depthEdges[di] + depthEdges[di + 1]) / 2;
  for (let i = 0; i < n; i++) out.push({ periodDays: pc, depthPpm: dc, recovered: i < k });
}

test("binCompleteness counts n/k per cell, keeps the grid rectangular, and reports out-of-range", () => {
  const periodEdges = [1, 10, 100];
  const depthEdges = [0, 100, 200, 300];
  const trials: Trial[] = [];
  fill(0, 0, 10, 3, periodEdges, depthEdges, trials);
  fill(1, 2, 8, 8, periodEdges, depthEdges, trials);
  trials.push({ periodDays: 0.5, depthPpm: 150, recovered: true }); // period below range -> outside
  trials.push({ periodDays: 50, depthPpm: 500, recovered: true }); // depth above range -> outside
  const g = binCompleteness(trials, periodEdges, depthEdges);
  assert.equal(g.cells.length, 2 * 3, "2 period bins x 3 depth bins");
  assert.equal(g.used, 18);
  assert.equal(g.outside, 2);
  const c00 = g.cells.find((c) => c.periodIndex === 0 && c.depthIndex === 0)!;
  assert.equal(c00.n, 10);
  assert.equal(c00.k, 3);
  assert.ok(Math.abs(c00.completeness - 0.3) < 1e-9);
  const c12 = g.cells.find((c) => c.periodIndex === 1 && c.depthIndex === 2)!;
  assert.equal(c12.completeness, 1);
  const empty = g.cells.find((c) => c.periodIndex === 0 && c.depthIndex === 2)!;
  assert.equal(empty.n, 0);
  assert.ok(Number.isNaN(empty.completeness));
});

test("thresholdDepthAt interpolates the 50% crossing per period bin", () => {
  const periodEdges = [1, 10];
  const depthEdges = [0, 100, 200, 300];
  const trials: Trial[] = [];
  fill(0, 0, 10, 0, periodEdges, depthEdges, trials); // 0.0 at centre 50
  fill(0, 1, 10, 5, periodEdges, depthEdges, trials); // 0.5 at centre 150
  fill(0, 2, 10, 10, periodEdges, depthEdges, trials); // 1.0 at centre 250
  const g = binCompleteness(trials, periodEdges, depthEdges);
  const th = thresholdDepthAt(g, 0.5);
  assert.equal(th.length, 1);
  assert.ok(th[0].depthPpm != null && Math.abs(th[0].depthPpm! - 150) < 1e-6, `expected 150, got ${th[0].depthPpm}`);
});

test("thresholdDepthAt returns null when a period bin never reaches the target", () => {
  const periodEdges = [1, 10];
  const depthEdges = [0, 100, 200];
  const trials: Trial[] = [];
  fill(0, 0, 10, 1, periodEdges, depthEdges, trials);
  fill(0, 1, 10, 3, periodEdges, depthEdges, trials); // max 0.3 < 0.5
  const g = binCompleteness(trials, periodEdges, depthEdges);
  const th = thresholdDepthAt(g, 0.5);
  assert.equal(th[0].depthPpm, null);
});

test("binning is deterministic for identical trials", () => {
  const periodEdges = [1, 10, 100];
  const depthEdges = [0, 100, 200];
  const trials: Trial[] = [];
  fill(0, 0, 6, 2, periodEdges, depthEdges, trials);
  fill(1, 1, 6, 5, periodEdges, depthEdges, trials);
  const a = binCompleteness(trials, periodEdges, depthEdges);
  const b = binCompleteness(trials, periodEdges, depthEdges);
  assert.deepEqual(a.cells.map((c) => [c.n, c.k, c.completeness]), b.cells.map((c) => [c.n, c.k, c.completeness]));
});
