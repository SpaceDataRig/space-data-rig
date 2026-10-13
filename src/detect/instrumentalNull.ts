// SYSTEMATICS-INCLUSIVE NULL + ENSEMBLE FDR -- the root-cause false-positive lever.
//
// WHY THIS EXISTS (the honest gap it closes). The per-candidate gate we already ship,
// calibratedFap (src/detect/significance.ts), draws its null ensemble from the target's OWN
// red-noise color. Our own measurements (scripts/p23-candidate-validation.ts, p31-common-mode-fp.ts)
// proved that gate barely moves the blind false-positive rate (25% -> 23%) because the surviving
// false positives are NOT random noise: they are COHERENT INSTRUMENTAL SYSTEMATICS -- a dip/spike
// shared by MANY unrelated stars at the SAME cadence (scattered light, thermal settling, momentum
// dumps, CCD-level events). Such an artifact is significant against a single star's own noise, so a
// noise-only null calls it a planet. commonMode.ts already MEASURES that shared component (the robust
// ensemble median per cadence) but only uses it to SUBTRACT; the subtraction helps at source, yet the
// significance decision still never accounts for what the systematic alone can manufacture.
//
// THE FIX. Put the measured coherent systematic INTO the null hypothesis. A planet-free null here is
//   templateOnCadence(coherent systematic)  +  the target's own AR(1) noise,
// drawn on the target's EXACT sampling so observed and null are apples-to-apples. Then the false-alarm
// probability answers: "how often does the shared instrumental signal PLUS this star's noise, with NO
// planet, reach the observed BLS SNR?" A coherent instrumental false positive IS the template, so the
// null reproduces it -> high FAP -> correctly declined. A genuine transit is a SINGLE star's signal that
// is diluted ~1/N out of the ensemble median and therefore ABSENT from the template, so the null cannot
// reach its SNR -> low FAP -> it survives. This is precisely the FP class the noise-only gate cannot see.
//
// ENSEMBLE FDR. A per-trial FAP threshold lets the expected FALSE-POSITIVE COUNT scale with the survey
// size (alpha x trials), which is exactly why the FP rate stays ~28-30% as the ensemble grows. We add a
// Benjamini-Hochberg step-up (benjaminiHochberg) so the survey-wide FALSE DISCOVERY RATE is bounded at a
// target q regardless of how many stars are searched -- FP control by construction, not by tuning.
//
// PURE, DETERMINISTIC, RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash
// / money path. Never mutates its inputs. Every random draw is a seeded mulberry32, so identical light
// curves always yield identical significance -- the same guarantee the certified real-photometry path uses.

import type { LightCurve } from "../core/types.ts";
import { preprocess, median, madSigma } from "./detrend.ts";
import { bls } from "./bls.ts";
import { estimateRho, ar1Series, detrendMovingMedian } from "../sim/redNoise.ts";
import { empiricalFap } from "../sim/roc.ts";
import { commonModeTemplate, type CommonModeBin, type CommonModeTemplate } from "./commonMode.ts";

/** Local deterministic PRNG (mulberry32) so the module owns its randomness; identical seeds -> identical stream. */
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

/** Robust residual scatter (ppm) after a moving-median detrend + MAD -- the same recipe as significance.ts. */
function residualScatterPpm(flux: number[]): number {
  const resid = detrendMovingMedian(flux, 15);
  const finite = resid.filter((v) => Number.isFinite(v));
  if (finite.length < 10) return 200;
  const mad = madSigma(finite) || 1;
  return Math.max(20, Math.min(5000, mad * 1e6));
}

export interface InstrumentalNullOptions {
  nNull?: number; // null ensemble size (default 120 -> resolution floor 1/(nNull+1) ~ 0.008)
  seed?: number; // fixed -> deterministic (default 4242)
  minStars?: number; // ensemble size to build a template (default 8)
  minStarsPerBin?: number; // distinct stars per cadence bin to trust it (default 5)
  spikeGateSigma?: number; // if >0, the template keeps only anomalously large shared excursions (see commonMode)
  timeTolDays?: number; // cadence-bin matching tolerance for the template (default 0.0005 d ~ 43 s)
  gridOversample?: number; // BLS frequency oversampling for the null grid (default 6)
  gridNDurations?: number; // BLS trial durations for the null grid (default 8)
  minPeriodDays?: number; // null-grid lower bound (default max(0.5, 0.7*period))
  maxPeriodDays?: number; // null-grid upper bound (default 1.5*period)
  /**
   * A PRE-BUILT coherent template to reuse across many candidates from the SAME ensemble. commonModeTemplate
   * is O(ensemble points) and building it per candidate makes an ensemble sweep quadratic; a caller that
   * scores many stars against one sector ensemble builds the template ONCE and passes it here (the `ensemble`
   * argument is then ignored). Identical result to building it internally from the same curves.
   */
  template?: CommonModeTemplate;
}

