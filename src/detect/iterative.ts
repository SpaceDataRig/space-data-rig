// ITERATIVE MULTI-SIGNAL TRANSIT EXTRACTION -- the "stronger detector" p26-p30 named.
//
// WHY THIS EXISTS. p30 (npm run p30:joint-alias) reached a convergent conclusion with p28/p29: a SINGLE
// blind BLS on a (stitched) baseline frequently locks the WRONG period, and in a multi-planet system it
// recovers only the STRONGEST signal -- so per-system recovery of KNOWN planets was just 2/10. The named
// fix is iterative multi-signature extraction: find the strongest transit, resolve its half/third-period
// alias (odd-even per-epoch test), MASK its in-transit cadences, then re-run BLS on the residual to find the
// NEXT planet, and repeat. Masking (rather than subtracting a fitted model) removes the found signal WITHOUT
// injecting a model's residual, and it also suppresses that signal's harmonics/aliases -- their transits fall
// at the masked phases too -- which is exactly the P/2 vs 2P trap p30 could not escape with a single pass.
//
// Each BLS peak is REFINED on a dense local frequency grid before it is recorded. The production coarse grid
// (oversample 8) is ~0.25 d wide at P~7 d, so on a ~27 d baseline it cannot phase-lock a narrow transit: it
// lands ~1% off period, the transits smear across the fold, and BLS compensates with a WIDE, SHALLOW box that
// under-measures the depth (a 9000 ppm transit reads ~3500 ppm). A narrow +-3% re-scan at high oversampling
// locks the true ephemeris, the box narrows, and the period and depth come out right -- which is what makes
// iterative extraction a STRONGER detector, not merely a multi-peak one.
//
// This is the standard lightkurve / ExoFOP "iterative BLS with transit masking" multi-planet approach,
// implemented here as a PURE, DETERMINISTIC, RESEARCH-ONLY module. The worker never imports it, so it
// cannot touch a verdict / bundle hash / money path. It never mutates its input (returns fresh curves).
//
// HONEST SCOPE. Iterative masking recovers ADDITIONAL distinct signals; it does NOT by itself decide which
// are real planets (an alias of a bright planet can survive as an extra peak, and masking can leave a
// shallow residual). scripts/p32 measures per-system KNOWN-planet recovery against the single-BLS p30
// baseline on real multi-planet hosts -- the number is measured on real photometry, never asserted.

import type { LightCurve } from "../core/types.ts";
import { bls, type BLSOptions, type BLSResult } from "./bls.ts";
import { resolvePeriodAlias } from "../sim/aliasResolver.ts";

/** One transit signal recovered by iterative extraction, in extraction order (index 0 = strongest). */
export interface IterativeSignal {
  index: number;
  periodDays: number;
  epochBjd: number;
  durationDays: number;
  depth: number; // fractional depth (positive for a dip)
  depthPpm: number;
  snr: number;
  power: number;
  nInTransit: number;
  aliasMultiple: number; // 1 = the BLS period was true; 2 = resolved from P/2; 3 = from P/3
  nMaskedThisStep: number; // cadences removed to expose the NEXT signal
  nPointsAtDetection: number; // finite cadences available when this signal was found
}

export interface IterativeOptions extends BLSOptions {
  /** Hard cap on extracted signals (default 5). */
  maxSignals?: number;
  /** Stop before recording a signal whose BLS SNR is below this (default 7, the production floor). */
  minSnr?: number;
  /** Stop before recording a signal shallower than this, in ppm (default 200, the production floor). */
  minDepthPpm?: number;
  /** Pad each in-transit half-window by this fraction of the duration so wings are masked too (default 0.15). */
  maskPadFrac?: number;
  /** Skip recording a signal whose period is an alias/harmonic of one already found, within this % (default 1). */
  dedupTolPct?: number;
}

export interface IterativeResult {
  /** Distinct recorded signals, strongest first (aliases of an earlier signal are masked but not recorded). */
  signals: IterativeSignal[];
  nPointsStart: number;
  nPointsEnd: number; // finite cadences left after all masking
  stoppedReason: string; // max-signals | snr-floor | depth-floor | too-few-points | no-points-masked | bls-failed
}

/** Fold (t - epoch)/period into a phase in [-0.5, 0.5). */
function phaseAbout(t: number, epoch: number, period: number): number {
  if (!(period > 0)) return 0.5;
  let ph = ((t - epoch) / period) % 1;
  if (ph < -0.5) ph += 1;
  else if (ph >= 0.5) ph -= 1;
  return ph;
}

/**
 * Boolean mask, true where a cadence is IN TRANSIT for the given ephemeris: |phase about epoch| is within
 * (duration/2)*(1+padFrac)/period. Exported so p32 and the tests can reuse the exact masking the extractor
 * applies. Deterministic and side-effect free.
 */
export function inTransitMask(
  times: number[],
  periodDays: number,
  epochBjd: number,
  durationDays: number,
  padFrac = 0.15,
): boolean[] {
  if (!(periodDays > 0) || !(durationDays > 0)) return times.map(() => false);
  const halfPhase = ((durationDays / 2) * (1 + Math.max(0, padFrac))) / periodDays;
  return times.map((t) => Math.abs(phaseAbout(t, epochBjd, periodDays)) <= halfPhase);
}

/** True if period `p` equals `q` or a low-order harmonic/alias of it within tolPct (same set BLS matching uses). */
export function isAliasOf(p: number, q: number, tolPct = 1): boolean {
  if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0) return false;
  for (const f of [1, 0.5, 2, 1 / 3, 3, 2 / 3, 3 / 2, 1.5]) {
    if (Math.abs(p * f - q) / q <= tolPct / 100) return true;
  }
  return false;
}

