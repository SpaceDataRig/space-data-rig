// Correlated-noise ("red noise") light-curve generator for the completeness/purity benchmark.
//
// Why this exists: real TESS PDCSAP photometry carries measurable TIME-CORRELATED (red) noise
// from residual systematics, not just the white Gaussian scatter the plain synthetic model makes.
// A false-alarm rate measured on WHITE noise is OPTIMISTIC -- red noise makes the BLS statistic
// drift upward, so the same SNR threshold throws MORE false alarms in reality. To report an
// honest operating curve we must be able to inject planets AND build zero-injection nulls under a
// controllable AR(1) noise process.
//
// This module is purely additive: it is used ONLY by the ROC benchmark (src/sim/roc.ts with rho>0),
// never by the deterministic stand-in in src/data/synthetic.ts, so no existing bundle hash changes.
//
// AR(1): y_t = rho * y_{t-1} + sigma * sqrt(1 - rho^2) * eps_t, eps_t ~ N(0,1). Stationary
// variance = sigma^2 for |rho|<1 (hence the sqrt(1-rho^2) innovation scale). rho=0 reduces exactly
// to white noise. Deterministic given the seed. Transit shape reuses the real transitModel so the
// injected signals are physically consistent with the rest of the pipeline.

import type { LightCurve } from "../core/types.ts";
import {
  aOverRsFromKepler,
  inclinationFromImpact,
  transitFlux,
  transitDurationHours,
  mainSequenceMassFromRadius,
  type OrbitParams,
} from "./transitModel.ts";

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

/** Standard normal via Box-Muller from a uniform generator. */
function gauss(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A stationary AR(1) series of length n with marginal standard deviation `sigma`.
 * rho=0 yields white noise; 0<rho<1 yields red noise with lag-1 autocorrelation ~= rho.
 */
export function ar1Series(rand: () => number, n: number, sigma: number, rho: number): number[] {
  const innovation = sigma * Math.sqrt(Math.max(0, 1 - rho * rho));
  const out = new Array<number>(n);
  let prev = sigma * gauss(rand); // start from the stationary distribution scale
  for (let i = 0; i < n; i++) {
    const y = rho * prev + innovation * gauss(rand);
    out[i] = y;
    prev = y;
  }
  return out;
}

export interface RedNoiseOptions {
  seed?: number;
  periodDays: number;
  depthFrac?: number; // 0 => no transit (a pure-noise null sample)
  t0Bjd?: number;
  impactParam?: number;
  stellarRadiusRsun?: number;
  stellarMassMsun?: number;
  limbDarkening?: number;
  noisePpm?: number;
  /** AR(1) lag-1 autocorrelation coefficient in [0,1). 0 = white (default). */
  rho?: number;
  cadenceSec?: number;
  baselineDays?: number;
  tStart?: number;
  dutyCycle?: number; // fraction of cadence slots retained (TESS-like gaps)
  targetIdLabel?: string;
}

/**
 * A light curve with a real-geometry transit plus AR(1) red noise. With depthFrac 0 the model
 * flux is flat, giving a planet-free null that shares the same sampling, gaps and noise color as
 * the injections -- the correct zero-hypothesis for a correlated-noise false-alarm study.
 */
export function makeRedNoiseLightCurve(o: RedNoiseOptions): LightCurve {
  const rand = mulberry32(o.seed ?? 1);
  const rho = Math.min(0.95, Math.max(0, o.rho ?? 0));
  const stellarRadiusRsun = o.stellarRadiusRsun ?? 1.0;
  const stellarMassMsun = o.stellarMassMsun ?? mainSequenceMassFromRadius(stellarRadiusRsun);
  const cadenceSec = o.cadenceSec ?? 120;
  const baselineDays = o.baselineDays ?? 27;
  const tStart = o.tStart ?? 2459000.5;
  const noisePpm = o.noisePpm ?? 200;
  const dutyCycle = o.dutyCycle ?? 0.9;
  const impactParam = o.impactParam ?? 0.3;
  const depth = o.depthFrac ?? 0.01;

  const aOverRs = aOverRsFromKepler(o.periodDays, stellarMassMsun, stellarRadiusRsun);
  const orbit: OrbitParams = {
    periodDays: o.periodDays,
    t0Bjd: o.t0Bjd ?? tStart + o.periodDays,
    aOverRs,
    impactParam,
    planetRadiusRatio: Math.sqrt(Math.max(0, depth)), // central depth ~ p^2 (uniform), red noise added below
    limbDarkening: o.limbDarkening ?? 0.3,
  };
  inclinationFromImpact(impactParam, aOverRs);

  // generate the full-slot grid times + a red-noise series over ALL slots, THEN apply duty-cycle
  // gaps. Keeping the noise on the contiguous grid preserves autocorrelation structure across the
  // retained samples (gaps remove points but do not re-order or re-draw them).
  const dt = cadenceSec / 86400;
  const nSlots = Math.floor(baselineDays / dt);
  const noise = ar1Series(rand, nSlots, noisePpm * 1e-6, rho);
  const points: { time: number; flux: number; fluxErr: number }[] = [];
  for (let i = 0; i < nSlots; i++) {
    if (rand() > dutyCycle) continue; // data gap (same cadence of rand calls as the white model)
    const t = tStart + i * dt;
    const model = transitFlux(t, orbit);
    points.push({ time: t, flux: model + noise[i], fluxErr: noisePpm * 1e-6 });
  }
  points.sort((a, b) => a.time - b.time);

  const durationHours = transitDurationHours(orbit);
  return {
    targetId: o.targetIdLabel ?? `RED-${(o.seed ?? 1).toString(36).toUpperCase()}`,
    mission: "synthetic",
    cadenceSec,
    points,
    source: `synthetic red-noise (AR1 rho=${rho}, seed=${o.seed ?? 1}, depth=${(depth * 1e6).toFixed(0)}ppm, P=${o.periodDays.toFixed(3)}d, dur=${durationHours.toFixed(2)}h)`,
  };
}