export interface InstrumentalSignificance {
  fapSys: number; // false-alarm probability under the noise + coherent-systematics null
  exceedances: number; // nulls that reached the observed SNR
  nNull: number; // nulls actually evaluated
  snrObs: number; // observed candidate BLS SNR (as passed in)
  nullSnrMedian: number; // median null SNR -- the SNR a planet-free systematic+noise curve typically reaches
  nullSnrP95: number; // 95th percentile null SNR
  templateApplied: boolean; // false => ensemble too small to model the systematic; nulls were noise-only (honest fallback)
  templatePeakSnr: number; // BLS SNR of the coherent template alone near the candidate period (the instrumental floor)
  templateRmsPpm: number; // RMS of the trusted template values, in ppm
  rho: number; // AR(1) lag-1 autocorrelation estimated from this target
  noisePpm: number; // residual scatter estimated from this target
}

/**
 * Map the coherent template onto a curve's OWN cadence times: for each time take the nearest trusted
 * bin value within `tolDays`, else 0 (a gap in the ensemble coverage carries no shared correction).
 * Pure + deterministic; `bins` must be sorted by time (commonModeTemplate guarantees it).
 */
export function templateOnTimes(bins: CommonModeBin[], times: number[], tolDays: number): number[] {
  const out = new Array<number>(times.length).fill(0);
  if (!bins.length) return out;
  const bt = bins.map((b) => b.time);
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    // binary search for the insertion point, then check the two neighbours for the nearest within tol
    let lo = 0;
    let hi = bt.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bt[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestD = Infinity;
    for (const k of [lo - 1, lo, lo + 1]) {
      if (k < 0 || k >= bt.length) continue;
      const d = Math.abs(bt[k]! - t);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0 && bestD <= tolDays) out[i] = bins[best]!.value;
  }
  return out;
}

/**
 * The coherent systematic's OWN BLS peak near a candidate period: fold the template-as-a-light-curve and
 * run BLS over the same grid the nulls use. This is the "instrumental floor" -- the SNR the shared signal
 * alone can manufacture at that period. A candidate barely above it is indistinguishable from a systematic.
 * Returns 0 when the template is empty / BLS cannot run (too few bins or a degenerate curve).
 */
export function templatePeakSnr(bins: CommonModeBin[], periodDays: number, opts: InstrumentalNullOptions = {}): number {
  if (!bins || bins.length < 30) return 0;
  const values = bins.map((b) => b.value);
  const err = (madSigma(values) || 1e-6) / 10;
  const curve: LightCurve = {
    targetId: "common-mode-template",
    mission: "synthetic",
    points: bins.map((b) => ({ time: b.time, flux: 1 + b.value, fluxErr: Math.max(err, 1e-9) })),
    source: "coherent common-mode template (systematics-inclusive null diagnostic)",
  };
  const grid = nullGrid(periodDays, opts);
  try {
    return bls(preprocess(curve, 0.5), grid).snr;
  } catch {
    return 0;
  }
}

function nullGrid(periodDays: number, opts: InstrumentalNullOptions) {
  const minP = opts.minPeriodDays ?? Math.max(0.5, periodDays * 0.7);
  const maxP = opts.maxPeriodDays ?? periodDays * 1.5;
  return { minPeriodDays: minP, maxPeriodDays: maxP, oversample: opts.gridOversample ?? 6, nDurations: opts.gridNDurations ?? 8 };
}

/**
 * Calibrate one candidate's BLS SNR against a null that includes the ENSEMBLE-MEASURED coherent systematic,
 * not just the target's own noise. `ensemble` is the same-cadence group of stars the template is built from
 * (e.g. one sector / one CCD); it must EXCLUDE any planet being tested (build it from the raw quiet ensemble
 * BEFORE injecting -- the honest preprocess-then-detect order used by p31). When the ensemble is too small to
 * define a trusted template (`templateApplied` false), the null degrades gracefully to noise-only, which is
 * exactly the old calibratedFap behaviour and is flagged so a caller cannot mistake it for systematic-aware.
 */
