// Per-candidate calibrated significance.
//
// The production detector used a single global BLS-SNR cut. Our own measurement (npm run p1:rho)
// showed real TESS-SPOC residual noise COLOR varies star-to-star: quiet old hosts are ~white
// (rho ~ 0) while young active hosts are strongly correlated (rho ~ 0.63). A fixed SNR threshold
// is therefore provably not a fixed FALSE-ALARM probability -- the same SNR=7 means different
// significance depending on the noise color. The principled fix is to calibrate EACH candidate
// against nulls drawn from ITS OWN noise: estimate rho and the residual scatter from the target's
// light curve, generate planet-free nulls at that color/sampling, and report the empirical
// false-alarm probability (the fraction of nulls whose BLS peak reaches the observed one).
//
// Deterministic: estimateRho and the null ensemble use fixed seeds and pure functions of the input
// flux, so the same light-curve bytes always yield the same significance -- the same guarantee the
// pixel vetting already relies on for the money-path.

import type { LightCurve } from "../core/types.ts";
import { preprocess } from "./detrend.ts";
import { bls } from "./bls.ts";
import { makeRedNoiseLightCurve, estimateRho, detrendMovingMedian } from "../sim/redNoise.ts";
import { empiricalFap } from "../sim/roc.ts";

export interface SignificanceOptions {
  nNull?: number; // null ensemble size (default 120 -> resolution floor 1/(nNull+1) ~ 0.008)
  seed?: number; // fixed -> deterministic
  minPeriodDays?: number;
  maxPeriodDays?: number;
}

export interface CalibratedSignificance {
  snr: number; // observed candidate BLS SNR
  rho: number; // lag-1 autocorrelation estimated from this target's own residuals
  noisePpm: number; // residual scatter estimated from this target
  fap: number; // empirical false-alarm probability of `snr` under THIS noise color
  exceedances: number; // nulls that reached the observed SNR
  nNull: number;
}

/** Robust residual scatter (ppm) of a light curve after a moving-median detrend + MAD. */
function residualScatterPpm(flux: number[]): number {
  const resid = detrendMovingMedian(flux, 15);
  const finite = resid.filter((v) => Number.isFinite(v));
  if (finite.length < 10) return 200;
  const sorted = [...finite].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const devs = finite.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = (devs[devs.length >> 1] || 1) * 1.4826;
  return Math.max(20, Math.min(5000, mad * 1e6));
}

/**
 * Calibrate one candidate's BLS SNR against a null ensemble matched to the target's OWN noise color.
 * `observedSnr` is the candidate's detection SNR; the FAP is how often planet-free light of the same
 * rho/scatter/sampling reaches it. Returns rho + fap. Too-short curves fall back to a white (rho=0)
 * null ensemble.
 */
export function calibratedFap(
  lc: LightCurve,
  observedSnr: number,
  periodDays: number,
  opts?: SignificanceOptions,
): CalibratedSignificance {
  const nNull = opts?.nNull ?? 120;
  const seed = opts?.seed ?? 4242;
  const flux = lc.points.map((p) => p.flux);
  const finite = flux.filter((v) => Number.isFinite(v));

  const rhoRaw = estimateRho(flux);
  const rho = Number.isFinite(rhoRaw) ? Math.max(0, Math.min(0.9, rhoRaw)) : 0;
  const noisePpm = residualScatterPpm(flux);

  const cadenceSec = lc.cadenceSec && lc.cadenceSec > 0 ? lc.cadenceSec : 120;
  const spanDays = finite.length > 1 ? (lc.points[lc.points.length - 1].time - lc.points[0].time) : 15;
  const baselineDays = Math.max(2, spanDays);
  const idealSlots = Math.floor((baselineDays * 86400) / cadenceSec);
  const dutyCycle = Math.max(0.5, Math.min(1, finite.length / Math.max(1, idealSlots)));

  const minP = opts?.minPeriodDays ?? Math.max(0.5, periodDays * 0.7);
  const maxP = opts?.maxPeriodDays ?? periodDays * 1.5;
  const grid = { minPeriodDays: minP, maxPeriodDays: maxP, oversample: 6, nDurations: 8 };

  const nullSnr: number[] = [];
  for (let j = 0; j < nNull; j++) {
    // planet-free null (depthFrac 0) at the SAME noise color, scatter, cadence and sampling density
    const nullLc = makeRedNoiseLightCurve({
      seed: seed + j,
      periodDays, // irrelevant at p=0 (no dip); sets only the grid center
      depthFrac: 0,
      noisePpm,
      rho,
      cadenceSec,
      baselineDays,
      dutyCycle,
      targetIdLabel: `NULL-${j}`,
    });
    try {
      nullSnr.push(bls(preprocess(nullLc, 0.5), grid).snr);
    } catch {
      /* a null that throws counts as a zero-statistic curve */
    }
  }

  const { fap, exceedances } = empiricalFap(nullSnr, observedSnr);
  return { snr: observedSnr, rho, noisePpm, fap, exceedances, nNull: nullSnr.length };
}
