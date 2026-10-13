// WINDOW-FUNCTION ALIAS AMBIGUITY -- the sampling-window lever the roadmap flagged as unsuppressed.
//
// WHY THIS EXISTS. The production odd/even resolver (src/sim/aliasResolver.ts) defeats HALF/double-period
// aliases (P/2, P*2) by comparing per-epoch depths. It does NOT address a different, classical ambiguity: the
// SAMPLING WINDOW. A light curve is not sampled continuously -- it has gaps on some characteristic spacing
// (daily for ground-based / downlink-gated data, orbital for TESS). The Fourier transform of that sampling
// pattern is the SPECTRAL WINDOW W(f) = |sum_k exp(2 pi i f t_k)| / N, which has a main beam at f = 0 and
// SIDEBELOBES at the gap frequencies (e.g. +/- 1 cycle/day). A real signal at frequency f0 is copied by those
// sidelobes to f0 +/- f_side, so BLS can lock the wrong one and report an ALIAS period with almost the same
// power. The ephemeris is then wrong even though the detection is real -- a distinct failure from the P/2 case.
//
// WHAT THIS MEASURES. For a candidate at period P we fold at the +/- n c/d alias periods and ask: how well does
// the best alias explain the data relative to the true peak (ambiguity = snrAtAlias / snrBest), AND does this
// curve's sampling actually carry the window power to project that alias (dailyWindowPower / sidelobe)? A high
// ambiguity with a high window sidelobe is a genuine window-alias risk; a high ambiguity with a flat window is
// just two real competing signals, which is NOT this module's problem.
//
// PURE, DETERMINISTIC, RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash / money
// path. Never mutates inputs. Reuses the certified bls() engine for the fold, so the SNR is the same statistic the
// production gate uses.

import { bls } from "./bls.ts";
import { preprocess } from "./detrend.ts";
import type { LightCurve } from "../core/types.ts";

function finiteTimes(lc: LightCurve): number[] {
  return lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux)).map((p) => p.time);
}

/**
 * Normalized spectral-window power |sum_k exp(2 pi i f t_k)| / N at frequency f (cycles per DAY, times in days).
 * In [0, 1]: 1 means every sample is in phase at f (a perfect alias projector), ~0 means the sampling carries no
 * coherent power at that frequency. Pure + deterministic.
 */
export function spectralWindowPower(times: number[], freqCpd: number): number {
  const n = times.length;
  if (!n || !Number.isFinite(freqCpd)) return 0;
  let re = 0;
  let im = 0;
  for (const t of times) {
    const a = 2 * Math.PI * freqCpd * t;
    re += Math.cos(a);
    im += Math.sin(a);
  }
  return Math.hypot(re, im) / n;
}

/**
 * The strongest spectral-window SIDEBELOBE in [minCpd, maxCpd], excluding the main beam near 0. This is the
 * frequency at which the sampling most strongly copies a signal -- the dominant alias spacing for this curve.
 */
export function strongestWindowSidelobe(
  times: number[],
  opts: { minCpd?: number; maxCpd?: number; steps?: number } = {},
): { freqCpd: number; power: number } {
  const min = opts.minCpd ?? 0.4;
  const max = opts.maxCpd ?? 2.2;
  const steps = Math.max(2, opts.steps ?? 900);
  let bestF = min;
  let bestP = -1;
  for (let i = 0; i <= steps; i++) {
    const f = min + ((max - min) * i) / steps;
    const p = spectralWindowPower(times, f);
    if (p > bestP) {
      bestP = p;
      bestF = f;
    }
  }
  return { freqCpd: bestF, power: Math.max(0, bestP) };
}

/**
 * The +/- n cycles-per-day ALIAS periods of a candidate period (positive, within [minP, maxP]). A signal at
 * 1/P is copied by the daily window to 1/P +/- n (n = 1..maxOrder), i.e. to period 1 / |1/P +/- n|.
 */
export function dailyAliasPeriods(periodDays: number, maxOrder = 1, minP = 0.4, maxP = 20): number[] {
  if (!(periodDays > 0)) return [];
  const f = 1 / periodDays;
  const out: number[] = [];
  for (let n = 1; n <= maxOrder; n++) {
    for (const fa of [f + n, f - n]) {
      if (fa > 1e-9) {
        const pa = 1 / fa;
        if (pa >= minP && pa <= maxP && Math.abs(pa - periodDays) > 1e-6) out.push(pa);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/** BLS SNR from a narrow frequency band centered on a period (the same statistic the production gate uses). */
export function snrAtPeriod(
  lc: LightCurve,
  periodDays: number,
  opts: { oversample?: number; nDurations?: number; bandFrac?: number } = {},
): number {
  const band = opts.bandFrac ?? 0.02;
  try {
    const r = bls(preprocess(lc, 0.5), {
      minPeriodDays: periodDays * (1 - band),
      maxPeriodDays: periodDays * (1 + band),
      oversample: opts.oversample ?? 4,
      nDurations: opts.nDurations ?? 8,
    });
    return r.snr;
  } catch {
    return 0;
  }
}

export interface WindowAliasReport {
  periodDays: number;
  snrBest: number; // SNR at the reported (true) period
  bestAliasPeriodDays: number; // the +/- n c/d alias period that explains the data best
  snrAtBestAlias: number; // SNR at that alias
  ambiguity: number; // snrAtBestAlias / snrBest, in [0, 1] -- near 1 means the alias is nearly as good
  dailyWindowPower: number; // spectral-window power at 1 c/d (the classic daily-alias projector)
  sidelobeFreqCpd: number; // the dominant window sidelobe frequency found in [0.4, 2.2] c/d
  sidelobePower: number; // its normalized power
  windowAliasRisk: number; // ambiguity gated by the window's ability to project it: ambiguity * max(dailyPower, sidelobe)
}

/**
 * Characterize the window-alias ambiguity of one candidate. `periodDays` is the detector's chosen period; we fold
 * at its +/- n c/d aliases and report how close the best alias comes, together with the sampling's own window
 * power (which decides whether the closeness is a window artifact or just two real signals).
 */
export function windowAliasAmbiguity(
  lc: LightCurve,
  periodDays: number,
  opts: { maxOrder?: number; oversample?: number; nDurations?: number; bandFrac?: number } = {},
): WindowAliasReport {
  const times = finiteTimes(lc);
  const snrBest = snrAtPeriod(lc, periodDays, opts);
  const aliases = dailyAliasPeriods(periodDays, opts.maxOrder ?? 1);
  let bestAlias = periodDays;
  let bestAliasSnr = 0;
  for (const pa of aliases) {
    const s = snrAtPeriod(lc, pa, opts);
    if (s > bestAliasSnr) {
      bestAliasSnr = s;
      bestAlias = pa;
    }
  }
  const side = strongestWindowSidelobe(times);
  const daily = spectralWindowPower(times, 1);
  const ambiguity = snrBest > 0 ? Math.min(1, bestAliasSnr / snrBest) : 0;
  const windowAliasRisk = ambiguity * Math.max(daily, side.power);
  return {
    periodDays,
    snrBest,
    bestAliasPeriodDays: bestAlias,
    snrAtBestAlias: bestAliasSnr,
    ambiguity,
    dailyWindowPower: daily,
    sidelobeFreqCpd: side.freqCpd,
    sidelobePower: side.power,
    windowAliasRisk,
  };
}
