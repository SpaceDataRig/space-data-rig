// tests for src/detect/instrumentalNull.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { systematicsAwareFap, benjaminiHochberg, templateOnTimes } from "../src/detect/instrumentalNull.ts";
import { commonModeTemplate } from "../src/detect/commonMode.ts";
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import type { LightCurve } from "../src/core/types.ts";

// deterministic shared coherent dip + a star-specific planet + white noise, all on one cadence grid
const T0 = 2459000;
const CADENCE = 0.05; // days (fine cadence so the 0.5 d detrend window spans ~10 samples, like real photometry)
const NT = 300; // 15-day baseline

function times(): number[] {
  return Array.from({ length: NT }, (_, i) => T0 + i * CADENCE);
}

// mulberry32 for deterministic white noise
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// the coherent artifact every star shares: period 5 d, width 0.1 d (far below the 0.5 d detrend window,
// so it SURVIVES detrending in both the candidate and the null -- the null then reproduces it -> high FAP)
function coherentDip(t: number): number {
  const phase = (t - T0) % 5;
  return phase >= 0 && phase < 0.1 ? -0.004 : 0;
}

// a single star's planet: period 3 d, width 0.1 d (narrow, survives the detrend), depth 2%
function planetDip(t: number): number {
  const phase = (t - T0) % 3;
  return phase >= 0 && phase < 0.1 ? -0.02 : 0;
}

// mkCurve adds baseline 1 + the dip delta + deterministic white noise (~200 ppm)
function mkCurve(dipAt: (t: number) => number, noiseSeed: number): LightCurve {
  const rand = rng(noiseSeed);
  const pts = times().map((t) => ({ time: t, flux: 1 + dipAt(t) + gauss(rand) * 0.0002, fluxErr: 0.0002 }));
  return { targetId: `T-${noiseSeed}`, mission: "synthetic", cadenceSec: CADENCE * 86400, points: pts, source: "test" };
}

test("systematicsAwareFap: an FP that IS the coherent template has high FAP (declined)", () => {
  const ensemble: LightCurve[] = [];
  for (let i = 0; i < 20; i++) ensemble.push(mkCurve(coherentDip, 1000 + i));
  const candidate = ensemble[0]!;
  assert.ok(commonModeTemplate(ensemble).applied, "template should be applied on >= 8 same-cadence stars");

  const grid = { minPeriodDays: 4, maxPeriodDays: 6, oversample: 6, nDurations: 8 };
  const det = bls(preprocess(candidate, 0.5), grid);
  assert.ok(det.snr >= 7, `expected a strong (but instrumental) detection, got snr ${det.snr}`);

  const sig = systematicsAwareFap(candidate, det.snr, det.periodDays, ensemble, { seed: 7, nNull: 80 });
  assert.ok(sig.templateApplied, "systematics-aware path should be active (not noise-only fallback)");
  // The null literally contains the same coherent artifact, so the observed SNR is reproduced many times.
  assert.ok(sig.fapSys > 0.2, `instrumental FP should have high FAP under the systematic-aware null, got ${sig.fapSys}`);
});

test("systematicsAwareFap: a single star's planet survives (low FAP, not in template)", () => {
  // The discriminating property is template MEMBERSHIP: a signal present in the coherent ensemble median
  // (test 1) is reproduced by the null (high FAP), while a signal unique to one star -- diluted ~1/N out of
  // the median -- is absent from the template and cannot be reproduced (low FAP). Here the ensemble is quiet
  // so the template is ~flat; the candidate's own broad 3 d transit is the only structured signal and lives
  // in a single star, so it survives the systematics-aware null. Contrast with test 1 to see the mechanism.
  const ensemble: LightCurve[] = [];
  for (let i = 0; i < 19; i++) ensemble.push(mkCurve(() => 0, 2000 + i));
  const candidate = mkCurve(planetDip, 9999);
  ensemble.push(candidate); // include it so its transit is diluted ~1/N out of the median template

  assert.ok(commonModeTemplate(ensemble).applied, "template should be applied (>= 8 same-cadence stars)");

  const grid = { minPeriodDays: 2.8, maxPeriodDays: 3.2, oversample: 6, nDurations: 8 };
  const det = bls(preprocess(candidate, 0.5), grid);
  assert.ok(det.snr >= 7, `planet should be a strong detection, got snr ${det.snr}`);

  const sig = systematicsAwareFap(candidate, det.snr, det.periodDays, ensemble, {
    seed: 7, nNull: 80, minPeriodDays: 2.8, maxPeriodDays: 3.2,
  });
  assert.ok(sig.templateApplied, "systematics-aware path active");
  // The planet is unique to this star => absent from the template => nulls cannot reach its SNR => low FAP.
  assert.ok(sig.fapSys <= 0.1, `planet should have low systematics-aware FAP, got ${sig.fapSys}`);
});

