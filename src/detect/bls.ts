// Box Least Squares (BLS) transit search.
// Signal-residue statistic from Kovacs, Zucker & Mazeh (2002), the same method
// behind astropy.stats.BoxLeastSquares / lightkurve. anomaly-scout's engine.
// Includes period-doubling refinement so we report the TRUE period, not P/2 aliases.
// Pure TS, no deps.

import type { LightCurve, TransitCandidate } from "../core/types.ts";
import { madSigma } from "./detrend.ts";

export interface BLSOptions {
  minPeriodDays?: number;
  maxPeriodDays?: number;
  oversample?: number; // frequency oversampling (higher = finer, slower)
  minDurationHours?: number;
  maxDurationHours?: number;
  nDurations?: number; // number of log-spaced trial durations
  refineHarmonics?: boolean; // test 2P, 3P to defeat half-period aliases
}

export interface BLSResult {
  periodDays: number;
  epochBjd: number;
  durationDays: number;
  depth: number; // fractional depth (positive for a dip)
  power: number;
  snr: number;
  nInTransit: number;
  folded: { phase: number; flux: number }[];
  periodGrid: { period: number; power: number }[];
  /** Baseline of the (preprocessed) series the grid was built from, in days. */
  baselineDays: number;
  /** The long-period wall of this search: 1/fMin, i.e. options.maxPeriodDays. */
  searchMaxPeriodDays: number;
  /** Grid-limited period uncertainty of the adopted node: P^2 * df. */
  periodResolutionDays: number;
  /**
   * True when the adopted node is k=0, the longest period the grid tried. A peak that lands ON the wall is not a
   * measurement of that period -- it is the search running out of range -- so it must be reported as a limit.
   */
  atSearchBoundary: boolean;
  /**
   * The out-of-box MAD scatter the SNR was divided by, as a flux fraction. `snr = depth/sigma*sqrt(nIn)`, so
   * without this the quoted SNR cannot be checked against a quoted depth -- which is how a record could publish
   * a 38 ppm depth beside an SNR that only a 6100 ppm depth produces on the same noise (see the guard in
   * src/detect/depthAdoption.ts).
   */
  noiseSigmaFrac: number;
}

const DEFAULTS: Required<BLSOptions> = {
  minPeriodDays: 0.5,
  maxPeriodDays: 15,
  oversample: 8,
  minDurationHours: 0.5,
  maxDurationHours: 15,
  nDurations: 10,
  // Power-based doubling is unreliable (the alias can score higher); the
  // odd-even resolver in src/sim/aliasResolver.ts is used instead.
  refineHarmonics: false,
};

/**
 * CADENCE-AWARE search options (roadmap item 9, OPT-IN). A box narrower than the sampling cannot
 * be resolved: at TESS 30-min FFI a default minDurationHours of 0.5 makes a trial box that spans a
 * single sample, which wastes the duration grid and can smear a shallow dip. This returns options
 * that keep the smallest trial box at least `minSamplesInBox` samples wide for the given cadence.
 *
 * IMPORTANT: it does NOT change bls()'s or detectTransit()'s DEFAULT behaviour -- the certified
 * real-photometry path calls them with no opts and is byte-for-byte unchanged (so the worker bundle
 * is untouched). A coarse-cadence caller opts in by spreading the result into its BLSOptions.
 */
export function cadenceAwareOptions(
  cadenceSec: number,
  o: { minSamplesInBox?: number; minDurationFloorHours?: number; maxDurationCeilHours?: number; oversample?: number } = {},
): BLSOptions {
  const k = Math.max(2, o.minSamplesInBox ?? 3);
  const raw = Number.isFinite(cadenceSec) && cadenceSec > 0 ? (k * cadenceSec) / 3600 : 0.5;
  const floorH = o.minDurationFloorHours ?? 0.5;
  const ceilH = o.maxDurationCeilHours ?? 15;
  const out: BLSOptions = { minDurationHours: Math.min(ceilH, Math.max(floorH, raw)) };
  if (o.oversample != null) out.oversample = o.oversample;
  return out;
}

function logSpace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  const out: number[] = [];
  const la = Math.log(a);
  const lb = Math.log(b);
  for (let i = 0; i < n; i++) out.push(Math.exp(la + ((lb - la) * i) / (n - 1)));
  return out;
}

