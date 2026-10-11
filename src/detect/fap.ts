// Calibrated false-alarm probability (FAP) for a BLS detection via a phase-scrambling
// null -- the statistic that turns the heuristic BLS SNR into a defensible significance.
//
// The observed detection statistic is BLS max-power over the trial period grid. We build
// a NULL distribution of that statistic by scrambling the REAL transit's phase coherence
// while keeping the noise amplitude distribution intact: each point's TIME is perturbed
// by a uniform jitter of +-P/3 (P = the detected period). A genuine periodic dip is smeared
// out (transits no longer stack) so its BLS power collapses, whereas white/correlated noise
// is statistically unchanged. The empirical FAP of the real candidate is the fraction of
// such phase-scrambled surrogates whose max-power reaches the observed power. This is more
// honest than a Gaussian SNR cut, which assumes white noise and ignores the look-elsewhere
// effect across the period grid.
//
// (A plain circular time-shift is NOT used: it translates the whole series and PRESERVES
// the transits, so it fails to destroy the signal -- caught by the regression tests.)
//
// Deterministic: the jitter draws come from a seeded PRNG, so repeated runs and the tests
// are reproducible. Additive only -- NOT wired into the default pipeline, whose synthetic
// path numbers feed the reproducible bundle hash.

import type { LightCurve } from "../core/types.ts";
import { bls, type BLSOptions } from "./bls.ts";

/** Local deterministic PRNG (mulberry32) so the surrogate shifts are reproducible
 *  without importing the synthetic module (whose output feeds the bundle hash). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FapOptions {
  /** number of surrogate shift trials (>= ~50 for a usable tail; min FAP ~ 1/(trials+1)). */
  trials?: number;
  /** fixed seed so the null distribution is reproducible. */
  seed?: number;
  /** BLS search options reused for every surrogate. */
  bls?: BLSOptions;
}

export interface FapResult {
  fap: number;
  observedPower: number;
  trials: number;
  /** floor of what N trials can resolve, reported so callers do not over-claim 0. */
  minResolvableFap: number;
  /** number of surrogates whose max-power >= observedPower. */
  exceedances: number;
}

/**
 * Estimate the phase-scrambling FAP of the strongest BLS signal in `lc`.
 * `lc` should already be detrended (so the null surrogates share its noise structure).
 */
export function estimateFap(lc: LightCurve, opts: FapOptions = {}): FapResult {
  const trials = Math.max(1, Math.floor(opts.trials ?? 120));
  const rand = prng(opts.seed ?? 982451653);
  const blsOpts = opts.bls ?? {};

  const obs = bls(lc, blsOpts);
  const observedPower = obs.power;
  const jitterDays = obs.periodDays / 3; // smear a single transit well beyond its own width

  const times = lc.points.map((p) => p.time);
  const flux = lc.points.map((p) => p.flux);
  const errs = lc.points.map((p) => p.fluxErr ?? null);

  let exceedances = 0;
  for (let i = 0; i < trials; i++) {
    const surrogate: LightCurve = {
      ...lc,
      points: times.map((t, idx) => ({
        time: t + (rand() - 0.5) * 2 * jitterDays,
        flux: flux[idx],
        fluxErr: errs[idx] ?? undefined,
      })),
    };
    let power: number;
    try {
      power = bls(surrogate, blsOpts).power;
    } catch {
      continue; // a surrogate too degenerate for BLS counts as a non-detection
    }
    if (power >= observedPower) exceedances++;
  }

  const minResolvableFap = 1 / (trials + 1);
  const raw = (exceedances + 1) / (trials + 1); // add-one (Laplace) so a clean null is not reported as literally 0
  return {
    fap: Math.min(1, Math.max(raw, minResolvableFap)),
    observedPower,
    trials,
    minResolvableFap,
    exceedances,
  };
}
