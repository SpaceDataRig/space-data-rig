// Honest rendering of a transit depth produced by this pipeline.
//
// WHY this exists. P90 (`scripts/p90-depth-estimators.ts`, `reports/p90-depth-estimators.md`, 2026-10-18) is the
// first time the two depth estimators inside the production path were graded against a reference neither of them
// was fitted to -- the NASA Exoplanet Archive `pl_trandep`, on 16 period-matched confirmed planets. What came back:
//   median ABSOLUTE error   36.7%  the BLS step-function box the detector fits
//   median ABSOLUTE error   44.2%  the per-sector limb-darkened shape fit
//   median ABSOLUTE error   33.0%  what the adoption guard actually publishes
// Head to head the two estimators are NOT separable at that n (8/16 vs 8/16, exact two-sided sign test p = 1.00),
// so there is no basis for choosing between their error bars, and every one of them is of order a third.
//
// Meanwhile every surface printed the result as an integer number of ppm -- "660 ppm", "268 ppm" -- plus a percent
// to three decimals. That is a claim of roughly one-part-in-a-thousand precision, one to two orders of magnitude
// better than the agreement these estimators have actually demonstrated. The number itself is not wrong; the ABSENT
// error bar was, and an absent error bar on a public card is what a reader reads as precision.
//
// WHAT THE ERROR BAR IS MADE OF, and which term dominates:
//   - statistical: the fit's own scatter. The invariant this project publishes (src/detect/depthAdoption.ts) is
//     `snr = depthFrac / noiseSigmaFrac * sqrt(nPointsInTransit)`, so the 1-sigma relative error ON THE DEPTH is
//     1/|snr|. Computed per record, from numbers the record already carries.
//   - systematic: the estimator-vs-catalogue disagreement measured by P90, `DEPTH_SYSTEMATIC_REL`. It does NOT
//     shrink with SNR -- it is a property of which estimator survives and of the assumptions in any depth fit
//     (dilution, limb darkening, stellar density), not of how bright the star is. For every record the rig has
//     ever published this is the larger term, which is exactly why quoting 1/snr alone would have been the same
//     over-claim in a new costume.
// The two are combined in quadrature, and the result is quoted to ONE significant figure rounded UP (PDG-style,
// as `src/core/periodFormat.ts` already does for periods).
//
// WHY THE SYSTEMATIC IS THE 68% RADIUS AND NOT THE MEDIAN. A "+/-" is read as one standard deviation, which covers
// about two thirds of a symmetric distribution; a MEDIAN absolute error covers exactly half the rows. P90 measured
// both on the 16 period-matched rows (reports/p90-depth-estimators.md, "What error bar a published depth actually
// earns"): for the depth the guard publishes, median 33.0%, the radius covering 68% is 48.0%, and reaching 95%
// would need 104.4% with a worst row at 188.9%. `DEPTH_SYSTEMATIC_REL` is that 48% carried UP to one significant
// figure. Same correction p9 applied to its own depth bar (README: "Can we make the error bar honest?", where the
// bar had to be inflated by k = 3.2 before 68% of the catalogue-matched rows fell inside it) -- the repository has
// been asked this question before, and the answer was always 'the statistical bar is a lower bound'.
// The heavy tail is also why nothing here doubles the bar to advertise a 95% interval: at n=16 that number is an
// extrapolation, not a measurement.
//
// WHY THE VALUE KEEPS ITS DIGITS. The PDG rule would also round the value to the uncertainty's decimal place
// (660 +/- 300 -> 700 +/- 300). Deliberately not done here: the anchored bundle and the on-chain commitment carry
// `depthFrac` at full precision, so a card that printed a re-rounded value would disagree with the artifact it is
// describing -- and "the card and the bundle say different numbers" is a worse defect than one this function fixes.
// The value is therefore shown as published and the error bar is shown next to it, so the reader can see both the
// committed number and what it is worth.
//
// THE CONSERVATIVE DIRECTION, stated so it can be checked: the floor is the 68%-coverage radius of the WORSE of
// the two individual arms measured by P90 (per-sector 72.9% at 68% sits above the published arm's 48% because it
// includes the three fits the guard refused; the published arm is the population a card describes, so it is the
// figure used, and it is carried UP to one significant figure rather than down). Rounding the quoted uncertainty
// up and never down points the same way. If this module is ever wrong, it is wrong by admitting more error than
// the measurement supports.
//
// NOT A GATE. This is presentation only: no verdict, no check, no bundle field, no anchored hash, no posted
// science number changes through anything here. `web/honest-precision.js` carries the browser mirror of this
// function, and `tests/depth-honesty.test.ts` forces the two to agree on every input they can both receive.

