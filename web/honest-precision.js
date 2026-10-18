// Honest rendering of the two numbers this pipeline prints on a card -- the BROWSER mirror of
// src/core/depthFormat.ts and src/core/periodFormat.ts.
//
// WHY A MIRROR AND NOT AN IMPORT. `web/app.js` is served to the browser as plain ES modules and does not go
// through the TypeScript build (tsconfig.json has no allowJs and includes only src/ and scripts/), so the board
// cannot import the .ts modules the way `web/relabel.js` is shared with tests. The duplication is real, so it is
// fenced: tests/depth-honesty.test.ts imports BOTH implementations and asserts they return identical strings over a
// sweep of depths, periods and SNRs, and pins every shared constant in each file to the same number. Change one
// side and the suite goes red -- an unenforced mirror drifts, and the two surfaces then advertise different
// precisions for the same record while both looking authoritative.
//
// THE DEFECT THIS CLOSES, measured rather than argued:
//   - depth: P90 (reports/p90-depth-estimators.md, 16 period-matched confirmed planets graded against the NASA
//     Exoplanet Archive) puts the median ABSOLUTE error at 36.7% for the BLS box, 44.2% for the per-sector shape
//     fit, 33.0% for what the adoption guard publishes, the two estimators not separable head to head (8/16 vs
//     8/16, exact sign test p = 1.00). Every cell printed a bare integer ppm and a percent to three decimals.
//     The bar used here is the radius that covers 68% of the published rows (48.0%), not the median, because a
//     "+/-" promises about two thirds and a median promises one half.
//   - period: the BLS reports a discrete grid node, and the node spacing goes as P^2, so `.toFixed(3)` on a 16-day
//     signal claims half a thousandth of a day where the grid steps by more than a day. src/core/periodFormat.ts
//     already stopped the narration from doing this; these cells had not been reached.
// Both are precision claims, not measurements. Read the .ts modules for the full reasoning; this file is the part
// that has to agree with them.

/** Systematic relative uncertainty on any depth this pipeline publishes: P90's 68%-coverage radius for a published
 *  depth, carried UP to one significant figure. A median absolute error (33.0%) covers half the rows, not two thirds. */
export const DEPTH_SYSTEMATIC_REL = 0.5;

/** The unrounded measured radius behind the constant above (reports/p90-depth-estimators.md). */
export const DEPTH_CALIBRATION_R68_REL = 0.48;

/** How many targets that calibration was measured on; quoted wherever the uncertainty is quoted. */
export const DEPTH_CALIBRATION_N = 16;

/** The oversample the BLS frequency grid uses by default (mirrors src/detect/bls.ts DEFAULTS.oversample). */
export const BLS_DEFAULT_OVERSAMPLE = 8;

/** A single TESS sector spans ~27 d: the conservative baseline when a record carries no measured resolution. */
export const MIN_SECTOR_BASELINE_DAYS = 27;

/** One significant figure, rounded UP -- the conservative direction for a depth uncertainty. */
export function ceilToOneSigFig(u) {
  if (!Number.isFinite(u) || u <= 0) return NaN;
  const scale = Math.pow(10, Math.floor(Math.log10(u)));
  return Math.ceil(u / scale) * scale;
}

/** One significant figure, rounded to nearest, as a period grid resolution should be quoted (mirrors the .ts). */
export function oneSigFig(u) {
  if (!Number.isFinite(u) || u <= 0) return NaN;
  const e = Math.floor(Math.log10(u));
  const mantissa = u / Math.pow(10, e);
  return Math.max(1, Math.round(mantissa)) * Math.pow(10, e);
}

/** Decimal places an uncertainty of this size allows: 300 -> 0, 0.03 -> 2. */
export function decimalsFor(u) {
  if (!Number.isFinite(u) || u <= 0) return 0;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(u))));
}

/** Decimal places a period grid resolution allows (mirrors src/core/periodFormat.ts, capped at 4). */
export function periodDecimalsFor(u) {
  if (!Number.isFinite(u) || u <= 0) return 2;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(u))));
}

