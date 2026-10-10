// sim-runner: per-signal confidence + ephemeris prediction.
//
// Two jobs the orchestrator calls for every candidate:
//
//  1) signalRecoveryConfidence(): a *targeted* injection-recovery Monte Carlo.
//     We re-inject a planet with the RECOVERED parameters into fresh noise
//     realizations of the same cadence/baseline/depth and ask "how often does
//     the pipeline get it back?". That fraction is an honest, per-signal
//     completeness estimate -- a shallow 150 ppm single-sector signal scores
//     low, a deep 3000 ppm signal scores ~1.0. This is what makes the
//     mission-critic verdict quantitative instead of hand-wavy.
//
//  2) predictEphemeris(): fold the recovered T0 + P forward to predict the
//     next observable transits. This is the "real work" artifact a trader can
//     verify against a follow-up observation, and it goes into the bundle.

import { preprocess, madSigma } from "../detect/detrend.ts";
import { bls } from "../detect/bls.ts";
import { resolvePeriodAlias } from "./aliasResolver.ts";
import { generateSyntheticTransit } from "../data/synthetic.ts";
import type { LightCurve } from "../core/types.ts";

/** Parameters describing the signal to re-inject (usually the recovered ones). */
export interface SignalParams {
  periodDays: number;
  depthFrac: number; // fractional central depth (e.g. 3e-4 = 300 ppm)
  stellarRadiusRsun?: number;
  stellarMassMsun?: number;
  noisePpm?: number; // per-point noise; estimated from the data if omitted
  cadenceSec?: number;
  baselineDays?: number;
  impactParam?: number;
}

export interface ConfidenceOptions {
  nTrials?: number; // Monte Carlo realizations (keep small: this runs per candidate)
  seed?: number;
  periodTolPct?: number;
  minSnr?: number;
  minPeriodDays?: number;
  maxPeriodDays?: number;
  oversample?: number;
  nDurations?: number;
}

export interface ConfidenceResult {
  confidence: number; // 0..1 recovery fraction
  nTrials: number;
  nRecovered: number;
  medianPeriodErrorPct: number;
  medianSnr: number;
  assumedNoisePpm: number;
  nextTransitsBjd: number[]; // ephemeris predictions (empty if period invalid)
}

/** Robust per-point noise (ppm) of a light curve, from the MAD of its flux. */
export function estimateNoisePpm(lc: LightCurve): number {
  const flux = lc.points.map((p) => p.flux);
  const sig = madSigma(flux);
  if (!isFinite(sig) || sig <= 0) return 200;
  return sig * 1e6;
}

/** Median helper (copy-sorted). */
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** True if recovered period matches truth within tolerance, allowing harmonics. */
function matchPeriod(rec: number, truth: number, tolPct: number): number | null {
  const factors = [1, 0.5, 2, 1 / 3, 3, 2 / 3, 3 / 2, 1.5];
  for (const f of factors) {
    const err = Math.abs(rec * f - truth) / truth;
    if (err <= tolPct / 100) return f;
  }
  return null;
}

/**
 * Targeted injection-recovery Monte Carlo for ONE signal.
 * Returns the fraction of fresh realizations in which the pipeline recovers
 * the injected period (alias-resolved) above the SNR floor.
 *
 * The per-trial work lives in recoveryTrial() and the fold-up in combineTrials(),
 * so the Cloudflare workflow can shard the same trials across steps and reproduce
 * an identical ConfidenceResult (and therefore an identical bundle manifest).
 */
export function signalRecoveryConfidence(p: SignalParams, o: ConfidenceOptions = {}): ConfidenceResult {
  const nTrials = Math.max(1, o.nTrials ?? 8);
  const outcomes: TrialOutcome[] = [];
  for (let i = 0; i < nTrials; i++) outcomes.push(recoveryTrial(p, o, i));
  return { ...combineTrials(outcomes, nTrials, p.noisePpm ?? 200), nextTransitsBjd: [] };
}

/** One injection-recovery trial outcome (kept finite so it can cross a step boundary). */
export interface TrialOutcome {
  recovered: boolean;
  /** period error percent vs truth when recovered; -1 otherwise (never read). */
  periodErrPct: number;
  /** BLS SNR when recovered; 0 otherwise (never read). */
  snr: number;
}

/**
 * Run a SINGLE injection-recovery trial `i` deterministically. The seed and all
 * option defaults are resolved exactly as the batch loop did, so folding many trial
 * outcomes equals the whole signalRecoveryConfidence() call for the same parameters.
 */
