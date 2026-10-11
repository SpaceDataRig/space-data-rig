// Synthetic light-curve generator with transit injection.
// This is the ground-truth source for the injection-recovery benchmark
// (exactly what sim-runner does to measure pipeline completeness), and a
// network-independent fallback so the pipeline is provable offline.

import type { LightCurve } from "../core/types.ts";
import {
  aOverRsFromKepler,
  inclinationFromImpact,
  transitFlux,
  transitDurationHours,
  type OrbitParams,
} from "../sim/transitModel.ts";

/** Deterministic PRNG (mulberry32) so benchmarks are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gauss(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Stationary AR(1) red-noise series of length n with marginal standard deviation `sigma`.
 * y_t = rho*y_{t-1} + sigma*sqrt(1-rho^2)*eps_t, so the marginal variance stays sigma^2 for
 * |rho|<1 and rho=0 reduces EXACTLY to white noise. Mirrors src/sim/redNoise.ts:ar1Series so the
 * default stand-in carries the SAME correlated-noise model the completeness/purity benchmark uses
 * (real TESS PDCSAP residuals are measurably time-correlated on active hosts; a white-noise
 * stand-in is optimistic about the false-alarm rate). Inlined here to keep this module's
 * dependency graph unchanged (it feeds the reproducible bundle hash).
 */
function ar1(rand: () => number, n: number, sigma: number, rho: number): number[] {
  const innovation = sigma * Math.sqrt(Math.max(0, 1 - rho * rho));
  const out = new Array<number>(n);
  let prev = sigma * gauss(rand); // start from the stationary scale
  for (let i = 0; i < n; i++) {
    const y = rho * prev + innovation * gauss(rand);
    out[i] = y;
    prev = y;
  }
  return out;
}

/**
 * Deterministic per-target correlated-noise level for the DEFAULT stand-in. Real TESS hosts span
 * rho ~ 0 (quiet, near-white PDCSAP residuals) to ~ 0.63 (young active variables), measured from
 * real SPOC photometry (npm run p1:rho). Cycling this range across targets exercises the
 * noise-color-aware significance gate on every run instead of hiding behind one idealized value.
 * Both runtimes import this so the Node and edge stand-ins stay byte-identical.
 */
export const STANDIN_RHO_BY_INDEX = [0.0, 0.25, 0.45, 0.6] as const;

/** The stand-in AR(1) rho for target `index` (deterministic, cycles the measured real range). */
export function standInRhoForIndex(index: number): number {
  const i = ((index % STANDIN_RHO_BY_INDEX.length) + STANDIN_RHO_BY_INDEX.length) % STANDIN_RHO_BY_INDEX.length;
  return STANDIN_RHO_BY_INDEX[i];
}

export interface InjectedTruth {
  periodDays: number;
  t0Bjd: number;
  depthFrac: number; // achieved central depth
  durationHours: number;
  impactParam: number;
  planetRadiusRatio: number;
  aOverRs: number;
  stellarRadiusRsun: number;
  stellarMassMsun: number;
}

export interface SyntheticOptions {
  seed?: number;
  periodDays: number;
  depthFrac?: number; // e.g. 0.01 = 1% = 10000 ppm
  t0Bjd?: number;
  impactParam?: number;
  stellarRadiusRsun?: number;
  stellarMassMsun?: number;
  limbDarkening?: number;
  noisePpm?: number; // per-point Gaussian noise in ppm
  cadenceSec?: number; // e.g. 120 (TESS 2-min)
  baselineDays?: number; // e.g. 27 (one TESS sector)
  tStart?: number; // BJD start
  /** Inject realistic data gaps (TESS has per-orbit gaps). */
  dutyCycle?: number; // fraction of cadence slots retained
  /**
   * AR(1) lag-1 autocorrelation of the noise in [0,0.95]. 0 (default) = white Gaussian,
   * byte-identical to the historical stand-in. >0 = correlated ("red") noise, the realistic
   * TESS case: a white-noise false-alarm rate is optimistic because correlated noise lets the
   * BLS statistic drift upward (measured: SNR>=7 is ~0% FAR white but ~30% FAR at rho=0.5).
   */
  rho?: number;
  planetRadiusEarth?: number; // if given, derive p from it and stellar radius
  targetIdLabel?: string; // label for the generated LightCurve
}

