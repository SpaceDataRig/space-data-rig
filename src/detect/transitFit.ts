// Exact limb-darkened transit FIT: recover depth (Rp/Rs), shape (impact parameter b) and a
// small timing offset from a folded light curve by least-squares fitting the physically exact
// occultation model (./exactTransit.ts). Additive, pure and deterministic -- used by the depth
// cross-validation CLIs (scripts/p9-exact-depth.ts, p11) and their tests, and now reachable in the
// worker ONLY through perSectorRun behind env.PERSECTOR (default OFF). With that flag unset the
// runtime never calls it, so the run path and its bundle hash are unchanged.
//
// Why fit the exact model instead of trusting the BLS box depth: the BLS best-fit box averages
// over its window, so on real TESS cadences (2-min) a short transit is diluted by the partial
// ingress/egress bins and by box/true-duration mismatch -- the blind TOI survey (p7) measured
// the box depth sitting a median ~26% off the reported depth. A forward model of the actual
// transit SHAPE does not have that bias: it fits the flat bottom and the V of the egress, so it
// can recover the true depth, and additionally constrain the impact parameter b (the shape),
// which a box cannot. Here b and the timing offset are free; aOverRs is fixed from Kepler (the
// catalog stellar mass/radius and period), which collapses the fit to a well-posed 3-parameter
// problem and keeps it stable on one-sector cadences.
//
// The grid search is coarse-to-fine and evaluates only the points inside the transit window, so
// it is fast enough to run over tens of real targets while remaining fully deterministic (no RNG).

import { exactTransitFlux, separationCircular, type LdQuadratic } from "../sim/exactTransit.ts";

export interface FoldedPoint {
  phase: number; // in [-0.5, 0.5], centered on inferior conjunction (transit midpoint at 0)
  flux: number; // normalized relative flux
}

/** Fold (time, flux) onto orbital phase centered on 0 given an ephemeris. Deterministic. */
export function foldAtPhase(
  times: number[],
  flux: number[],
  periodDays: number,
  t0Bjd: number,
): FoldedPoint[] {
  const out: FoldedPoint[] = new Array(times.length);
  for (let i = 0; i < times.length; i++) {
    let ph = ((times[i] - t0Bjd) / periodDays) % 1;
    if (ph < 0) ph += 1;
    if (ph > 0.5) ph -= 1; // map to [-0.5, 0.5], transit center at 0
    out[i] = { phase: ph, flux: flux[i] };
  }
  out.sort((a, b) => a.phase - b.phase);
  return out;
}

export interface ExactFitOptions {
  /** Semi-major axis in stellar radii, fixed from Kepler + catalog stellar params. */
  aOverRs: number;
  /** Quadratic limb-darkening coefficients (default a solar-ish {u1:0.4,u2:0.1}). */
  u1?: number;
  u2?: number;
  /** Radius-ratio search bounds (default 0.006..0.25). */
  pMin?: number;
  pMax?: number;
  /** Half-width of the transit-center timing search, in phase cycles (default 0.01). */
  t0Window?: number;
  /** Simpson grid for the exact model (default 600; even). */
  simpsonN?: number;
}

export interface ExactFitResult {
  radiusRatio: number; // p = Rp/Rs at the best fit
  depthFrac: number; // fitted observable transit depth = 1 - model flux at conjunction
  impactParam: number; // b at the best fit
  t0OffsetPhase: number; // best-fit transit-center offset in phase cycles
  rms: number; // RMS of (data - model) over the in-window points
  nInWindow: number; // number of folded points used in the fit
  nTransit: number; // folded points inside the best-fit transit (drive the depth precision)
  depthSigma: number; // first-order 1-sigma on depthFrac from the point-to-point scatter
  baseline: number; // robust out-of-transit baseline the data were normalized to
  ld: LdQuadratic;
  aOverRs: number;
}

