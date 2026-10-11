// Bootstrap parameter uncertainty for a detection: confidence intervals on period and depth.
//
// The pipeline reports a point estimate (period, depth, SNR) but not how well those are constrained.
// A survey result needs an error bar. We use a residual block bootstrap: subtract a box transit model
// at the fitted parameters, resample the residuals in CONTIGUOUS BLOCKS (which preserves the real,
// time-correlated/red noise structure -- a plain iid resample would understate the period error on
// red-noise stars), rebuild synthetic curves, refit the period with BLS (and the depth from the folded
// median dip), and take the 16/50/84 percentiles as the interval. Deterministic given the seed; used
// only by the uncertainty CLI and tests, never in the runtime pipeline, so no bundle hash changes.

import type { LightCurve, TransitCandidate } from "../core/types.ts";
import { preprocess } from "./detrend.ts";
import { bls } from "./bls.ts";

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

function quantile(sorted: number[], f: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(f * sorted.length)));
  return sorted[i];
}

/** Box model: 1 - depth inside [phase window], else 1, given candidate ephemeris. */
function boxModel(cand: TransitCandidate): (t: number) => number {
  const halfDurDays = cand.durationHours / 24 / 2;
  return (t: number) => {
    let phase = ((t - cand.epochBjd) / cand.periodDays) % 1;
    if (phase < 0) phase += 1;
    if (phase > 0.5) phase -= 1; // center on 0
    return Math.abs(phase) * cand.periodDays <= halfDurDays ? 1 - cand.depthFrac : 1;
  };
}

export interface UncertaintyOptions {
  bootstraps?: number; // default 200
  blockLength?: number; // contiguous residual block size (default 8 cadences)
  seed?: number;
}

export interface ParameterUncertainty {
  periodDays: number;
  periodCI: [number, number]; // 16/84 percentile
  periodSigma: number; // std of the bootstrap period distribution
  depthFrac: number;
  depthCI: [number, number];
  nBootstrap: number;
}

/**
 * Residual block-bootstrap CI on the fitted period and depth. `lc` should be the light curve the
 * candidate was detected on. Returns NaN intervals if too few points survive.
 */
export function bootstrapUncertainty(
  lc: LightCurve,
  cand: TransitCandidate,
  opts?: UncertaintyOptions,
): ParameterUncertainty {
  const B = opts?.bootstraps ?? 200;
  const blk = Math.max(2, opts?.blockLength ?? 8);
  const rand = mulberry32(opts?.seed ?? 9090);

  const clean = preprocess(lc, 0.5);
  const n = clean.points.length;
  const model = boxModel(cand);
  const resid = clean.points.map((p) => p.flux - model(p.time)); // data - fitted box
  if (n < 40) {
    return { periodDays: cand.periodDays, periodCI: [NaN, NaN], periodSigma: NaN, depthFrac: cand.depthFrac, depthCI: [NaN, NaN], nBootstrap: 0 };
  }

  const grid = { minPeriodDays: Math.max(0.5, cand.periodDays * 0.8), maxPeriodDays: cand.periodDays * 1.25, oversample: 8, nDurations: 8 };
  const periods: number[] = [];
  const depths: number[] = [];

  for (let b = 0; b < B; b++) {
    // build one bootstrap curve by walking blocks of residuals (circular block bootstrap keeps the
    // noise color; sampling blocks not single points avoids whitening the red noise)
    const points: { time: number; flux: number; fluxErr: number }[] = new Array(n);
    let i = 0;
    while (i < n) {
      const start = Math.floor(rand() * n);
      for (let k = 0; k < blk && i < n; k++, i++) {
        const r = resid[(start + k) % n] ?? 0;
        const cp = clean.points[i]!;
        points[i] = { time: cp.time, flux: model(cp.time) + r, fluxErr: cp.fluxErr ?? 0 };
      }
    }
    const synth: LightCurve = { targetId: cand.targetId, mission: clean.mission, cadenceSec: clean.cadenceSec, points, source: clean.source };
    try {
      const fit = bls(preprocess(synth, 0.5), grid);
      periods.push(fit.periodDays);
      // depth from the folded median dip at the (re)fitted period
      const m = boxModel({ ...cand, periodDays: fit.periodDays });
      let inSum = 0;
      let inN = 0;
      let outSum = 0;
      let outN = 0;
      for (const p of synth.points) {
        if (m(p.time) < 1) { inSum += p.flux; inN++; } else { outSum += p.flux; outN++; }
      }
      if (inN >= 3 && outN >= 3) depths.push(Math.max(0, outSum / outN - inSum / inN));
    } catch { /* a bootstrap that fails to fit is skipped */ }
  }

  const ps = [...periods].sort((a, b) => a - b);
  const ds = [...depths].sort((a, b) => a - b);
  const meanP = ps.reduce((a, b) => a + b, 0) / (ps.length || 1);
  const varP = ps.reduce((a, b) => a + (b - meanP) * (b - meanP), 0) / (ps.length || 1);
  return {
    periodDays: cand.periodDays,
    periodCI: [quantile(ps, 0.16), quantile(ps, 0.84)],
    periodSigma: Math.sqrt(varP),
    depthFrac: cand.depthFrac,
    depthCI: [quantile(ds, 0.16), quantile(ds, 0.84)],
    nBootstrap: ps.length,
  };
}
