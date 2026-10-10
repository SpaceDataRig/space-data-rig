// Injection-recovery: the standard way to prove a transit pipeline "really works".
// We inject planets with KNOWN periods/depths into realistic synthetic light curves,
// run the full detection chain (preprocess -> BLS), and measure how often and how
// accurately the truth is recovered. This is sim-runner's completeness engine and
// the P0 acceptance benchmark.

import { preprocess } from "../detect/detrend.ts";
import { bls } from "../detect/bls.ts";
import { resolvePeriodAlias } from "./aliasResolver.ts";
import { generateSyntheticTransit, rng, type InjectedTruth } from "../data/synthetic.ts";
import { mainSequenceMassFromRadius } from "./transitModel.ts";

export interface TrialResult {
  seed: number;
  injectedPeriod: number;
  requestedDepthPpm: number; // the pool value we aimed for (for binning)
  injectedDepthPpm: number; // achieved central depth (limb-darkened)
  injectedDurationHours: number;
  recoveredPeriod: number | null;
  recoveredDepthPpm: number | null;
  snr: number | null;
  recovered: boolean; // recovered allowing alias/harmonic resolution
  recoveredRaw: boolean; // recovered at the true period (alias factor 1)
  periodErrorPct: number | null;
  depthErrorPct: number | null;
  aliasFactor: number | null; // which harmonic matched (1, 0.5, 2, ...)
  aliasMultiple: number | null; // odd-even resolver multiple (1/2/3)
}

export interface BenchmarkSummary {
  nTrials: number;
  nRecovered: number;
  recoveryRate: number;
  nRecoveredRaw: number;
  recoveryRateRaw: number;
  medianPeriodErrorPct: number;
  medianDepthErrorPct: number;
  medianSnr: number;
  /** Recovery rate binned by requested injected depth (ppm). */
  byDepthBin: { bin: string; n: number; recovered: number; rate: number }[];
}

/** true if recovered period matches truth, allowing common harmonics/aliases. */
function matchPeriod(rec: number, truth: number, tolPct: number): number | null {
  const factors = [1, 0.5, 2, 1 / 3, 3, 2 / 3, 3 / 2, 1.5];
  for (const f of factors) {
    const cand = rec * f;
    const err = Math.abs(cand - truth) / truth;
    if (err <= tolPct / 100) return f;
  }
  return null;
}

export interface BenchmarkOptions {
  nTrials?: number;
  seed?: number;
  minPeriodDays?: number;
  maxPeriodDays?: number;
  depthsPpm?: number[]; // pool of injected depths
  noisePpm?: number;
  cadenceSec?: number;
  baselineDays?: number;
  periodTolPct?: number;
  minSnr?: number; // reject detections below this SNR
}

export function runInjectionRecovery(o: BenchmarkOptions = {}): { trials: TrialResult[]; summary: BenchmarkSummary } {
  const nTrials = o.nTrials ?? 60;
  const rand = rng(o.seed ?? 12345);
  const depths = o.depthsPpm ?? [300, 500, 1000, 2000, 5000, 10000];
  const minP = o.minPeriodDays ?? 1;
  const maxP = o.maxPeriodDays ?? 12;
  const noisePpm = o.noisePpm ?? 200;
  const tol = o.periodTolPct ?? 2;
  const minSnr = o.minSnr ?? 5;

  const trials: TrialResult[] = [];
  for (let i = 0; i < nTrials; i++) {
    const seed = 1000 + i;
    const periodDays = minP + rand() * (maxP - minP);
    const depthPpm = depths[Math.floor(rand() * depths.length)];
    const impactParam = rand() * 0.6; // 0..0.6, all transiting
    const stellarRadiusRsun = 0.7 + rand() * 0.8;
    const { lc, truth } = generateSyntheticTransit({
      seed,
      periodDays,
      depthFrac: depthPpm * 1e-6,
      impactParam,
      stellarRadiusRsun,
      stellarMassMsun: mainSequenceMassFromRadius(stellarRadiusRsun), // empirical main-sequence M-R
      noisePpm,
      cadenceSec: o.cadenceSec ?? 120,
      baselineDays: o.baselineDays ?? 27,
      targetIdLabel: `INJ-${seed}`,
    });

    let rec: TrialResult = {
      seed,
      injectedPeriod: truth.periodDays,
      requestedDepthPpm: depthPpm,
      injectedDepthPpm: truth.depthFrac * 1e6,
      injectedDurationHours: truth.durationHours,
      recoveredPeriod: null,
      recoveredDepthPpm: null,
      snr: null,
      recovered: false,
      recoveredRaw: false,
      periodErrorPct: null,
      depthErrorPct: null,
      aliasFactor: null,
      aliasMultiple: null,
    };

    try {
      const clean = preprocess(lc, 0.5);
      const r = bls(clean, {
        minPeriodDays: minP * 0.7,
        maxPeriodDays: maxP * 1.4,
        oversample: 6,
        nDurations: 8,
      });
      // Odd-even alias resolution: recover the TRUE period from a possible P/2, P/3 peak.
      const cTimes = clean.points.map((p) => p.time);
      const cFlux = clean.points.map((p) => p.flux);
      const al = resolvePeriodAlias(cTimes, cFlux, r.periodDays, r.epochBjd, r.durationDays);
      const resolvedP = al.period;
      const f = matchPeriod(resolvedP, truth.periodDays, tol);
      rec.recoveredPeriod = resolvedP;
      rec.recoveredDepthPpm = r.depth * 1e6;
      rec.snr = r.snr;
      rec.aliasMultiple = al.multiple;
      if (f != null && r.snr >= minSnr) {
        rec.recovered = true;
        rec.recoveredRaw = Math.abs(f - 1) < 1e-9;
        rec.aliasFactor = f;
        rec.periodErrorPct = (Math.abs(resolvedP * f - truth.periodDays) / truth.periodDays) * 100;
        rec.depthErrorPct = (Math.abs(r.depth * 1e6 - truth.depthFrac * 1e6) / (truth.depthFrac * 1e6)) * 100;
      }
    } catch {
      // detection failed -> not recovered
    }
    trials.push(rec);
  }

  const recovered = trials.filter((t) => t.recovered);
  const recoveredRaw = trials.filter((t) => t.recoveredRaw);
  const med = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const byDepthBin = depths.map((d) => {
    const inBin = trials.filter((t) => Math.abs(t.requestedDepthPpm - d) < 1);
    const rec = inBin.filter((t) => t.recovered).length;
    return {
      bin: `${d} ppm`,
      n: inBin.length,
      recovered: rec,
      rate: inBin.length ? rec / inBin.length : 0,
    };
  });

  const summary: BenchmarkSummary = {
    nTrials: trials.length,
    nRecovered: recovered.length,
    recoveryRate: trials.length ? recovered.length / trials.length : 0,
    nRecoveredRaw: recoveredRaw.length,
    recoveryRateRaw: trials.length ? recoveredRaw.length / trials.length : 0,
    medianPeriodErrorPct: med(recovered.map((t) => t.periodErrorPct!)),
    medianDepthErrorPct: med(recovered.map((t) => t.depthErrorPct!)),
    medianSnr: med(recovered.map((t) => t.snr!)),
    byDepthBin,
  };
  return { trials, summary };
}