/** Robust baseline = median flux of points far from transit (|phase| > 0.15), else overall median. */
function baselineOf(folded: FoldedPoint[]): number {
  const far = folded.filter((p) => Math.abs(p.phase) > 0.15).map((p) => p.flux);
  const pool = far.length >= 10 ? far : folded.map((p) => p.flux);
  if (!pool.length) return 1;
  const s = [...pool].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Half-duration in phase cycles for the widest plausible transit, plus timing/search margin. */
function windowCycles(aOverRs: number, pMax: number, t0Window: number): number {
  const arg = Math.min(1, Math.sqrt(Math.max(0, (1 + pMax) ** 2)) / Math.max(1e-6, aOverRs));
  const halfDur = Math.asin(arg) / Math.PI; // (1/pi) * arcsin((1+p)/aRs), in cycles
  return Math.min(0.4, Math.max(0.02, halfDur * 1.6 + t0Window + 0.01));
}

function medianAbsDev(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Evaluate sum of squared residuals of the exact model (1 - flux) against the folded data. */
function sseFor(
  pts: FoldedPoint[],
  p: number,
  b: number,
  dt0: number,
  aOverRs: number,
  ld: LdQuadratic,
  n: number,
): number {
  let sse = 0;
  for (const pt of pts) {
    const z = separationCircular(pt.phase - dt0, aOverRs, b);
    const model = exactTransitFlux(z, p, ld, n);
    const d = pt.flux - model;
    sse += d * d;
  }
  return sse;
}

/**
 * Fit the exact limb-darkened transit model to a folded curve. aOverRs is fixed; p, b and a small
 * timing offset are searched (coarse grid then a refinement around the best cell). Returns NaN
 * fields if too few points fall in the transit window to constrain the shape.
 */
export function fitExactTransit(
  folded: FoldedPoint[],
  opts: ExactFitOptions,
): ExactFitResult {
  const ld: LdQuadratic = { u1: opts.u1 ?? 0.4, u2: opts.u2 ?? 0.1 };
  const aOverRs = opts.aOverRs;
  const pMin = opts.pMin ?? 0.006;
  const pMax = opts.pMax ?? 0.25;
  const t0Window = opts.t0Window ?? 0.01;
  const n = opts.simpsonN ?? 600;

  const baseline = baselineOf(folded);
  // normalize to the robust baseline so out-of-transit sits at 1.0 (the model convention)
  const pts0 = folded.map((p) => ({ phase: p.phase, flux: p.flux / baseline }));
  const win = windowCycles(aOverRs, pMax, t0Window);
  const inWin = pts0.filter((p) => Math.abs(p.phase) <= win && Number.isFinite(p.flux));
  if (inWin.length < 4) {
    return {
      radiusRatio: NaN, depthFrac: NaN, impactParam: NaN, t0OffsetPhase: NaN,
      rms: NaN, nInWindow: inWin.length, nTransit: 0, depthSigma: NaN, baseline, ld, aOverRs,
    };
  }

  // coarse grid: log-spaced p, linear b, linear dt0
  const P_COARSE = 22;
  const B_COARSE = 8;
  const T_COARSE = 5;
  let best = { p: NaN, b: NaN, dt0: NaN, sse: Infinity };
  for (let ip = 0; ip < P_COARSE; ip++) {
    const p = pMin * Math.pow(pMax / pMin, ip / (P_COARSE - 1));
    for (let ib = 0; ib < B_COARSE; ib++) {
      const b = (ib / (B_COARSE - 1)) * 0.95;
      for (let it = 0; it < T_COARSE; it++) {
        const dt0 = -t0Window + (2 * t0Window * it) / (T_COARSE - 1);
        const sse = sseFor(inWin, p, b, dt0, aOverRs, ld, n);
        if (sse < best.sse) best = { p, b, dt0, sse };
      }
    }
  }
  if (!Number.isFinite(best.p)) {
    return {
      radiusRatio: NaN, depthFrac: NaN, impactParam: NaN, t0OffsetPhase: NaN,
      rms: NaN, nInWindow: inWin.length, nTransit: 0, depthSigma: NaN, baseline, ld, aOverRs,
    };
  }

  // refine around the best coarse cell (p +- ~26% geometric, b +- one step, dt0 +- half step)
  const pLo = best.p / Math.pow(pMax / pMin, 1 / (P_COARSE - 1));
  const pHi = best.p * Math.pow(pMax / pMin, 1 / (P_COARSE - 1));
  const bStep = 0.95 / (B_COARSE - 1);
  const bLo = Math.max(0, best.b - bStep);
  const bHi = Math.min(0.98, best.b + bStep);
  const tStep = (2 * t0Window) / (T_COARSE - 1);
  const P_FINE = 14;
  const B_FINE = 10;
  const T_FINE = 9;
  for (let ip = 0; ip < P_FINE; ip++) {
    const p = pLo * Math.pow(pHi / pLo, ip / (P_FINE - 1));
    for (let ib = 0; ib < B_FINE; ib++) {
      const b = bLo + ((bHi - bLo) * ib) / (B_FINE - 1);
      for (let it = 0; it < T_FINE; it++) {
        const dt0 = best.dt0 - tStep + ((2 * tStep) * it) / (T_FINE - 1);
        const sse = sseFor(inWin, p, b, dt0, aOverRs, ld, n);
        if (sse < best.sse) best = { p, b, dt0, sse };
      }
    }
  }

  // residual RMS and the fitted observable depth at conjunction (min separation = b)
  let sse = 0;
  const resid: number[] = [];
  for (const pt of inWin) {
    const z = separationCircular(pt.phase - best.dt0, aOverRs, best.b);
    const model = exactTransitFlux(z, best.p, ld, n);
    const d = pt.flux - model;
    sse += d * d;
    resid.push(Math.abs(d));
  }
  const rms = Math.sqrt(sse / inWin.length);
  const depthFrac = 1 - exactTransitFlux(best.b, best.p, ld, n);
  // First-order depth precision: the depth is the drop from the out-of-transit baseline to the
  // transit floor, estimated from ~nTransit in-transit cadences each carrying ~rms scatter, so the
  // standard error is ~rms * sqrt(2 / nTransit). This is the POINT-estimate (statistical) error only;
  // it does NOT include systematics (the fixed limb-darkening, an imperfect ephemeris, stellar
  // variability), which is exactly what the coverage check in scripts/p9-exact-depth.ts probes.
  const halfDur = Math.asin(Math.min(1, Math.sqrt(Math.max(0, (1 + best.p) ** 2 - best.b ** 2)) / Math.max(1e-6, aOverRs))) / Math.PI;
  let nTransit = 0;
  for (const pt of inWin) if (Math.abs(pt.phase - best.dt0) <= halfDur) nTransit++;
  const depthSigma = nTransit > 0 ? rms * Math.sqrt(2 / nTransit) : NaN;
  return {
    radiusRatio: best.p,
    depthFrac,
    impactParam: best.b,
    t0OffsetPhase: best.dt0,
    rms,
    nInWindow: inWin.length,
    nTransit,
    depthSigma,
    baseline,
    ld,
    aOverRs,
  };
}

/** Median absolute deviation of an array of numbers (used for spread summaries in the CLI). */
export function mad(xs: number[]): number {
  if (!xs.length) return NaN;
  const m = [...xs].sort((a, b) => a - b)[xs.length >> 1];
  return medianAbsDev(xs.map((x) => Math.abs(x - m)));
}