const RSUN_KM = 695700;
const REARTH_KM = 6371;

export function generateSyntheticTransit(o: SyntheticOptions): { lc: LightCurve; truth: InjectedTruth } {
  const rand = rng(o.seed ?? 42);
  const stellarRadiusRsun = o.stellarRadiusRsun ?? 1.0;
  const stellarMassMsun = o.stellarMassMsun ?? 1.0;
  const cadenceSec = o.cadenceSec ?? 120;
  const baselineDays = o.baselineDays ?? 27;
  const tStart = o.tStart ?? 2459000.5;
  const noisePpm = o.noisePpm ?? 200;
  const dutyCycle = o.dutyCycle ?? 0.9;
  const impactParam = o.impactParam ?? 0.3;
  const limbDarkening = o.limbDarkening ?? 0.3;

  // planet radius ratio p
  let p: number;
  if (o.planetRadiusEarth != null) {
    const rpKm = o.planetRadiusEarth * REARTH_KM;
    const rsKm = stellarRadiusRsun * RSUN_KM;
    p = rpKm / rsKm;
  } else {
    const depth = o.depthFrac ?? 0.01;
    p = Math.sqrt(depth); // uniform-source central depth ~ p^2
  }

  const aOverRs = aOverRsFromKepler(o.periodDays, stellarMassMsun, stellarRadiusRsun);
  const orbit: OrbitParams = {
    periodDays: o.periodDays,
    t0Bjd: o.t0Bjd ?? tStart + o.periodDays,
    aOverRs,
    impactParam,
    planetRadiusRatio: p,
    limbDarkening,
  };
  // ensure a physical inclination exists
  inclinationFromImpact(impactParam, aOverRs);

  const dt = cadenceSec / 86400;
  const nSlots = Math.floor(baselineDays / dt);
  const points: { time: number; flux: number; fluxErr: number }[] = [];
  const noise = noisePpm * 1e-6;
  const rho = Math.min(0.95, Math.max(0, o.rho ?? 0));
  if (rho > 0) {
    // Correlated noise: draw the AR(1) series over ALL contiguous slots FIRST, then apply the
    // duty-cycle gaps. Gaps remove samples but do not re-order or re-draw them, so the retained
    // points keep their autocorrelation structure (same construction as src/sim/redNoise.ts).
    const series = ar1(rand, nSlots, noise, rho);
    for (let i = 0; i < nSlots; i++) {
      if (rand() > dutyCycle) continue; // data gap
      const t = tStart + i * dt;
      const model = transitFlux(t, orbit);
      points.push({ time: t, flux: model + series[i], fluxErr: noise });
    }
  } else {
    for (let i = 0; i < nSlots; i++) {
      if (rand() > dutyCycle) continue; // data gap
      const t = tStart + i * dt;
      const model = transitFlux(t, orbit);
      const flux = model + gauss(rand) * noise;
      points.push({ time: t, flux, fluxErr: noise });
    }
  }
  points.sort((a, b) => a.time - b.time);

  const depthFrac = 1 - transitFlux(orbit.t0Bjd, orbit);
  const truth: InjectedTruth = {
    periodDays: o.periodDays,
    t0Bjd: orbit.t0Bjd,
    depthFrac,
    durationHours: transitDurationHours(orbit),
    impactParam,
    planetRadiusRatio: p,
    aOverRs,
    stellarRadiusRsun,
    stellarMassMsun,
  };

  const lc: LightCurve = {
    targetId: o.targetIdLabel ?? `SYN-${(o.seed ?? 42).toString(36).toUpperCase()}`,
    mission: "synthetic",
    cadenceSec,
    points,
    source: `synthetic injection (seed=${o.seed ?? 42}, depth=${(depthFrac * 1e6).toFixed(0)}ppm, P=${o.periodDays}d${rho > 0 ? `, AR1 rho=${rho.toFixed(2)}` : ""})`,
  };
  return { lc, truth };
}
