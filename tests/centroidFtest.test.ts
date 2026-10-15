// Offline tests for the faithful re-port of eumemic's multi-sector centroid F-test (audit: P74 correction).
// Every expected number is hand-derived from the doc's formula F = n(n-1)|mean-s|^2 / RSS,
// p = (1 + F/(n-1))^-(n-1), per-axis scatter floor 1", failed-fit drop at 60".
import { test } from "node:test";
import assert from "node:assert/strict";

import { centroidFtest, targetCentroidP, neighbourCanCauseDip, type Offset } from "../src/detect/centroidFtest.ts";

const approx = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b}`);

test("an on-target planet (small offsets, tiny spread) is NOT rejected", () => {
  const offs: Offset[] = [{ east: 0.2, north: 0.1 }, { east: -0.3, north: 0.2 }, { east: 0.1, north: -0.2 }, { east: -0.1, north: -0.1 }];
  const r = targetCentroidP(offs);
  assert.equal(r.testable, true);
  approx(r.meanEast, -0.025);
  approx(r.meanNorth, 0);
  approx(r.F, 0.00125, 1e-9);
  assert.ok(r.p > 0.9, `p=${r.p} should be large (on target)`);
});

test("a consistent ~20 arcsec east offset rejects the target AND fits a neighbour at that offset", () => {
  const offs: Offset[] = [{ east: 20, north: 0 }, { east: 20.5, north: 0.2 }, { east: 19.8, north: -0.1 }, { east: 20.2, north: 0.1 }];
  const target = targetCentroidP(offs);
  assert.ok(target.p < 0.001, `target p=${target.p} should be rejected`);
  const neighbour = centroidFtest(offs, { east: 20, north: 0 });
  assert.ok(neighbour.p > 0.01, `neighbour p=${neighbour.p} should fit`);
});

test("fewer than two usable sectors is not testable", () => {
  const r = targetCentroidP([{ east: 1, north: 1 }]);
  assert.equal(r.testable, false);
  assert.equal(r.p, 1);
});

test("offsets beyond 60 arcsec are dropped as failed fits", () => {
  const r = targetCentroidP([{ east: 100, north: 0 }, { east: 20, north: 0 }, { east: 21, north: 0 }]);
  assert.equal(r.nUsed, 2);
  assert.equal(r.nDropped, 1);
  assert.equal(r.testable, true);
});

test("the 1 arcsec scatter floor keeps a zero-spread set finite instead of infinitely significant", () => {
  const offs: Offset[] = [{ east: 5, north: 5 }, { east: 5, north: 5 }, { east: 5, north: 5 }];
  const r = targetCentroidP(offs);
  assert.ok(Number.isFinite(r.F), "F must be finite thanks to the floor");
  approx(r.F, 75); // n(n-1)d2/rss = 3*2*50 / (2*2*1) = 300/4
  approx(r.p, Math.pow(1 + 75 / 2, -2));
  assert.ok(r.p < 0.01);
});

test("testing the mean against itself gives F=0, p=1", () => {
  const offs: Offset[] = [{ east: 3, north: 4 }, { east: 3.1, north: 4.2 }, { east: 2.9, north: 3.8 }];
  const m = targetCentroidP(offs);
  const r = centroidFtest(offs, { east: m.meanEast, north: m.meanNorth });
  approx(r.F, 0);
  approx(r.p, 1);
});

test("neighbourCanCauseDip applies the total-eclipse dilution threshold", () => {
  // observed depth 1.2% needs F_star/F_target >= 0.012/0.988 = 0.01214.
  assert.equal(neighbourCanCauseDip(0.012, 12, 10), true); // ratio 0.158
  assert.equal(neighbourCanCauseDip(0.012, 14, 10), true); // ratio 0.0251
  assert.equal(neighbourCanCauseDip(0.012, 16, 10), false); // ratio 0.00398, too faint
  assert.equal(neighbourCanCauseDip(0, 12, 10), false); // non-physical depth
});
