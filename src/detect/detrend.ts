// Detrending + normalization for photometric light curves.
// anomaly-scout runs this before BLS so stellar variability / systematics
// don't masquerade as transits. Pure TS, no external deps.

import type { LightCurve, LightCurvePoint } from "../core/types.ts";

/** Median of a numeric array (copy-sorted). */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation -> robust sigma (scaled by 1.4826). */
export function madSigma(values: number[]): number {
  if (values.length === 0) return NaN;
  const med = median(values);
  const devs = values.map((v) => Math.abs(v - med));
  return 1.4826 * median(devs);
}

/** Normalize flux so the out-of-transit median is exactly 1.0. */
export function normalize(points: LightCurvePoint[]): LightCurvePoint[] {
  const med = median(points.map((p) => p.flux));
  if (!isFinite(med) || med === 0) return points.map((p) => ({ ...p }));
  return points.map((p) => ({
    time: p.time,
    flux: p.flux / med,
    fluxErr: p.fluxErr != null ? p.fluxErr / med : undefined,
  }));
}

/**
 * Moving-median baseline detrend using a time-based window.
 * A window much wider than a transit (hours) preserves transit dips
 * while removing longer-term stellar/systematic trends.
 */
export function detrendMedian(
  points: LightCurvePoint[],
  windowDays: number,
): LightCurvePoint[] {
  if (points.length < 8) return points.map((p) => ({ ...p }));
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const n = sorted.length;
  const half = Math.max(1, Math.floor(n * 0.02)); // fallback sample window
  const out: LightCurvePoint[] = new Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const tMin = sorted[i].time - windowDays / 2;
    const tMax = sorted[i].time + windowDays / 2;
    while (lo < n && sorted[lo].time < tMin) lo++;
    while (hi < n && sorted[hi].time <= tMax) hi++;
    let window: number[];
    if (hi - lo >= 5) {
      window = sorted.slice(lo, hi).map((p) => p.flux);
    } else {
      const a = Math.max(0, i - half);
      const b = Math.min(n, i + half + 1);
      window = sorted.slice(a, b).map((p) => p.flux);
    }
    const base = median(window);
    out[i] = {
      time: sorted[i].time,
      flux: base !== 0 ? sorted[i].flux / base : sorted[i].flux,
      fluxErr: sorted[i].fluxErr,
    };
  }
  return out;
}

/**
 * Iterative sigma-clipping of positive outliers (cosmic rays / flares).
 * Returns a new array with outliers removed. Negative dips (transits)
 * are preserved because we clip asymmetrically.
 */
export function sigmaClipOutliers(
  points: LightCurvePoint[],
  sigma = 5,
  iters = 3,
): LightCurvePoint[] {
  let cur = points.map((p) => ({ ...p }));
  for (let k = 0; k < iters; k++) {
    if (cur.length < 10) break;
    const med = median(cur.map((p) => p.flux));
    const sig = madSigma(cur.map((p) => p.flux));
    if (!isFinite(sig) || sig === 0) break;
    const next = cur.filter((p) => p.flux - med < sigma * sig);
    if (next.length === cur.length) break;
    cur = next;
  }
  return cur;
}

/** Full preprocessing: normalize -> detrend -> clip -> re-normalize. */
export function preprocess(lc: LightCurve, windowDays = 0.5): LightCurve {
  const norm = normalize(lc.points);
  const detrended = detrendMedian(norm, windowDays);
  const clipped = sigmaClipOutliers(detrended, 5, 3);
  const renorm = normalize(clipped);
  return { ...lc, points: renorm };
}
