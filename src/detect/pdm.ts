// PHASE DISPERSION MINIMIZATION (PDM) -- an INDEPENDENT, non-parametric period finder (Stellingwerf 1978).
//
// WHY THIS EXISTS. Every detector in this repo so far is in the BOX-FIT family: bls.ts and iterative.ts both
// score a trial period by fitting a rectangular box to the phase-folded curve and maximizing the box depth /
// SNR. Problem-3 of the roadmap asks for INDEPENDENT validation, and the strongest cheap independence is a
// DIFFERENT ALGORITHM, not a different copy of the same one. PDM shares no machinery with BLS: it never fits a
// box or a transit model. For each trial period it folds the curve into phase bins and measures how much of the
// total variance is left WITHIN bins; a true period lines the transits up so the within-bin scatter collapses and
// the statistic theta = (within-bin variance) / (total variance) dips well below 1, while a wrong period leaves
// theta ~ 1. Because it is shape-agnostic it is sensitive to non-box-like dips too, and because it is a completely
// separate estimator, agreement between PDM and BLS on a real curve is real corroboration rather than a tautology.
//
// This is a PURE, DETERMINISTIC, RESEARCH-ONLY module. The worker never imports it, so it cannot touch a verdict /
// bundle hash / money path. It never mutates its input. scripts/p35 measures PDM-vs-BLS agreement and PDM
// injection-recovery completeness on real photometry -- the number is measured, never asserted.
//
// HONEST SCOPE. Like any periodogram, PDM has harmonic ambiguity: a signal at P also folds coherently at P/2, 2P,
// P/3, ... so the global theta minimum can land on a low-order harmonic of the true period. This module returns the
// raw global minimum and the full theta curve; disambiguating the harmonic is the caller's job (the same alias set
// isAliasOf/resolvePeriodAlias use elsewhere). PDM is a cross-check and a period FINDER, not a depth estimator --
// it says nothing about transit depth or planet plausibility.

import type { LightCurve } from "../core/types.ts";

export interface PdmOptions {
  /** Shortest trial period, in days (inclusive). */
  minPeriodDays: number;
  /** Longest trial period, in days (inclusive). */
  maxPeriodDays: number;
  /** Number of phase bins the fold is divided into (default 12; Stellingwerf's typical 10-20). */
  bins?: number;
  /** Frequency-grid oversampling: df = 1 / (oversample * baseline) (default 10). */
  oversample?: number;
  /** Fold epoch reference in the same time units as the data (default: the earliest finite time). */
  tRefBjd?: number;
}

export interface PdmResult {
  /** Period (days) at the global theta minimum, or NaN if the curve is too short / constant. */
  periodDays: number;
  /** The minimum theta (within-bin variance / total variance). ~1 = no periodic structure; <<1 = strong. */
  theta: number;
  /** The full trial-period grid (days), aligned with `thetas`. */
  periods: number[];
  /** theta at each grid period, aligned with `periods`. */
  thetas: number[];
  /** Count of finite (time, flux) pairs actually used. */
  nPoints: number;
  /** Length of the trial grid that produced a usable theta. */
  nGrid: number;
}

const TRIVIAL = (nPoints: number): PdmResult => ({ periodDays: NaN, theta: NaN, periods: [], thetas: [], nPoints, nGrid: 0 });

/**
 * Phase Dispersion Minimization on raw (times, flux) arrays. Folds each trial period into `bins` phase bins and
 * returns theta = [ sum_b (sumsq_b - sum_b^2 / n_b) / (N - M) ] / [ SST / (N - 1) ], minimized over a frequency
 * grid df = 1 / (oversample * baseline). Pure and deterministic (no randomness, no input mutation).
 */
export function pdm(times: number[], flux: number[], opts: PdmOptions): PdmResult {
  const bins = Math.max(2, Math.round(opts.bins ?? 12));
  const oversample = Math.max(1, opts.oversample ?? 10);

  // Keep only finite pairs; carry them in parallel arrays for the hot loop.
  const t: number[] = [];
  const f: number[] = [];
  const n = Math.min(times.length, flux.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(times[i]) && Number.isFinite(flux[i])) {
      t.push(times[i]);
      f.push(flux[i]);
    }
  }
  const N = t.length;
  if (N < Math.max(20, 3 * bins)) return TRIVIAL(N);
  if (!(opts.minPeriodDays > 0) || !(opts.maxPeriodDays > opts.minPeriodDays)) return TRIVIAL(N);

  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < N; i++) {
    if (t[i] < tMin) tMin = t[i];
    if (t[i] > tMax) tMax = t[i];
  }
  const baseline = tMax - tMin;
  if (!(baseline > 0)) return TRIVIAL(N);
  const tRef = Number.isFinite(opts.tRefBjd) ? (opts.tRefBjd as number) : tMin;

  // Total variance (the denominator of theta), computed once.
  let mean = 0;
  for (let i = 0; i < N; i++) mean += f[i];
  mean /= N;
  let sst = 0;
  for (let i = 0; i < N; i++) sst += (f[i] - mean) * (f[i] - mean);
  const s2 = sst / (N - 1);
  if (!(s2 > 0)) return { ...TRIVIAL(N), theta: 1 }; // constant flux: no variance to disperse

  const fMin = 1 / opts.maxPeriodDays;
  const fMax = 1 / opts.minPeriodDays;
  const df = 1 / (oversample * baseline);
  if (!(df > 0) || !(fMax > fMin)) return TRIVIAL(N);

  const periods: number[] = [];
  const thetas: number[] = [];
  const binSum = new Float64Array(bins);
  const binSq = new Float64Array(bins);
  const binN = new Int32Array(bins);

  for (let fr = fMin; fr <= fMax; fr += df) {
    const P = 1 / fr;
    binSum.fill(0);
    binSq.fill(0);
    binN.fill(0);
    for (let i = 0; i < N; i++) {
      let ph = ((t[i] - tRef) / P) % 1;
      if (ph < 0) ph += 1;
      let b = Math.floor(ph * bins);
      if (b >= bins) b = bins - 1;
      binSum[b] += f[i];
      binSq[b] += f[i] * f[i];
      binN[b]++;
    }
    let ssw = 0;
    let mUsed = 0;
    for (let b = 0; b < bins; b++) {
      const nb = binN[b];
      if (nb > 0) {
        mUsed++;
        ssw += binSq[b] - (binSum[b] * binSum[b]) / nb;
      }
    }
    if (N - mUsed <= 0) continue;
    periods.push(P);
    thetas.push(ssw / (N - mUsed) / s2);
  }
  if (!periods.length) return TRIVIAL(N);

  let best = 0;
  for (let i = 1; i < thetas.length; i++) if (thetas[i] < thetas[best]) best = i;
  return { periodDays: periods[best], theta: thetas[best], periods, thetas, nPoints: N, nGrid: periods.length };
}

/** Convenience wrapper: run PDM on a LightCurve's finite (time, flux) points. */
export function pdmOnLightCurve(lc: LightCurve, opts: PdmOptions): PdmResult {
  return pdm(
    lc.points.map((p) => p.time),
    lc.points.map((p) => p.flux),
    opts,
  );
}
