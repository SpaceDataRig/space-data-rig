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
  /**
   * Cost guard. When the curve has more than `maxPoints` samples it is bin-averaged down to about
   * that many before BOTH the observed statistic and the null ensemble are computed, so they share
   * one coarser cadence and the FAP stays apples-to-apples. Undefined (default) = full resolution,
   * the certified behaviour for real SPOC photometry. A ~2500-point bin keeps one candidate's
   * ensemble near ~3s instead of ~150s at TESS 2-min cadence over a 27-day sector, which is what
   * lets the gate run on the offline/edge synthetic default path at all. The ensemble floor
   * 1/(nNull+1) must stay well under the critic threshold; with nNull=60 it is 0.0164 < 0.05.
   */
  maxPoints?: number;
}

/**
 * Bin-average a light curve in TIME down to <= maxPoints. Averaging (not decimation) preserves the
 * transit depth, and because the observed BLS statistic is recomputed on THIS binned curve -- the
 * same cadence the nulls are drawn at -- the empirical FAP compares like with like. Bins carry a
 * constant flux error so the observed curve is uniform-weighted exactly like the constant-error
 * null ensemble. Pure + deterministic; returns the input unchanged when it already fits.
 */
export function downsampleBinned(lc: LightCurve, maxPoints: number): LightCurve {
  const n = lc.points.length;
  if (!Number.isFinite(maxPoints) || maxPoints <= 0 || n <= maxPoints) return lc;
  const k = Math.ceil(n / maxPoints);
  // one representative constant error for every bin (median input error shrunk by sqrt(k))
  const errs = lc.points.map((p) => p.fluxErr).filter((e): e is number => typeof e === "number" && e > 0).sort((a, b) => a - b);
  const medErr = errs.length ? errs[errs.length >> 1] : 0;
  const binErr = medErr > 0 ? medErr / Math.sqrt(k) : 0;
  const pts: { time: number; flux: number; fluxErr: number }[] = [];
  for (let i = 0; i < n; i += k) {
    let st = 0;
    let sf = 0;
    let m = 0;
    for (let j = i; j < Math.min(n, i + k); j++) {
      const p = lc.points[j];
      if (!p || !Number.isFinite(p.time) || !Number.isFinite(p.flux)) continue;
      st += p.time;
      sf += p.flux;
      m++;
    }
    if (m === 0) continue;
    pts.push({ time: st / m, flux: sf / m, fluxErr: binErr });
  }
  return { ...lc, cadenceSec: (lc.cadenceSec ?? 120) * k, points: pts };
}

export interface CalibratedSignificance {
  snr: number; // observed candidate BLS SNR (recomputed on the binned curve when downsampled)
  rho: number; // lag-1 autocorrelation estimated from this target's own residuals
  noisePpm: number; // residual scatter estimated from this target
  fap: number; // empirical false-alarm probability of `snr` under THIS noise color
  exceedances: number; // nulls that reached the observed SNR
  nNull: number;
  /** true when the cost guard binned the curve; the reported snr is then the binned-cadence value. */
  downsampled: boolean;
  workingPoints: number; // points actually used for the observed statistic + nulls
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
  const maxPoints = opts?.maxPoints;
  // Cost guard: bin down for BOTH the observed statistic and the nulls so they share one cadence.
  const working = maxPoints != null ? downsampleBinned(lc, maxPoints) : lc;
  const downsampled = working.points.length !== lc.points.length;

  // Estimate the noise color at the resolution the nulls are GENERATED at. When the cost guard bins
  // the curve, box-averaging crushes the measured lag-1 autocorrelation (a true rho=0.5 host reads
  // ~0.05 after 8x binning), so estimating on the binned curve would make the null ensemble far too
  // WHITE and let red-noise false alarms through (measured: 13% null acceptance vs the nominal 5%).
  // Instead we estimate rho/scatter at NATIVE cadence, build each null at native cadence, then bin it
  // with the SAME downsampleBinned the observed curve went through -- so observed and null are
  // identically distributed and the empirical FAP stays honest. At full resolution (no maxPoints)
  // `gen` IS `working`, and every line below is byte-for-byte the certified real-photometry path.
  const gen = downsampled ? lc : working;
  const genFlux = gen.points.map((p) => p.flux);
  const genFinite = genFlux.filter((v) => Number.isFinite(v));

  const rhoRaw = estimateRho(genFlux);
  const rho = Number.isFinite(rhoRaw) ? Math.max(0, Math.min(0.9, rhoRaw)) : 0;
  const noisePpm = residualScatterPpm(genFlux);

  const cadenceSec = gen.cadenceSec && gen.cadenceSec > 0 ? gen.cadenceSec : 120;
  const spanDays = genFinite.length > 1 ? (gen.points[gen.points.length - 1]!.time - gen.points[0]!.time) : 15;
  const baselineDays = Math.max(2, spanDays);
  const idealSlots = Math.floor((baselineDays * 86400) / cadenceSec);
  const dutyCycle = Math.max(0.5, Math.min(1, genFinite.length / Math.max(1, idealSlots)));

  const minP = opts?.minPeriodDays ?? Math.max(0.5, periodDays * 0.7);
  const maxP = opts?.maxPeriodDays ?? periodDays * 1.5;
  const grid = { minPeriodDays: minP, maxPeriodDays: maxP, oversample: 6, nDurations: 8 };

  // Observed statistic: when the curve was binned, RECOMPUTE the peak on the binned curve with the
  // SAME grid the nulls use, so the comparison is at one matched cadence. At full resolution the
  // caller's detection SNR is used unchanged (the certified real-photometry behaviour).
  let snrObs = observedSnr;
  if (downsampled) {
    try {
      snrObs = bls(preprocess(working, 0.5), grid).snr;
    } catch {
      snrObs = observedSnr; // a degenerate binned curve falls back to the caller's statistic
    }
  }

  const nullSnr: number[] = [];
  for (let j = 0; j < nNull; j++) {
    // planet-free null (depthFrac 0) at the SAME native noise color, scatter, cadence and sampling
    let nullLc = makeRedNoiseLightCurve({
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
    // put the null through the SAME binning the observed curve went through, so both are measured
    // at one matched cadence with one matched (binning-shaped) noise structure
    if (downsampled && maxPoints != null) nullLc = downsampleBinned(nullLc, maxPoints);
    try {
      nullSnr.push(bls(preprocess(nullLc, 0.5), grid).snr);
    } catch {
      /* a null that throws counts as a zero-statistic curve */
    }
  }

  const { fap, exceedances } = empiricalFap(nullSnr, snrObs);
  return { snr: snrObs, rho, noisePpm, fap, exceedances, nNull: nullSnr.length, downsampled, workingPoints: working.points.length };
}
