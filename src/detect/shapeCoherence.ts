// IN-TRANSIT SHAPE COHERENCE -- a cheap, single-observation spike-vs-transit consistency statistic.
//
// WHY THIS EXISTS. p26 (npm run p26:corroboration) measured that cross-sector corroboration (L4) is a
// powerful FP control but its completeness cost is brutal on a shallow single-pass FFI sample. The
// residual FPs that survive the empirical-FAP gate AND the multi-host coincidence collapse (L3) are
// typically single-host coherent instrumental features -- one bright spike, a bad column, an
// attitude-glitch artifact -- that BLS happily folds into a "box" at some period because the box-mean
// is dominated by that one anomalous sample. A real transit, by contrast, repeats at every epoch and
// fills its own box consistently: the median in-box drop approximates the mean.
//
// THE STATISTIC. Given a BLS result, re-fold the raw curve at the reported (period, epoch) and split
// points into in-box and out-of-box by the reported duration. Compute the median in-box flux drop
// relative to the out-of-box baseline, divide by the BLS box-mean depth. Values near 1 mean every
// in-transit sample is consistently dark (a real transit); values near 0 mean the box's mean depth is
// carried by a handful of outliers (a spike / one bad pixel column / an attitude glitch).
//
// This is MEASURE-ONLY for now -- it is NOT wired into any verdict or gate. It is a candidate
// structural discriminator for the FP class that significance gates cannot touch; calibration on
// real confirmed planets (a p2-vet-calibrate-style study) precedes any use, same as the pixel
// centroid threshold. PURE + DETERMINISTIC + RESEARCH-ONLY. No network, no worker import, cannot
// touch a verdict / bundle hash / money path.

import type { LightCurve } from "../core/types.ts";
import type { BLSResult } from "./bls.ts";

export interface CoherenceResult {
  /** Median in-box depth over the out-of-box baseline, in the same flux units as the input. */
  medianDepth: number;
  /** The BLS box-mean depth (fractional, positive for a dip). Kept for reference. */
  meanDepth: number;
  /** Robust ratio medianDepth / meanDepth. Near 1 => a coherent transit; near 0 => a one-point spike. NaN if undefined. */
  ratio: number;
  /** Cadence count inside the BLS box; a box with <3 samples is not measurable. */
  nInTransit: number;
  /** Cadence count outside the box used for the baseline; too few => NaN. */
  nOutTransit: number;
}

function frac(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * Compute the in-transit shape-coherence ratio for one BLS detection on one light curve.
 * A real periodic transit fills its own box consistently and returns ratio ~ 1; a one-point
 * instrumental spike returns ratio ~ 0. Non-finite period/epoch/duration or too few samples
 * return ratio NaN -- the statistic refuses to fabricate an answer.
 */
export function shapeCoherence(lc: LightCurve, r: BLSResult): CoherenceResult {
  const meanDepth = r.depth;
  if (!Number.isFinite(r.periodDays) || r.periodDays <= 0) {
    return { medianDepth: NaN, meanDepth, ratio: NaN, nInTransit: 0, nOutTransit: 0 };
  }
  if (!Number.isFinite(r.durationDays) || r.durationDays <= 0 || r.durationDays >= r.periodDays) {
    return { medianDepth: NaN, meanDepth, ratio: NaN, nInTransit: 0, nOutTransit: 0 };
  }
  const halfDur = r.durationDays / 2;
  const epoch = r.epochBjd;
  const inBoxFlux: number[] = [];
  const outBoxFlux: number[] = [];
  for (const p of lc.points) {
    if (!Number.isFinite(p.time) || !Number.isFinite(p.flux)) continue;
    const ph = frac((p.time - epoch) / r.periodDays + 0.5); // 0.5 = transit center under our fold convention
    // distance from transit center in phase-space, wrapped to [0, 0.5] in period units
    const dPhase = Math.abs(ph - 0.5); // already in [0, 0.5]
    const dDays = dPhase * r.periodDays;
    if (dDays <= halfDur) inBoxFlux.push(p.flux);
    else outBoxFlux.push(p.flux);
  }
  const nIn = inBoxFlux.length;
  const nOut = outBoxFlux.length;
  if (nIn < 3 || nOut < 10) {
    return { medianDepth: NaN, meanDepth, ratio: NaN, nInTransit: nIn, nOutTransit: nOut };
  }
  const outMed = median(outBoxFlux);
  const inMed = median(inBoxFlux);
  const medianDepth = outMed - inMed; // positive for a dip, matches BLS mean-depth sign convention
  const ratio = meanDepth > 0 ? medianDepth / meanDepth : NaN;
  return { medianDepth, meanDepth, ratio, nInTransit: nIn, nOutTransit: nOut };
}

export interface BoxDepth {
  depth: number; // out-of-box mean minus in-box mean; POSITIVE for a dip, NaN if not measurable
  nIn: number; // cadences inside the transit box
  nOut: number; // cadences used for the out-of-box baseline
}

/**
 * Mean in-transit depth when folding a light curve at a FIXED ephemeris (period, epoch, duration) that is
 * NOT derived from this curve. This is the per-sector confirmation step of a JOINT multi-sector search:
 * once a precise period is fit on the long stitched baseline, a real planet must show a positive dip in
 * EACH independent sector at that same ephemeris, whereas a single-sector artifact will not recur where it
 * was not generated. Guards mirror shapeCoherence: non-finite/incoherent ephemeris or too few samples ->
 * NaN (the statistic refuses to fabricate an answer). Pure, deterministic, research-only.
 */
export function foldedBoxDepth(lc: LightCurve, periodDays: number, epochBjd: number, durationDays: number): BoxDepth {
  if (
    !Number.isFinite(periodDays) || periodDays <= 0 ||
    !Number.isFinite(epochBjd) ||
    !Number.isFinite(durationDays) || durationDays <= 0 || durationDays >= periodDays
  ) {
    return { depth: NaN, nIn: 0, nOut: 0 };
  }
  const half = durationDays / 2;
  const inF: number[] = [];
  const outF: number[] = [];
  for (const p of lc.points) {
    if (!Number.isFinite(p.time) || !Number.isFinite(p.flux)) continue;
    const ph = frac((p.time - epochBjd) / periodDays + 0.5);
    const dDays = Math.abs(ph - 0.5) * periodDays;
    if (dDays <= half) inF.push(p.flux);
    else outF.push(p.flux);
  }
  if (inF.length < 3 || outF.length < 10) return { depth: NaN, nIn: inF.length, nOut: outF.length };
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  return { depth: mean(outF) - mean(inF), nIn: inF.length, nOut: outF.length };
}