function frac(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

interface Box {
  power: number;
  duration: number;
  Swy: number;
  Sw: number;
  iStart: number;
  iEnd: number;
  phaseCenter: number;
}

/** Fold, sort and run the sliding-box search at one fixed period. O(N log N + N*ndur). */
function boxSearchAtPeriod(
  times: number[],
  y: number[],
  w: number[],
  order: number[],
  ph: Float64Array,
  ph2: Float64Array,
  y2: Float64Array,
  w2: Float64Array,
  cW: Float64Array,
  cWY: Float64Array,
  period: number,
  durations: number[],
): Box | null {
  const n = times.length;
  const f = 1 / period;
  const tRef = times[0];
  for (let i = 0; i < n; i++) {
    ph[i] = frac((times[i] - tRef) * f);
    order[i] = i;
  }
  order.sort((a, b) => ph[a] - ph[b]);
  for (let i = 0; i < n; i++) {
    const idx = order[i];
    ph2[i] = ph[idx];
    y2[i] = y[idx];
    w2[i] = w[idx];
    ph2[i + n] = ph[idx] + 1;
    y2[i + n] = y[idx];
    w2[i + n] = w[idx];
  }
  cW[0] = 0;
  cWY[0] = 0;
  for (let i = 0; i < 2 * n; i++) {
    cW[i + 1] = cW[i] + w2[i];
    cWY[i + 1] = cWY[i] + w2[i] * y2[i];
  }
  let best: Box | null = null;
  for (const dur of durations) {
    const wd = dur / period;
    if (wd <= 0 || wd >= 1) continue;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      const limit = ph2[i] + wd;
      while (j < 2 * n && ph2[j] < limit) j++;
      const Sw = cW[j] - cW[i];
      if (Sw <= 1e-6 || Sw >= 1 - 1e-6) continue;
      const Swy = cWY[j] - cWY[i];
      const power = (Swy * Swy) / (Sw * (1 - Sw));
      if (!best || power > best.power) {
        best = {
          power,
          duration: dur,
          Swy,
          Sw,
          iStart: i,
          iEnd: j,
          phaseCenter: frac((ph2[i] + ph2[j - 1]) / 2),
        };
      }
    }
  }
  return best;
}