export function recoveryTrial(p: SignalParams, o: ConfidenceOptions, i: number): TrialOutcome {
  const tol = o.periodTolPct ?? 2;
  const minSnr = o.minSnr ?? 5;
  const cadenceSec = p.cadenceSec ?? 120;
  const baselineDays = p.baselineDays ?? 27;
  const stellarRadiusRsun = p.stellarRadiusRsun ?? 1.0;
  const stellarMassMsun = p.stellarMassMsun ?? stellarRadiusRsun;
  const impactParam = p.impactParam ?? 0.3;
  const noisePpm = p.noisePpm ?? 200;
  // Search window: bracket the true period so recovery is about the signal,
  // not about the grid range. Aliases up to 3x are still resolved downstream.
  const minP = o.minPeriodDays ?? Math.max(0.5, p.periodDays * 0.6);
  const maxP = o.maxPeriodDays ?? p.periodDays * 3.2;
  const seed = (o.seed ?? 9000) + i * 17;
  try {
    const { lc, truth } = generateSyntheticTransit({
      seed,
      periodDays: p.periodDays,
      depthFrac: p.depthFrac,
      stellarRadiusRsun,
      stellarMassMsun,
      impactParam,
      noisePpm,
      cadenceSec,
      baselineDays,
      targetIdLabel: `CONF-${seed}`,
    });
    const clean = preprocess(lc, 0.5);
    const r = bls(clean, {
      minPeriodDays: minP,
      maxPeriodDays: maxP,
      oversample: o.oversample ?? 6,
      nDurations: o.nDurations ?? 8,
    });
    const times = clean.points.map((q) => q.time);
    const flux = clean.points.map((q) => q.flux);
    const al = resolvePeriodAlias(times, flux, r.periodDays, r.epochBjd, r.durationDays);
    const f = matchPeriod(al.period, truth.periodDays, tol);
    if (f != null && r.snr >= minSnr) {
      return { recovered: true, periodErrPct: (Math.abs(al.period * f - truth.periodDays) / truth.periodDays) * 100, snr: r.snr };
    }
    return { recovered: false, periodErrPct: -1, snr: 0 };
  } catch {
    // a failed trial simply counts as "not recovered"
    return { recovered: false, periodErrPct: -1, snr: 0 };
  }
}

/** Fold per-trial outcomes into the same aggregate the batch loop produced. */
export function combineTrials(outcomes: TrialOutcome[], nTrials: number, assumedNoisePpm: number): Omit<ConfidenceResult, "nextTransitsBjd"> {
  const recovered = outcomes.filter((x) => x.recovered);
  const periodErrors = recovered.map((x) => x.periodErrPct);
  const snrs = recovered.map((x) => x.snr);
  return {
    confidence: recovered.length / nTrials,
    nTrials,
    nRecovered: recovered.length,
    medianPeriodErrorPct: median(periodErrors),
    medianSnr: median(snrs),
    assumedNoisePpm,
  };
}

/**
 * Fold T0 + P forward to predict the next `count` transit centers at/after
 * `fromBjd`. These are concrete, falsifiable predictions for the bundle.
 */
export function predictEphemeris(t0Bjd: number, periodDays: number, count = 3, fromBjd?: number): number[] {
  if (!isFinite(periodDays) || periodDays <= 0 || !isFinite(t0Bjd)) return [];
  const from = fromBjd ?? t0Bjd;
  const kStart = Math.ceil((from - t0Bjd) / periodDays);
  const out: number[] = [];
  for (let k = kStart; out.length < count; k++) {
    const t = t0Bjd + k * periodDays;
    if (t >= from - 1e-9) out.push(t);
    if (k > kStart + count + 1000) break; // safety
  }
  return out;
}

/**
 * Convenience wrapper the orchestrator calls: confidence + ephemeris together,
 * estimating the noise from the observed (clean) curve when not supplied.
 */
export function assessSignal(
  p: SignalParams,
  epochBjd: number,
  observed?: LightCurve,
  o: ConfidenceOptions = {},
): ConfidenceResult {
  const noisePpm = p.noisePpm ?? (observed ? estimateNoisePpm(observed) : 200);
  const res = signalRecoveryConfidence({ ...p, noisePpm }, o);
  res.nextTransitsBjd = predictEphemeris(epochBjd, p.periodDays, 3);
  return res;
}