/**
 * Systematic (not statistical) relative uncertainty on any depth this pipeline publishes: the 68%-coverage radius
 * P90 measured for the published depth (48.0% on 16 period-matched planets), carried UP to one significant figure.
 * See the header for why a median is not a sigma and why this term does not fall with SNR.
 */
export const DEPTH_SYSTEMATIC_REL = 0.5;

/**
 * The unrounded radius behind `DEPTH_SYSTEMATIC_REL`, kept so prose can say where the number came from instead of
 * citing a constant. Changing one without the other is caught by tests/depth-honesty.test.ts.
 */
export const DEPTH_CALIBRATION_R68_REL = 0.48;

/**
 * How many targets the calibration above was measured on (P90: 30 bright confirmed planets scanned, 16 with both
 * estimators and a period our search reproduced within 5%). Prose that quotes the uncertainty must carry this, or
 * a 16-row calibration reads like a law.
 */
export const DEPTH_CALIBRATION_N = 16;

export interface DepthRender {
  /** The published depth in integer ppm, UNROUNDED -- the same quantity the manifest commits. */
  ppm: number;
  /** The combined 1-sigma uncertainty in ppm: one significant figure, always rounded UP. */
  uncertaintyPpm: number;
  /** Relative uncertainty before it was rounded, for callers that want to show or test the arithmetic. */
  relativeUncertainty: number;
  /** "660 +/- 300 ppm". ASCII only: the posting path refuses anything else, including a real minus sign. */
  text: string;
  /** The same depth as a percentage, with its own matched error bar: "0.07 +/- 0.03 %". */
  percentText: string;
}

/** One significant figure, rounded UP -- the conservative direction for an uncertainty. */
export function ceilToOneSigFig(u: number): number {
  if (!Number.isFinite(u) || u <= 0) return NaN;
  const e = Math.floor(Math.log10(u));
  const scale = Math.pow(10, e);
  return Math.ceil(u / scale) * scale;
}

/** Decimal places an uncertainty of this size allows: 300 -> 0, 0.03 -> 2. */
export function decimalsFor(uncertainty: number): number {
  if (!Number.isFinite(uncertainty) || uncertainty <= 0) return 0;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(uncertainty))));
}

/**
 * Render a published depth with the uncertainty it has actually earned. `depthFrac` <= 0 is NOT this function's
 * problem to solve -- a non-positive box depth is a brightening, and the caller must say so instead of printing
 * an error bar on a dip that was never measured (see src/reporter/narrate.ts). Returns null for anything it
 * cannot honestly render, so callers fall back rather than print nonsense.
 */
export function renderDepthPpm(
  depthFrac: number,
  snr: number,
  systematicRel: number = DEPTH_SYSTEMATIC_REL,
): DepthRender | null {
  if (!Number.isFinite(depthFrac) || depthFrac <= 0) return null;
  const ppm = Math.round(depthFrac * 1e6);
  if (!Number.isFinite(ppm) || ppm <= 0) return null;

  // Statistical term: 1/|snr|, valid because snr = depthFrac/noiseSigmaFrac*sqrt(nIn) -- see the header.
  // A depth whose significance is not a positive finite number has no usable statistical term; the systematic
  // floor alone then describes it, which is the honest (wider) answer.
  const stat = Number.isFinite(snr) && snr > 0 ? 1 / snr : 0;
  const sys = Number.isFinite(systematicRel) && systematicRel > 0 ? systematicRel : DEPTH_SYSTEMATIC_REL;
  const rel = Math.sqrt(stat * stat + sys * sys);

  const uPpmRaw = ceilToOneSigFig(rel * ppm);
  if (!Number.isFinite(uPpmRaw) || uPpmRaw <= 0) return null;
  // Carried to a whole ppm, and never below one: an error bar like "1 +/- 0.8 ppm" would claim that the unit the
  // value is written in resolves the depth, which is the same over-claim in a different place.
  const uPpm = Math.max(1, Math.ceil(uPpmRaw));

  const pct = depthFrac * 100;
  const uPct = ceilToOneSigFig(rel * pct);
  const d = decimalsFor(uPct);
  return {
    ppm,
    uncertaintyPpm: uPpm,
    relativeUncertainty: rel,
    text: `${ppm} +/- ${uPpm} ppm`,
    percentText: d > 0 ? `${pct.toFixed(d)} +/- ${uPct.toFixed(d)} %` : `${pct.toFixed(0)} +/- ${uPct.toFixed(0)} %`,
  };
}

/** Convenience for prose: "about 660 parts per million, with the depth known no better than +/- 300 ppm". */
export function depthProse(depthFrac: number, snr: number, systematicRel = DEPTH_SYSTEMATIC_REL): string {
  const r = renderDepthPpm(depthFrac, snr, systematicRel);
  if (!r) return "";
  return `about ${r.ppm} parts per million, with the depth known no better than +/- ${r.uncertaintyPpm} ppm`;
}