/**
 * Dense local re-scan of BLS in a +-3% period window around `centerPeriod`, at an oversampling high enough to
 * phase-lock a narrow transit over the full baseline. Returns the sharper BLSResult, or null if the window scan
 * fails (caller keeps its coarse peak). The production coarse grid (oversample 8) is ~0.25 d wide at P~7 d and
 * lands ~1% off, smearing the transit fold and under-measuring depth; centring on the ALIAS-RESOLVED period
 * and re-scanning densely locks the true ephemeris so the box narrows and the depth is recovered. Pure and
 * deterministic; never mutates its input.
 */
function refineAround(lc: LightCurve, centerPeriod: number, opts: IterativeOptions): BLSResult | null {
  if (!Number.isFinite(centerPeriod) || centerPeriod <= 0) return null;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of lc.points) {
    if (Number.isFinite(p.time)) {
      if (p.time < tMin) tMin = p.time;
      if (p.time > tMax) tMax = p.time;
    }
  }
  const baseline = tMax - tMin;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  const WIN = 0.03; // +-3% brackets the coarse grid's period error with margin
  // Target ~0.05% period resolution near the centre: dP = P^2/(oversample*baseline) => oversample ~ 2000*P/baseline.
  const oversample = Math.min(4000, Math.max(opts.oversample ?? 8, Math.round((2000 * centerPeriod) / baseline)));
  try {
    return bls(lc, {
      ...opts,
      minPeriodDays: centerPeriod * (1 - WIN),
      maxPeriodDays: centerPeriod * (1 + WIN),
      oversample,
    });
  } catch {
    return null;
  }
}

/**
 * Iteratively extract up to `maxSignals` transits: run BLS, record the strongest signal that clears the
 * SNR/depth floors and is not an alias of one already found, mask its in-transit cadences, and repeat on the
 * residual. Stops at the first signal below a floor, when too few cadences remain, or at the cap. Pure and
 * deterministic (bls is deterministic; masking is a fixed phase window); the input curve is never mutated.
 */
export function iterativeBls(lc: LightCurve, opts: IterativeOptions = {}): IterativeResult {
  const maxSignals = Math.max(1, opts.maxSignals ?? 5);
  const minSnr = opts.minSnr ?? 7;
  const minDepthPpm = opts.minDepthPpm ?? 200;
  const padFrac = opts.maskPadFrac ?? 0.15;
  const dedupTolPct = opts.dedupTolPct ?? 1;

  const signals: IterativeSignal[] = [];
  let cur: LightCurve = { ...lc, points: lc.points.map((p) => ({ ...p })) };
  const nStart = cur.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux)).length;
  let stoppedReason = "max-signals";

  for (let step = 0; step < maxSignals; step++) {
    const finite = cur.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
    if (finite.length < 30) {
      stoppedReason = "too-few-points";
      break;
    }

    let coarse;
    try {
      coarse = bls(cur, opts);
    } catch {
      stoppedReason = "bls-failed";
      break;
    }

    // Resolve the half/third-period alias on the COARSE peak first (the odd-even per-epoch test detectTransit
    // also uses), so the dense local re-scan is centred on the TRUE period rather than on a P/2 or P/3 alias.
    // refineAround then locks the ephemeris: the box narrows and the depth is measured undiluted.
    const times = cur.points.map((p) => p.time);
    const flux = cur.points.map((p) => p.flux);
    const al = resolvePeriodAlias(times, flux, coarse.periodDays, coarse.epochBjd, coarse.durationDays);
    const r = refineAround(cur, al.period, opts) ?? coarse;

    const depthPpm = r.depth * 1e6;
    if (!Number.isFinite(r.snr) || r.snr < minSnr) {
      stoppedReason = "snr-floor";
      break;
    }
    if (!Number.isFinite(depthPpm) || depthPpm < minDepthPpm) {
      stoppedReason = "depth-floor";
      break;
    }

    // Masking is done at the refined ephemeris, which also clears the alias' own co-located dips.
    const periodDays = r.periodDays;
    const epochBjd = r.epochBjd;

    // An alias/harmonic of an already-recorded signal is masked (to clear its residual) but NOT recorded.
    const dup = signals.some((s) => isAliasOf(periodDays, s.periodDays, dedupTolPct));

    const mask = inTransitMask(times, periodDays, epochBjd, r.durationDays, padFrac);
    const keep = cur.points.filter((_, i) => !mask[i]);
    const nMasked = cur.points.length - keep.length;

    if (!dup) {
      signals.push({
        index: signals.length,
        periodDays,
        epochBjd,
        durationDays: r.durationDays,
        depth: r.depth,
        depthPpm,
        snr: r.snr,
        power: r.power,
        nInTransit: r.nInTransit,
        aliasMultiple: al.multiple,
        nMaskedThisStep: nMasked,
        nPointsAtDetection: finite.length,
      });
    }

    cur = { ...cur, points: keep };
    if (nMasked === 0) {
      stoppedReason = "no-points-masked";
      break;
    }
    if (keep.length < 30) {
      stoppedReason = "too-few-points";
      break;
    }
    if (signals.length >= maxSignals) {
      stoppedReason = "max-signals";
      break;
    }
  }

  const nEnd = cur.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux)).length;
  return { signals, nPointsStart: nStart, nPointsEnd: nEnd, stoppedReason };
}
