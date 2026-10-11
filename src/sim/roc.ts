// Completeness / purity operating-characteristic curve (ROC) for the transit detector.
//
// This is the metric that makes a detection pipeline defensible: for a range of decision
// thresholds on the detection statistic (BLS SNR), we measure
//   - COMPLETENESS: of the injected planets, what fraction are recovered (peak period matches
//     truth within tolerance) AND have a statistic at/above the threshold; and
//   - FALSE-ALARM RATE: of ZERO-INJECTION pure-noise light curves (same cadence, baseline and
//     duty-cycle gaps, planet radius p=0 so no dip anywhere), what fraction still throw a BLS
//     peak at/above the threshold -- i.e. how often we would cry wolf.
//   - PURITY = TP / (TP + FP) at that threshold on the sampled equal-population sets: the
//     expected fraction of reported detections that are real.
//
// Injecting known planets and grading against the injected truth is NOT self-grading here:
// the detector never sees the truth -- it is used only AFTER the fact to label each trial as a
// true positive or a miss, and the false-alarm side is measured on genuinely planet-free noise.
// That is exactly what turns "we found a plausible dip" into "we know this pipeline recovers
// X% of planets at Y% false-alarm rate".
//
// Deterministic: every trial uses a seeded PRNG, so the curve is reproducible run to run.

import { preprocess } from "../detect/detrend.ts";
import { bls } from "../detect/bls.ts";
import { generateSyntheticTransit, rng } from "../data/synthetic.ts";
import { makeRedNoiseLightCurve } from "./redNoise.ts";
import { mainSequenceMassFromRadius } from "./transitModel.ts";

export interface RocOptions {
  nInjections?: number;
  nNoise?: number;
  seed?: number;
  thresholds?: number[]; // BLS-SNR decision thresholds to sweep
  minPeriodDays?: number;
  maxPeriodDays?: number;
  depthsPpm?: number[]; // pool of injected true depths
  noisePpm?: number;
  cadenceSec?: number;
  baselineDays?: number;
  periodTolPct?: number;
  /** AR(1) lag-1 autocorrelation for correlated (red) noise; 0 (default) = white, unchanged behaviour. */
  rho?: number;
}

export interface RocPoint {
  thresholdSnr: number;
  completeness: number; // recovered & >= threshold / nInjections
  falseAlarmRate: number; // noise peaks >= threshold / nNoise
  purity: number; // TP / (TP + FP) on the equal-population sample
  nTrue: number;
  nFalse: number;
}

/** Period match allowing the common aliases/harmonics; returns the matched factor or null. */
function matchFactor(rec: number, truth: number, tolPct: number): number | null {
  for (const f of [1, 0.5, 2, 1 / 3, 3, 2 / 3, 3 / 2, 1.5]) {
    if (Math.abs(rec * f - truth) / truth <= tolPct / 100) return f;
  }
  return null;
}

export interface RocResult {
  points: RocPoint[];
  nInjections: number;
  nNoise: number;
  /** AR(1) noise color used for the curves (0 = white). */
  rho: number;
  /** per-injection: did the BLS peak match the truth (threshold-independent), and its SNR. */
  injections: { matched: boolean; snr: number }[];
  /** per-noise-curve peak SNR (threshold-independent). */
  noiseSnr: number[];
}

