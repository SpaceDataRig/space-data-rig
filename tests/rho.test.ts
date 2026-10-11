import assert from "node:assert/strict";
import { ar1Series, lagAutocorr, estimateRho, detrendMovingMedian } from "../src/sim/redNoise.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1. lagAutocorr is an unbiased lag-1 estimator: recovers a known AR(1) rho.
{
  const s = ar1Series(mulberry32(101), 30000, 1, 0.7);
  const r = lagAutocorr(s, 1);
  assert.ok(Math.abs(r - 0.7) < 0.05, `lagAutocorr should recover rho=0.7, got ${r.toFixed(3)}`);
}

// 2. White noise has ~zero autocorrelation (both raw and after detrending).
{
  const w = ar1Series(mulberry32(202), 30000, 1, 0);
  assert.ok(Math.abs(lagAutocorr(w, 1)) < 0.03, "white raw lag-1 must be ~0");
  const rw = estimateRho(w);
  assert.ok(Math.abs(rw) < 0.06, `estimateRho(white) should be ~0, got ${rw.toFixed(3)}`);
}

// 3. estimateRho on correlated data is clearly positive and well above the white level.
//    (A moving-median detrend high-passes the series, so we test the DIRECTION and separation,
//     not an exact recovery -- the point is to tell red from white on real light curves.)
{
  const red = ar1Series(mulberry32(303), 30000, 1, 0.7);
  const rhoRed = estimateRho(red);
  assert.ok(rhoRed > 0.3, `estimateRho on rho=0.7 AR(1) should stay clearly positive, got ${rhoRed.toFixed(3)}`);
  assert.ok(rhoRed < 0.75, `detrend should not over-report, got ${rhoRed.toFixed(3)}`);
}

// 4. Too few usable points -> NaN (never a fake number).
{
  assert.ok(Number.isNaN(estimateRho([1, 2, 3, 4, 5])));
  assert.ok(Number.isNaN(estimateRho(Array.from({ length: 40 }, (_, i) => (i % 7 === 0 ? NaN : 1))))); // many NaNs dropped
}

// 5. Determinism: same input -> same rho; detrend keeps length and is deterministic.
{
  const data = ar1Series(mulberry32(404), 5000, 1, 0.5);
  assert.equal(estimateRho(data), estimateRho(data));
  const d1 = detrendMovingMedian(data, 15);
  const d2 = detrendMovingMedian(data, 15);
  assert.equal(d1.length, data.length);
  assert.deepEqual(d1, d2);
}

console.log("rho.test.ts OK");