export function bls(lc: LightCurve, opts: BLSOptions = {}): BLSResult {
  const o = { ...DEFAULTS, ...opts };
  const pts = lc.points.filter((p) => isFinite(p.time) && isFinite(p.flux));
  if (pts.length < 30) throw new Error(`BLS: too few points (${pts.length}) for ${lc.targetId}`);

  const times = pts.map((p) => p.time);
  const flux = pts.map((p) => p.flux);
  const hasErr = pts.every((p) => p.fluxErr != null && p.fluxErr > 0);
  const rawW = hasErr ? pts.map((p) => 1 / (p.fluxErr! * p.fluxErr!)) : pts.map(() => 1);
  const Wsum = rawW.reduce((a, b) => a + b, 0);
  const w = rawW.map((x) => x / Wsum);
  let ybar = 0;
  for (let i = 0; i < flux.length; i++) ybar += w[i] * flux[i];
  const y = flux.map((f) => f - ybar);

  const n = times.length;
  const tRef = times[0];
  const baseline = Math.max(...times) - Math.min(...times);
  const durations = logSpace(o.minDurationHours / 24, o.maxDurationHours / 24, o.nDurations).filter(
    (d) => d < baseline / 2,
  );

  const fMin = 1 / o.maxPeriodDays;
  const fMax = 1 / o.minPeriodDays;
  const df = 1 / (o.oversample * baseline);
  const nFreq = Math.max(1, Math.min(20000, Math.ceil((fMax - fMin) / df)));

  const order = new Array<number>(n);
  const ph = new Float64Array(n);
  const ph2 = new Float64Array(2 * n);
  const y2 = new Float64Array(2 * n);
  const w2 = new Float64Array(2 * n);
  const cW = new Float64Array(2 * n + 1);
  const cWY = new Float64Array(2 * n + 1);

  let bestPeriod = 1 / fMin;
  let bestAtBoundary = true; // the initial best is the k=0 node, before any box has been measured
  let bestBox: Box | null = null;
  const periodGrid: { period: number; power: number }[] = [];

  for (let k = 0; k <= nFreq; k++) {
    const P = 1 / (fMin + k * df);
    const box = boxSearchAtPeriod(times, y, w, order, ph, ph2, y2, w2, cW, cWY, P, durations);
    if (!box) continue;
    periodGrid.push({ period: P, power: box.power });
    if (!bestBox || box.power > bestBox.power) {
      bestBox = box;
      bestPeriod = P;
      bestAtBoundary = k === 0;
    }
  }
  if (!bestBox) throw new Error(`BLS: no valid box found for ${lc.targetId}`);

  // Period-doubling refinement: defeat the common P/2 half-period alias.
  // At a true period P, all transits stack at one phase; at the alias P/2 they
  // also stack, so power(P) ~= power(P/2). Doubling a GENUINE period splits the
  // transits and power collapses, so "adopt the longer period when power stays
  // within threshold" correctly picks the true period over its half alias.
  if (o.refineHarmonics) {
    const basePeriod = bestPeriod;
    const basePower = bestBox.power;
    for (const mult of [2, 3]) {
      const Pm = basePeriod * mult;
      if (Pm > o.maxPeriodDays * 3) continue;
      const boxM = boxSearchAtPeriod(times, y, w, order, ph, ph2, y2, w2, cW, cWY, Pm, durations);
      if (boxM && boxM.power >= 0.8 * basePower) {
        bestBox = boxM;
        bestPeriod = Pm;
        // bestAtBoundary is deliberately NOT recomputed: a period doubled off a k=0 node still came from a peak
        // that ran into the wall, and that is the only thing the flag claims.
      }
    }
  }

  const P = bestPeriod;
  const depth = -bestBox.Swy / (bestBox.Sw * (1 - bestBox.Sw));
  const epochBjd = tRef + bestBox.phaseCenter * P;
  const nIn = bestBox.iEnd - bestBox.iStart;

  const inBox = new Set<number>();
  for (let i = bestBox.iStart; i < bestBox.iEnd; i++) inBox.add(order[i % n]);
  const outVals: number[] = [];
  for (let i = 0; i < n; i++) if (!inBox.has(i)) outVals.push(y[i]);
  const sigma = madSigma(outVals) || madSigma(y) || 1e-6;
  const snr = (depth / sigma) * Math.sqrt(Math.max(1, nIn));

  const folded = times.map((t, i) => {
    let p = frac((t - epochBjd) / P + 0.5);
    if (p > 1) p -= 1;
    return { phase: p, flux: flux[i] };
  });
  folded.sort((a, b) => a.phase - b.phase);

  return {
    periodDays: P,
    epochBjd,
    durationDays: bestBox.duration,
    depth,
    power: bestBox.power,
    snr,
    nInTransit: nIn,
    folded,
    periodGrid,
    baselineDays: baseline,
    searchMaxPeriodDays: o.maxPeriodDays,
    // dP = |dP/df| * df = P^2 * df. This is the resolution the grid actually offered at the adopted period.
    periodResolutionDays: P * P * df,
    atSearchBoundary: bestAtBoundary,
    noiseSigmaFrac: sigma,
  };
}

export function toCandidate(lc: LightCurve, r: BLSResult): TransitCandidate {
  return {
    targetId: lc.targetId,
    periodDays: r.periodDays,
    epochBjd: r.epochBjd,
    durationHours: r.durationDays * 24,
    depthPpt: r.depth * 1000,
    depthFrac: r.depth,
    // The scout's own measurement, labelled as such: the record is allowed to publish a refined depth later, and
    // must never lose the number the detection was actually gated on (src/detect/depthAdoption.ts).
    depthSource: "bls-box",
    blsBoxDepthFrac: r.depth,
    snr: r.snr,
    periodResolutionDays: r.periodResolutionDays,
    atSearchBoundary: r.atSearchBoundary,
    noiseSigmaFrac: r.noiseSigmaFrac,
    searchMaxPeriodDays: r.searchMaxPeriodDays,
    power: r.power,
    nPointsInTransit: r.nInTransit,
    folded: r.folded,
  };
}
