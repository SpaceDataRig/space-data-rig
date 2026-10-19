// Unit tests for the occurrence-rate kernel. All pure arithmetic, checked against hand-computable cases and the
// monotonic/bracketing properties the forward-model consistency study relies on.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  gehrelsInterval, etaFromCounts, expectedYield, consistencyZ,
} from "../src/sim/occurrenceRate.ts";

test("gehrelsInterval brackets the observed count and degenerates sanely at n=0", () => {
  for (const n of [1, 3, 10, 40]) {
    const [lo, hi] = gehrelsInterval(n);
    assert.ok(lo < n && n < hi, `n=${n}: ${lo} < ${n} < ${hi} must hold`);
    assert.ok(lo > 0, `lower bound must stay positive for n=${n}`);
  }
  const [lo0] = gehrelsInterval(0);
  assert.ok(lo0 >= 0 && lo0 < 1, "n=0 lower bound is the Gehrels small-count floor");
  assert.ok(!Number.isFinite(gehrelsInterval(-1)[0]), "negative count is NaN");
});

test("gehrels interval widens monotonically with the count", () => {
  const w = (n: number) => { const [lo, hi] = gehrelsInterval(n); return hi - lo; };
  assert.ok(w(3) < w(10) && w(10) < w(40), "absolute Poisson width grows with n");
});

test("etaFromCounts inverts exactly and the CI brackets the point estimate", () => {
  const r = etaFromCounts({ nDetections: 10, nStars: 100, selection: 0.5 });
  assert.ok(r != null);
  assert.equal(r.eta, 0.2); // 10 / (100 * 0.5)
  assert.ok(r.lo < r.eta && r.eta < r.hi);
});

test("etaFromCounts rejects impossible configurations", () => {
  assert.equal(etaFromCounts({ nDetections: 5, nStars: 0, selection: 0.5 }), null);
  assert.equal(etaFromCounts({ nDetections: 5, nStars: 10, selection: 0 }), null);
  assert.equal(etaFromCounts({ nDetections: 5, nStars: 10, selection: 1.5 }), null); // S must be in (0,1]
  assert.equal(etaFromCounts({ nDetections: -1, nStars: 10, selection: 0.5 }), null);
});

test("expectedYield forward-models E[N] = N*eta*S and carries the reference error into a band", () => {
  const e = expectedYield({ nStars: 12, refEta: 1.1, refSigma: 0.16, selection: 0.3 });
  assert.ok(e != null);
  assert.ok(Math.abs(e.expected - 12 * 1.1 * 0.3) < 1e-12);
  assert.ok(e.bandLo < e.expected && e.expected < e.bandHi);
  // band half-width = N*S*refSigma
  assert.ok(Math.abs((e.bandHi - e.expected) - 12 * 0.3 * 0.16) < 1e-12);
});

test("consistencyZ is ~zero when observed equals expected and flags large mismatches", () => {
  const ok = consistencyZ(4, 4);
  assert.ok(Math.abs(ok.z) < 0.5, `matched counts should be near zero, got ${ok.z}`);
  assert.ok(ok.note.includes("consistent"));
  const off = consistencyZ(40, 2);
  assert.ok(off.z > 3, `observed far above expected must be a big positive z, got ${off.z}`);
  assert.ok(off.note.includes("inconsistent"));
});

test("consistencyZ guards undefined inputs", () => {
  assert.ok(!Number.isFinite(consistencyZ(NaN, 5).z));
  assert.equal(consistencyZ(5, -1).note, "undefined");
});
