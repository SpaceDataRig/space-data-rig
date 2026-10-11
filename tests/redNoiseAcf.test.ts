import assert from "node:assert/strict";
import { ar1Series, autocorrFunction, fitAr1ToAcf } from "../src/sim/redNoise.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15) | 1, a | 1);
    t += Math.imul(t ^ (t >>> 7) | 61, t ^ t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1. autocorrFunction recovers the AR(1) decay ACF[k] = rho^k on a long simulated series.
{
  const s = ar1Series(mulberry32(11), 40000, 1, 0.7);
  const acf = autocorrFunction(s, 5);
  assert.ok(Math.abs(acf[0] - 1) < 1e-9, "ACF[0] must be exactly 1");
  assert.ok(Math.abs(acf[1] - 0.7) < 0.05, `ACF[1] ~ rho, got ${acf[1].toFixed(3)}`);
  assert.ok(Math.abs(acf[2] - 0.49) < 0.06, `ACF[2] ~ rho^2, got ${acf[2].toFixed(3)}`);
  assert.ok(Math.abs(acf[3] - 0.343) < 0.07, `ACF[3] ~ rho^3, got ${acf[3].toFixed(3)}`);
}

// 2. fitAr1ToAcf scores a genuine AR(1) ACF as a good fit with ~zero excess memory.
{
  const s = ar1Series(mulberry32(22), 40000, 1, 0.6);
  const fit = fitAr1ToAcf(autocorrFunction(s, 8));
  assert.ok(fit.r2 > 0.9, `AR(1) data should fit AR(1) well, r2=${fit.r2.toFixed(3)}`);
  assert.ok(Math.abs(fit.excessAtLastLag) < 0.05, `AR(1) excess memory ~0, got ${fit.excessAtLastLag.toFixed(3)}`);
  assert.ok(fit.meanAbsErr < 0.05, `small AR(1) fit error, got ${fit.meanAbsErr.toFixed(3)}`);
}

// 3. A series with a power-law tail (correlation decays slower than rho^k) is flagged: the fit
//    reports POSITIVE excess memory at the last lag. This is the diagnostic that would catch real
//    TESS residuals being "redder than AR(1)".
{
  const acf = [1];
  for (let k = 1; k <= 10; k++) acf.push(Math.pow(0.4, k) + 0.2 / Math.sqrt(k)); // rho=acf[1]=0.6, long tail
  const fit = fitAr1ToAcf(acf);
  assert.ok(Math.abs(fit.rho - 0.6) < 1e-9, `rho taken from lag-1, got ${fit.rho.toFixed(3)}`);
  assert.ok(fit.excessAtLastLag > 0.03, `power-law tail must show positive excess, got ${fit.excessAtLastLag.toFixed(3)}`);
}

// 4. White noise: every lag beyond 0 is ~zero.
{
  const w = ar1Series(mulberry32(33), 40000, 1, 0);
  const acf = autocorrFunction(w, 6);
  for (let k = 1; k <= 6; k++) assert.ok(Math.abs(acf[k]) < 0.03, `white ACF[${k}] ~0, got ${acf[k].toFixed(3)}`);
}

// 5. Determinism: identical input -> identical ACF array.
{
  const s = ar1Series(mulberry32(44), 8000, 1, 0.5);
  assert.deepEqual(autocorrFunction(s, 5), autocorrFunction(s, 5));
}

console.log("redNoiseAcf.test.ts OK");
