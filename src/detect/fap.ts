// Calibrated false-alarm probability (FAP) for a BLS detection via a phase-scrambling
// null -- the statistic that turns the heuristic BLS SNR into a defensible significance.
//
// The observed detection statistic is BLS max-power over the trial period grid. We build
// a NULL distribution of that statistic by destroying the REAL transit's phase coherence
// while KEEPING the noise's own temporal correlation intact. We do that with a MOVING-BLOCK
// bootstrap: the time grid is fixed and the flux is resampled in contiguous blocks of length
// `blockLength` (default 8 cadences), so short-range AR(1) correlation survives inside each
// block (red noise stays red) while reordering blocks breaks the recurring transit so it no
// longer stacks. The empirical FAP of the real candidate is the fraction of such surrogates
// whose max-power reaches the observed power. This is more honest than a Gaussian SNR cut,
// which assumes white noise and ignores the look-elsewhere effect across the period grid.
//
// WHY NOT PER-POINT TIME JITTER (the earlier implementation): jittering each sample's time
// independently scrambles the ordering and DESTROYS the AR(1) autocorrelation, whitening the
// null. On a red-noise host the null powers then collapse far below the (still red) observed
// power, so FAP is grossly optimistic -- measured with npm run p20:fap-rednoise: false-alarm
// rate on PLANET-FREE curves climbed 0% -> 92% -> 100% as rho went 0 -> 0.3 -> 0.8.
//
// HONEST LIMIT OF THE BLOCK BOOTSTRAP: sizing blocks from the measured rho (block ~ 4/(1-rho))
// cuts that optimism sharply (rho 0.3: 92% -> 0%) but does NOT fully remove it -- p20 still shows
// FAR ~42% at rho 0.6 and ~83% at rho 0.8, because NO time-resampling surrogate reproduces the
// 1/f excess power BLS is sensitive to at low frequency. A properly calibrated significance for a
// correlated host must MODEL the noise, not resample it: that is src/detect/significance.ts
// calibratedFap (AR(1)-model nulls), which is the PRODUCTION gate. estimateFap is a model-free
// surrogate that is trustworthy only for near-white curves; it is not wired into any verdict.
//
// (A plain circular time-shift is NOT used either: it translates the whole series and PRESERVES
// the transits, so it fails to destroy the signal -- caught by the regression tests.)
//
// Deterministic: the block draws come from a seeded PRNG, so repeated runs and the tests are
// reproducible. Additive only -- NOT wired into the default pipeline; the PRODUCTION significance
// gate is src/detect/significance.ts calibratedFap (AR(1)-model nulls), which this module predates.

import type { LightCurve } from "../core/types.ts";
import { bls, type BLSOptions } from "./bls.ts";
import { estimateRho } from "../sim/redNoise.ts";

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
  /** moving-block length in cadences; must exceed the noise memory but stay under the transit width. */
  blockLength?: number;
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

  const times = lc.points.map((p) => p.time);
  const flux = lc.points.map((p) => p.flux);
  const errs = lc.points.map((p) => p.fluxErr ?? null);
  const n = flux.length;
  // Moving-block bootstrap: keep the time grid, resample flux in contiguous blocks so short-range
  // AR(1) correlation is preserved (a per-point jitter would whiten it and make FAP optimistic).
  // The block must be LONGER than the noise memory ~1/(1-rho) or the correlation leaks out; we size
  // it from the curve's OWN measured rho (a fixed 8 was still optimistic at rho~0.8). An explicit
  // blockLength overrides. Cap well under n so there are enough blocks to actually scramble phase.
  const rho = estimateRho(flux);
  const memory = Number.isFinite(rho) ? 1 / (1 - Math.min(0.95, Math.max(0, rho))) : 1;
  const autoBlock = Math.max(8, Math.ceil(4 * memory));
  const block = Math.max(2, Math.min(opts.blockLength ?? autoBlock, Math.floor(n / 3)));
  const nBlocks = Math.ceil(n / block);

  let exceedances = 0;
  for (let i = 0; i < trials; i++) {
    const sb = new Array<number>(n);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rand() * Math.max(1, n - block + 1));
      for (let k = 0; k < block; k++) {
        const idx = b * block + k;
        if (idx >= n) break;
        sb[idx] = flux[start + k];
      }
    }
    const surrogate: LightCurve = {
      ...lc,
      points: times.map((t, idx) => ({
        time: t,
        flux: sb[idx],
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