/** Grid-limited period uncertainty: dP = P^2 / (oversample * baseline). */
export function gridPeriodResolutionDays(periodDays, baselineDays, oversample = BLS_DEFAULT_OVERSAMPLE) {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return NaN;
  if (!Number.isFinite(baselineDays) || baselineDays <= 0) return NaN;
  if (!Number.isFinite(oversample) || oversample <= 0) return NaN;
  return (periodDays * periodDays) / (oversample * baselineDays);
}

/** The bound used when the record stored no baseline: shortest plausible, so fewest quoted digits. */
export function conservativeResolutionDays(periodDays) {
  return gridPeriodResolutionDays(periodDays, MIN_SECTOR_BASELINE_DAYS);
}

/**
 * A recovered period against the grid that produced it. Mirrors renderPeriodDays() exactly, including its
 * legacy two-decimal fallback when no bound can be derived at all.
 */
export function renderPeriodDays(periodDays, resolutionDays, withUncertainty = true) {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return { value: "?", uncertainty: "", text: "?" };
  let u = Number.isFinite(resolutionDays) ? oneSigFig(resolutionDays) : NaN;
  if (!Number.isFinite(u) || u <= 0) u = oneSigFig(conservativeResolutionDays(periodDays));
  if (!Number.isFinite(u) || u <= 0) {
    const v = periodDays.toFixed(2);
    return { value: v, uncertainty: "", text: v };
  }
  const d = periodDecimalsFor(u);
  const value = periodDays.toFixed(d);
  const uncertainty = u >= 1 ? u.toFixed(0) : u.toFixed(d);
  return { value, uncertainty, text: withUncertainty ? `${value} +/- ${uncertainty}` : value };
}

/**
 * Depth in integer ppm plus the error bar it has earned, or null when there is nothing honest to print.
 * `snr` may be null/0/negative: the statistical term (1/|snr|) then drops out and the systematic floor alone
 * describes the depth, which is the wider and correct answer. A non-positive depth is NOT rendered here -- that
 * is a brightening, not a shallow dip, and the caller has to say so.
 */
export function renderDepthPpm(depthFrac, snr, systematicRel = DEPTH_SYSTEMATIC_REL) {
  if (!Number.isFinite(depthFrac) || depthFrac <= 0) return null;
  const ppm = Math.round(depthFrac * 1e6);
  if (!Number.isFinite(ppm) || ppm <= 0) return null;
  const stat = Number.isFinite(snr) && snr > 0 ? 1 / snr : 0;
  const sys = Number.isFinite(systematicRel) && systematicRel > 0 ? systematicRel : DEPTH_SYSTEMATIC_REL;
  const rel = Math.sqrt(stat * stat + sys * sys);
  const uPpmRaw = ceilToOneSigFig(rel * ppm);
  if (!Number.isFinite(uPpmRaw) || uPpmRaw <= 0) return null;
  // Carried to a whole ppm, never below one: "1 +/- 0.8 ppm" would claim the unit resolves the depth.
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

/**
 * The Depth cell call sites use: a dip with its error bar, or the plain statement that no dip was measured.
 * `depthPpm` is the integer ppm the API already publishes, so the cell stays traceable to the record instead of
 * re-deriving a different number here.
 */
export function depthCellText(depthPpm, snr) {
  if (!Number.isFinite(depthPpm) || depthPpm <= 0) {
    return Number.isFinite(depthPpm) && depthPpm < 0
      ? `no dip -- box measured a rise of ${Math.abs(depthPpm)} ppm`
      : "no dip measured";
  }
  const r = renderDepthPpm(depthPpm / 1e6, snr);
  return r ? r.text : `${depthPpm} ppm`;
}

/**
 * The Period cell call sites use: "16 +/- 1 d", never a fixed three decimals. `resolutionDays` is the grid
 * resolution the record carries when it has one; without one the conservative bound is used, which can only
 * under-claim.
 */
export function periodCellText(periodDays, resolutionDays) {
  const r = renderPeriodDays(periodDays, resolutionDays, true);
  return `${r.text} d`;
}