export function systematicsAwareFap(
  lc: LightCurve,
  observedSnr: number,
  periodDays: number,
  ensemble: LightCurve[],
  opts: InstrumentalNullOptions = {},
): InstrumentalSignificance {
  const nNull = Math.max(8, opts.nNull ?? 120);
  const seed = opts.seed ?? 4242;
  const tol = opts.timeTolDays != null && opts.timeTolDays > 0 ? opts.timeTolDays : 0.0005;

  const pts = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
  const times = pts.map((p) => p.time);
  const flux = pts.map((p) => p.flux);
  const cadenceSec = lc.cadenceSec && lc.cadenceSec > 0 ? lc.cadenceSec : 120;

  if (times.length < 30) {
    // Too short to model anything: report an uninformative FAP (1) with the noise-only fallback flag set.
    return {
      fapSys: 1, exceedances: 0, nNull: 0, snrObs: observedSnr,
      nullSnrMedian: NaN, nullSnrP95: NaN, templateApplied: false, templatePeakSnr: 0,
      templateRmsPpm: 0, rho: 0, noisePpm: 200,
    };
  }

  const rhoRaw = estimateRho(flux);
  const rho = Number.isFinite(rhoRaw) ? Math.max(0, Math.min(0.9, rhoRaw)) : 0;
  const noisePpm = residualScatterPpm(flux);

  const tmpl = opts.template ?? commonModeTemplate(ensemble, {
    minStars: opts.minStars ?? 8,
    minStarsPerBin: opts.minStarsPerBin ?? 5,
    timeTolDays: tol,
    spikeGateSigma: opts.spikeGateSigma,
  });
  const templateApplied = tmpl.applied;
  const shared = templateApplied ? templateOnTimes(tmpl.bins, times, tol) : new Array<number>(times.length).fill(0);
  const peak = templateApplied ? templatePeakSnr(tmpl.bins, periodDays, opts) : 0;

  const grid = nullGrid(periodDays, opts);
  const nullSnr: number[] = [];
  for (let j = 0; j < nNull; j++) {
    const rand = mulberry32(seed + j);
    const noise = ar1Series(rand, times.length, noisePpm * 1e-6, rho);
    const points = times.map((t, i) => ({ time: t, flux: 1 + shared[i]! + noise[i]!, fluxErr: Math.max(noisePpm * 1e-6, 1e-9) }));
    const nullLc: LightCurve = {
      targetId: `SYSNULL-${j}`,
      mission: "synthetic",
      cadenceSec,
      points,
      source: "systematics-inclusive null (coherent template + target AR(1) noise, no planet)",
    };
    try {
      nullSnr.push(bls(preprocess(nullLc, 0.5), grid).snr);
    } catch {
      /* a degenerate null that throws counts as a zero-statistic curve (dropped, honest) */
    }
  }

  const { fap, exceedances } = empiricalFap(nullSnr, observedSnr);
  const sorted = [...nullSnr].sort((a, b) => a - b);
  const q = (frac: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))]! : NaN);
  return {
    fapSys: fap,
    exceedances,
    nNull: nullSnr.length,
    snrObs: observedSnr,
    nullSnrMedian: median(sorted),
    nullSnrP95: q(0.95),
    templateApplied,
    templatePeakSnr: peak,
    templateRmsPpm: tmpl.rmsPpm,
    rho,
    noisePpm,
  };
}

export interface FdrResult {
  q: number; // the target false-discovery rate
  threshold: number; // the BH critical p-value (largest p among the rejected); 0 if none rejected
  rejected: boolean[]; // per-input flag: true where the null is rejected at FDR q
  nRejected: number; // count of rejections (the expected discoveries at FDR q)
}

/**
 * Benjamini-Hochberg step-up over an ensemble of p-values. Sort p ascending; reject all p up to the
 * largest rank k satisfying p_(k) <= (k/m) * q. This bounds the survey-wide false-discovery rate at q
 * regardless of the number of stars searched -- the ensemble-level FP control a per-trial FAP threshold
 * cannot give (where expected FP count grows as alpha x m). Pure + deterministic (sort tie-broken by index).
 */
export function benjaminiHochberg(pvals: number[], q: number): FdrResult {
  const m = pvals.length;
  const rejected = new Array<boolean>(m).fill(false);
  if (m === 0) return { q, threshold: 0, rejected, nRejected: 0 };
  const qc = Math.max(0, Math.min(1, q));
  const order = pvals.map((p, i) => ({ p: Number.isFinite(p) ? p : 2, i })).sort((a, b) => (a.p - b.p) || (a.i - b.i));
  let maxK = 0;
  for (let rank = 1; rank <= m; rank++) {
    const p = order[rank - 1]!.p;
    if (p <= (rank / m) * qc) maxK = rank;
  }
  let threshold = 0;
  for (let rank = 1; rank <= maxK; rank++) {
    rejected[order[rank - 1]!.i] = true;
    threshold = order[rank - 1]!.p;
  }
  return { q: qc, threshold, rejected, nRejected: maxK };
}
