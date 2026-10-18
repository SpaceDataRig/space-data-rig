// Honest rendering of an orbital period recovered by a GRID search.
//
// WHY this exists: the BLS in src/detect/bls.ts reports `periodDays = 1 / (fMin + k * df)`, a discrete grid
// node (possibly doubled by the harmonic refinement). There is no continuous period fit anywhere in that path.
// The spacing between neighbouring nodes grows as P^2, because dP = |dP/df| df = P^2 * df, so a 27-day baseline
// searched at oversample 8 resolves ~0.02 d at P=2 d but only ~1.2 d at P=16 d. Rendering every period with
// `.toFixed(2)` therefore claims a precision the search never had -- and it did so on the public feed, where a
// candidate recovered at a doubled 8-day grid node was announced as "P=16.00d", implying +/- 0.005 d when the
// grid step at that period is two orders of magnitude coarser.
//
// The rule applied here is the usual one (PDG): quote the uncertainty to one significant figure and carry the
// value to the same decimal place. Under that rule 16 +/- 1 d and 1.96 +/- 0.02 d are both rendered correctly by
// the same function, and no caller has to think about it.
//
// When a record carries no measured resolution (anything produced before the detector started recording one),
// the CONSERVATIVE bound is used: assume the shortest baseline a TESS sector can supply, which yields the
// LARGEST grid spacing and therefore the FEWEST quoted digits. Being wrong in that direction under-claims
// precision, which is the only acceptable direction to be wrong in.

/** The oversample the BLS grid uses by default (src/detect/bls.ts DEFAULTS.oversample). */
export const BLS_DEFAULT_OVERSAMPLE = 8;

/** A single TESS sector spans ~27 d; nothing searched sector-at-a-time has a shorter usable baseline. Used only
 *  as the conservative assumption when a record does not carry the baseline its search actually used. */
export const MIN_SECTOR_BASELINE_DAYS = 27;

/**
 * Grid-limited period uncertainty of a BLS-style frequency grid: dP = P^2 * df, df = 1 / (oversample * baseline).
 * Returns NaN for inputs that cannot produce a resolution, so callers can fall back rather than print nonsense.
 */
export function gridPeriodResolutionDays(periodDays: number, baselineDays: number, oversample = BLS_DEFAULT_OVERSAMPLE): number {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return NaN;
  if (!Number.isFinite(baselineDays) || baselineDays <= 0) return NaN;
  if (!Number.isFinite(oversample) || oversample <= 0) return NaN;
  return (periodDays * periodDays) / (oversample * baselineDays);
}

/** The bound used when the search recorded nothing: shortest plausible baseline, so the largest plausible
 *  spacing, so never more digits than the data can support. */
export function conservativeResolutionDays(periodDays: number): number {
  return gridPeriodResolutionDays(periodDays, MIN_SECTOR_BASELINE_DAYS);
}

/** One significant figure, as an uncertainty should be quoted. */
export function oneSigFig(u: number): number {
  if (!Number.isFinite(u) || u <= 0) return NaN;
  const e = Math.floor(Math.log10(u));
  const mantissa = u / Math.pow(10, e);
  const r = Math.max(1, Math.round(mantissa));
  return r * Math.pow(10, e);
}

/** Decimal places that match an uncertainty rounded to one significant figure: 1 -> 0, 0.02 -> 2. */
export function decimalsFor(uncertainty: number): number {
  if (!Number.isFinite(uncertainty) || uncertainty <= 0) return 2;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(uncertainty))));
}

export interface PeriodRender {
  /** Digits only, e.g. "16" or "1.96". Already truncated to what the grid resolved. */
  value: string;
  /** Matched one-sig-fig uncertainty, e.g. "1" or "0.02". Reported whether or not `text` shows it, so a caller
   *  building prose can mention it in its own words. Empty only when no bound could be derived at all. */
  uncertainty: string;
  /** "16 +/- 1" or, with withUncertainty=false, just "16" -- ASCII only, the posting path refuses anything else. */
  text: string;
}

/**
 * Render a recovered period against its grid resolution. `resolutionDays` may be NaN/undefined, in which case
 * the conservative bound is used; `withUncertainty` (default true) decides whether the +/- term is shown.
 * Never claims a decimal place the search could not resolve.
 */
export function renderPeriodDays(periodDays: number, resolutionDays?: number, withUncertainty = true): PeriodRender {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return { value: "?", uncertainty: "", text: "?" };
  let u = Number.isFinite(resolutionDays ?? NaN) ? oneSigFig(Number(resolutionDays)) : NaN;
  if (!Number.isFinite(u) || u <= 0) u = oneSigFig(conservativeResolutionDays(periodDays));
  if (!Number.isFinite(u) || u <= 0) {
    // No bound could be derived at all; fall back to the legacy two places rather than print nothing.
    const v = periodDays.toFixed(2);
    return { value: v, uncertainty: "", text: v };
  }
  const d = decimalsFor(u);
  const value = periodDays.toFixed(d);
  const uncertainty = u >= 1 ? u.toFixed(0) : u.toFixed(d);
  return { value, uncertainty, text: withUncertainty ? `${value} +/- ${uncertainty}` : value };
}

/** Convenience for prose: "16 +/- 1 d". */
export function formatPeriodDaysWithUnit(periodDays: number, resolutionDays?: number, withUncertainty = true): string {
  return `${renderPeriodDays(periodDays, resolutionDays, withUncertainty).text} d`;
}
