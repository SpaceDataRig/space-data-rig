import assert from "node:assert/strict";
import { ar1Series, makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { runRoc } from "../src/sim/roc.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";

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

function lag1Autocorr(x: number[]): number {
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    den += (x[i] - m) * (x[i] - m);
    if (i > 0) num += (x[i] - m) * (x[i - 1] - m);
  }
  return num / den;
}

// 1. AR(1) series shows lag-1 autocorrelation close to the requested rho.
{
  const s = ar1Series(mulberry32(7), 20000, 1, 0.7);
  const a = lag1Autocorr(s);
  assert.ok(Math.abs(a - 0.7) < 0.06, `AR(1) rho=0.7 got autocorr ${a.toFixed(3)}`);
  const w = ar1Series(mulberry32(8), 20000, 1, 0);
  assert.ok(Math.abs(lag1Autocorr(w)) < 0.03, "rho=0 must be ~white");
}

// 2. A zero-injection (depthFrac 0) red-noise curve is planet-free: flat mean, modest BLS peak.
{
  const lc = makeRedNoiseLightCurve({ seed: 3, periodDays: 3, depthFrac: 0, noisePpm: 300, rho: 0.5, cadenceSec: 180, baselineDays: 12 });
  const mean = lc.points.reduce((a, p) => a + p.flux, 0) / lc.points.length;
  assert.ok(Math.abs(mean - 1) < 0.01, `null mean off 1: ${mean}`);
  const src = String(lc.source ?? "");
  assert.match(src, /red-noise/);
  assert.doesNotMatch(src, /real photometry/i, "synthetic red noise must NOT claim real");
  const r = bls(preprocess(lc, 0.5), { minPeriodDays: 1, maxPeriodDays: 8, oversample: 4, nDurations: 6 });
  assert.ok(r.snr < 12, `null red-noise peak implausibly high: ${r.snr}`);
}

// 3. A deep injected transit is recoverable under red noise, and the generator is deterministic.
{
  const o = { seed: 11, periodDays: 2.5, depthFrac: 0.02, noisePpm: 300, rho: 0.5, cadenceSec: 120, baselineDays: 20 };
  const lc = makeRedNoiseLightCurve(o);
  const r = bls(preprocess(lc, 0.5), { minPeriodDays: 1, maxPeriodDays: 6, oversample: 8, nDurations: 8 });
  const fac = Math.round(r.periodDays / o.periodDays);
  assert.ok(Math.abs(r.periodDays / fac - o.periodDays) / o.periodDays < 0.02, `deep red-noise transit not recovered: ${r.periodDays}`);
  assert.ok(r.snr >= 7, "deep signal should clear the production threshold under red noise");
  const again = makeRedNoiseLightCurve(o);
  assert.deepEqual(again.points, lc.points, "red-noise generator must be deterministic per seed");
}

// 4. KEY SCIENTIFIC INVARIANT: for the SAME threshold, red noise gives a HIGHER null peak-SNR
//    distribution than white noise -- i.e. correlated noise inflates the false-alarm statistic.
//    This is exactly why a white-noise FAR is optimistic and we must report the red curve.
{
  const opts = { nInjections: 40, nNoise: 120, depthsPpm: [4000], minPeriodDays: 1, maxPeriodDays: 3, noisePpm: 300, cadenceSec: 200, baselineDays: 12, thresholds: [5] };
  const white = runRoc({ ...opts, rho: 0 });
  const red = runRoc({ ...opts, rho: 0.6 });
  // The tail (max null peak) is what drives the false-alarm rate, and it is unambiguously higher
  // under correlated noise -- the mean is not a reliable statistic here (many nulls sit near zero).
  const wMax = Math.max(...white.noiseSnr);
  const rMax = Math.max(...red.noiseSnr);
  assert.ok(rMax > wMax, `red noise must raise the max null peak SNR (white ${wMax.toFixed(2)} vs red ${rMax.toFixed(2)})`);
  const wFar = white.points[0].falseAlarmRate;
  const rFar = red.points[0].falseAlarmRate;
  assert.ok(rFar >= wFar, `red-noise FAR (${rFar}) must be >= white FAR (${wFar}) at the same threshold`);
  assert.equal(red.rho, 0.6);
  assert.equal(white.rho, 0);
}

console.log("redNoise.test.ts OK");