test("systematicsAwareFap: noise-only fallback when ensemble < minStars (graceful)", () => {
  const small: LightCurve[] = [mkCurve(() => 0, 1), mkCurve(() => 0, 2), mkCurve(() => 0, 3)];
  const candidate = small[0]!;
  assert.ok(!commonModeTemplate(small, { minStars: 8 }).applied, "3 < minStars => template not applied");

  const grid = { minPeriodDays: 3.5, maxPeriodDays: 7.5, oversample: 6, nDurations: 8 };
  const snr = bls(candidate, grid).snr;
  const sig = systematicsAwareFap(candidate, snr, 5, small, { seed: 42, nNull: 60, minStars: 8 });
  assert.ok(!sig.templateApplied, "should flag the noise-only fallback honestly");
  assert.ok(sig.fapSys >= 0 && sig.fapSys <= 1, `FAP in [0,1], got ${sig.fapSys}`);
});

test("systematicsAwareFap: deterministic (same input bytes -> same output)", () => {
  const ensemble: LightCurve[] = [];
  for (let i = 0; i < 12; i++) ensemble.push(mkCurve(coherentDip, 3000 + i));
  const cand = ensemble[0]!;
  const snr = bls(cand, { minPeriodDays: 4, maxPeriodDays: 6, oversample: 6, nDurations: 8 }).snr;
  const a = systematicsAwareFap(cand, snr, 5, ensemble, { seed: 7, nNull: 80 });
  const b = systematicsAwareFap(cand, snr, 5, ensemble, { seed: 7, nNull: 80 });
  assert.equal(a.fapSys, b.fapSys);
  assert.equal(a.exceedances, b.exceedances);
  assert.equal(a.nNull, b.nNull);
});

test("systematicsAwareFap: a prebuilt template gives an identical result to building it internally", () => {
  const ensemble: LightCurve[] = [];
  for (let i = 0; i < 15; i++) ensemble.push(mkCurve(coherentDip, 4000 + i));
  const cand = ensemble[0]!;
  const snr = bls(preprocess(cand, 0.5), { minPeriodDays: 4, maxPeriodDays: 6, oversample: 6, nDurations: 8 }).snr;
  const internal = systematicsAwareFap(cand, snr, 5, ensemble, { seed: 7, nNull: 60 });
  const reused = systematicsAwareFap(cand, snr, 5, [], { seed: 7, nNull: 60, template: commonModeTemplate(ensemble) });
  assert.equal(reused.fapSys, internal.fapSys);
  assert.equal(reused.exceedances, internal.exceedances);
  assert.equal(reused.templateApplied, internal.templateApplied);
});

test("benjaminiHochberg: [0.001,0.002,0.5,0.6,0.9] q=0.1 rejects first 2", () => {
  const pvals = [0.001, 0.002, 0.5, 0.6, 0.9];
  const r = benjaminiHochberg(pvals, 0.1);
  assert.equal(r.nRejected, 2);
  assert.ok(r.rejected[0] === true);
  assert.ok(r.rejected[1] === true);
  assert.ok(r.rejected[2] === false);
  assert.equal(r.threshold, pvals[1]); // 0.002
});

test("benjaminiHochberg: rejects nothing when all p large (q=0.1)", () => {
  const pvals = [0.05, 0.06, 0.1, 0.2, 0.5];
  const r = benjaminiHochberg(pvals, 0.1);
  assert.equal(r.nRejected, 0);
  assert.equal(r.threshold, 0);
});

test("benjaminiHochberg: deterministic", () => {
  const pvals = [0.3, 0.001, 0.02, 0.5, 0.01];
  assert.deepEqual(benjaminiHochberg(pvals, 0.1), benjaminiHochberg(pvals, 0.1));
});

test("benjaminiHochberg: empty array -> nRejected=0", () => {
  const r = benjaminiHochberg([], 0.1);
  assert.equal(r.nRejected, 0);
  assert.equal(r.threshold, 0);
});

test("templateOnTimes: maps nearest bin within tolerance, gaps get zero", () => {
  const bins = [
    { time: T0, value: 0.001, nStars: 10 },
    { time: T0 + 1, value: -0.002, nStars: 10 },
    { time: T0 + 2, value: 0.0005, nStars: 10 },
  ];
  const t = [T0, T0 + 1, T0 + 1.5, T0 + 2, T0 + 3];
  const out = templateOnTimes(bins, t, 0.6);
  assert.equal(out[0], 0.001);
  assert.equal(out[1], -0.002);
  assert.equal(out[2], -0.002);
  assert.equal(out[3], 0.0005);
  assert.equal(out[4], 0);
});

test("templateOnTimes: empty bins -> all zeros", () => {
  const out = templateOnTimes([], [T0, T0 + 1], 0.001);
  assert.equal(out.length, 2);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
});