/** Run the completeness/purity sweep. Pure and deterministic (seeded). */
export function runRoc(o: RocOptions = {}): RocResult {
  const nInj = Math.max(1, o.nInjections ?? 120);
  const nNoise = Math.max(1, o.nNoise ?? 120);
  const thresholds = o.thresholds ?? [5, 7, 9, 11, 13, 15];
  const minP = o.minPeriodDays ?? 1;
  const maxP = o.maxPeriodDays ?? 12;
  const depths = o.depthsPpm ?? [300, 500, 1000, 2000, 5000, 10000];
  const noisePpm = o.noisePpm ?? 200;
  const tol = o.periodTolPct ?? 2;
  const redRho = Math.min(0.95, Math.max(0, o.rho ?? 0));
  const grid = { minPeriodDays: minP * 0.7, maxPeriodDays: maxP * 1.4, oversample: 6, nDurations: 8 };

  const injRand = rng(o.seed ?? 20260011);

  // ---- injections: known planets, graded against truth after detection ----
  const injections: { matched: boolean; snr: number }[] = [];
  for (let i = 0; i < nInj; i++) {
    const periodDays = minP + injRand() * (maxP - minP);
    const depthPpm = depths[Math.floor(injRand() * depths.length)];
    const impactParam = injRand() * 0.6;
    const rsun = 0.7 + injRand() * 0.8;
    const { lc, truth } = redRho > 0
      ? {
          lc: makeRedNoiseLightCurve({
            seed: 50000 + i,
            periodDays,
            depthFrac: depthPpm * 1e-6,
            impactParam,
            stellarRadiusRsun: rsun,
            stellarMassMsun: mainSequenceMassFromRadius(rsun),
            noisePpm,
            rho: redRho,
            cadenceSec: o.cadenceSec ?? 120,
            baselineDays: o.baselineDays ?? 27,
            targetIdLabel: `ROC-INJ-${i}`,
          }),
          truth: { periodDays },
        }
      : generateSyntheticTransit({
          seed: 50000 + i,
          periodDays,
          depthFrac: depthPpm * 1e-6,
          impactParam,
          stellarRadiusRsun: rsun,
          stellarMassMsun: mainSequenceMassFromRadius(rsun),
          noisePpm,
          cadenceSec: o.cadenceSec ?? 120,
          baselineDays: o.baselineDays ?? 27,
          targetIdLabel: `ROC-INJ-${i}`,
        });
    let matched = false;
    let snr = 0;
    try {
      const clean = preprocess(lc, 0.5);
      const r = bls(clean, grid);
      snr = r.snr;
      matched = matchFactor(r.periodDays, truth.periodDays, tol) != null;
    } catch {
      /* detection threw -> a miss with zero statistic */
    }
    injections.push({ matched, snr });
  }

  // ---- zero-injection noise: same sampling, planet radius p = 0 (no dip anywhere) ----
  const noiseSnr: number[] = [];
  for (let j = 0; j < nNoise; j++) {
    const periodDays = minP + injRand() * (maxP - minP); // period is irrelevant at p=0, just varies the grid
    const rsun = 0.7 + injRand() * 0.8;
    const lc = redRho > 0
      ? makeRedNoiseLightCurve({
          seed: 90000 + j,
          periodDays,
          depthFrac: 0,
          impactParam: 0.3,
          stellarRadiusRsun: rsun,
          stellarMassMsun: mainSequenceMassFromRadius(rsun),
          noisePpm,
          rho: redRho,
          cadenceSec: o.cadenceSec ?? 120,
          baselineDays: o.baselineDays ?? 27,
          targetIdLabel: `ROC-NOISE-${j}`,
        })
      : generateSyntheticTransit({
          seed: 90000 + j,
          periodDays,
          depthFrac: 0, // <- no planet: pure noise + realistic gaps
          impactParam: 0.3,
          stellarRadiusRsun: rsun,
          stellarMassMsun: mainSequenceMassFromRadius(rsun),
          noisePpm,
          cadenceSec: o.cadenceSec ?? 120,
          baselineDays: o.baselineDays ?? 27,
          targetIdLabel: `ROC-NOISE-${j}`,
        }).lc;
    try {
      const clean = preprocess(lc, 0.5);
      noiseSnr.push(bls(clean, grid).snr);
    } catch {
      noiseSnr.push(0);
    }
  }

  const points: RocPoint[] = thresholds.map((thr) => {
    const nTrue = injections.filter((x) => x.matched && x.snr >= thr).length;
    const nFalse = noiseSnr.filter((s) => s >= thr).length;
    const completeness = nTrue / nInj;
    const falseAlarmRate = nFalse / nNoise;
    const denom = nTrue + nFalse;
    return {
      thresholdSnr: thr,
      completeness,
      falseAlarmRate,
      purity: denom > 0 ? nTrue / denom : 1,
      nTrue,
      nFalse,
    };
  });

  return { points, nInjections: nInj, nNoise, rho: redRho, injections, noiseSnr };
}

/** Render the ROC as an aligned ASCII table (for the benchmark script / method writeups). */
export function formatRoc(r: RocResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows = ["threshold(SNR)  completeness  false-alarm-rate  purity  TP/FP"];
  for (const p of r.points) {
    rows.push(
      `${p.thresholdSnr.toFixed(0).padStart(9)}      ${pct(p.completeness).padStart(9)}  ${pct(p.falseAlarmRate).padStart(13)}  ${pct(p.purity).padStart(6)}  ${p.nTrue}/${p.nFalse}`,
    );
  }
  return rows.join("\n");
}

/**
 * Calibrated empirical false-alarm probability of a single detection statistic, read off the
 * zero-injection noise distribution produced by runRoc: the fraction of planet-free curves whose
 * BLS peak SNR reaches `snr`. This is the false-alarm RATE at that threshold -- i.e. an empirical
 * FAP obtained WITHOUT running per-candidate surrogates (the noise ensemble IS the surrogate).
 * A Laplace +1 keeps a clean ensemble from reporting a literally-zero FAP. The resolution floor is
 * 1/(N+1), so a value at the floor means "no noise curve got this high", not "impossible".
 */
export function empiricalFap(noiseSnr: number[], snr: number): { fap: number; exceedances: number; n: number; floor: number } {
  const n = noiseSnr.length;
  if (n === 0) return { fap: 1, exceedances: 0, n: 0, floor: 1 };
  const exceedances = noiseSnr.filter((s) => s >= snr).length;
  const floor = 1 / (n + 1);
  const raw = (exceedances + 1) / (n + 1);
  return { fap: Math.min(1, Math.max(raw, floor)), exceedances, n, floor };
}
