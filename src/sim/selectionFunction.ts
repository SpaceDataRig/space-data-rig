// SELECTION-FUNCTION SKELETON (discovery roadmap, priority 4).
//
// WHY THIS EXISTS. The 2-D completeness map (src/sim/completenessGrid.ts, P47) tells you, for a
// star like the ones you searched, what OBSERVED transit depth you can recover at each period. But
// an occurrence rate (eta_earth) is not "detections / stars": the correct denominator is a
// SELECTION FUNCTION -- the probability that a planet of a given TRUE period and radius, orbiting a
// given star, would actually be found. That probability is the product of three things this project
// measures separately but never combined:
//   (1) geometric transit probability   -- does the orbit even edge-on from our viewpoint (R*/a);
//   (2) dilution / contrast window      -- an unresolved neighbour adds flux so the OBSERVED depth
//                                         UNDERSTATES the TRUE depth (src/data/gaiaDilution.ts), so a
//                                         diluted planet needs a deeper true dip to clear the same
//                                         observed-depth threshold; and
//   (3) detection completeness          -- the (period, observed-depth) recovery from the P47 grid.
// This module composes them into a per-period-bin selection function. It is the SKELETON: pure
// arithmetic on inputs a caller supplies (a completeness grid + a dilution factor + stellar radius /
// mass), no network, no detector, and deliberately NOT wired into any verdict / bundle hash / money
// path. A follow-up script feeds it real per-target Gaia dilution + the P47 grid to produce an
// eta_earth-ready weight table over a sample; nothing here claims a rate until that is run and the
// numbers are measured.

import { thresholdDepthAt, type GridCell } from "./completenessGrid.ts";

/** Solar radius in AU (Rsun / AU), for the geometric transit probability. */
export const RSUN_PER_AU = 0.00465047;
/** Days in a Julian year. */
const DAYS_PER_YEAR = 365.25;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Keplerian semi-major axis in AU for a planet of period `periodDays` around a star of
 * `starMassSolar` solar masses (a^3 = G M P^2 / 4 pi^2, in solar units a = M^(1/3) P_yr^(2/3)).
 */
export function semiMajorAxisAu(periodDays: number, starMassSolar: number): number {
  if (!(periodDays > 0) || !(starMassSolar > 0)) return NaN;
  const pYr = periodDays / DAYS_PER_YEAR;
  return Math.cbrt(starMassSolar) * Math.pow(pYr, 2 / 3);
}

/**
 * Geometric probability that the orbit transits: (R_star + R_planet) / a, clipped to [0, 1].
 * Radii in solar radii, period in days, mass in solar masses. The planet term is optional (a
 * Jupiter is ~0.1 R_star, so it matters only for the largest planets).
 */
export function geometricTransitProbability(
  periodDays: number,
  starRadiusSolar: number,
  starMassSolar: number,
  planetRadiusSolar = 0,
): number {
  const a = semiMajorAxisAu(periodDays, starMassSolar);
  if (!(a > 0) || !Number.isFinite(a)) return NaN;
  const rSumAu = (starRadiusSolar + planetRadiusSolar) * RSUN_PER_AU;
  return clamp01(rSumAu / a);
}

/**
 * The TRUE transit depth (ppm) needed to be OBSERVED at `observedDepthPpm` given a dilution factor
 * (host flux fraction in [0,1], from src/data/gaiaDilution.ts): observed = true * dilution, so
 * true = observed / dilution. dilution = 1 (clean) leaves the depth unchanged; a heavily diluted
 * (0.5) host needs a twice-as-deep true transit to show the same dip. Returns Infinity for a
 * non-positive dilution factor (a fully blended host is undetectable), NaN for bad depth input.
 */
export function dilutionInflatedDepth(observedDepthPpm: number, dilutionFactor: number): number {
  if (!Number.isFinite(observedDepthPpm)) return NaN;
  if (!(dilutionFactor > 0)) return Infinity;
  return observedDepthPpm / Math.min(1, dilutionFactor);
}

export interface PeriodBinSelection {
  periodLo: number;
  periodHi: number;
  periodCentreDays: number;
  /** geometric transit probability at the bin centre. */
  geometricTransitProb: number;
  /** observed depth (ppm) the detector recovers at 50% completeness (from the grid); null if the bin never reaches 50%. */
  observedDepth50Ppm: number | null;
  /** the TRUE depth (ppm) that corresponds to, after undoing dilution; null if observedDepth50 is. */
  trueDepth50Ppm: number | null;
  /** the dilution factor applied to this bin's target. */
  dilutionFactor: number;
  /**
   * Rough per-planet detection probability for a planet that transits: completeness at the bin's
   * 50% point is 0.5 by construction, so this is 0.5 * geometricProb -- the skeleton's "found given
   * a random orientation" weight at the 50% depth. Callers replace 0.5 with the full grid surface
   * when integrating over a radius/period distribution.
   */
  selectionWeightAt50: number | null;
}

/**
 * Assemble a per-period-bin selection function from a completeness grid + one target's dilution and
 * stellar parameters. `grid` is the { cells, periodEdges, depthEdges } object from
 * binCompleteness; `target` is the completeness level to threshold at (default 0.5). This is the
 * composition of (1) geometry, (2) dilution, (3) completeness -- the honest denominator skeleton for
 * an occurrence calculation. Pure and deterministic.
 */
export function buildSelectionFunction(
  grid: { cells: GridCell[]; periodEdges: number[]; depthEdges: number[] },
  opts: { dilutionFactor: number; starRadiusSolar: number; starMassSolar: number; target?: number },
): PeriodBinSelection[] {
  const target = opts.target ?? 0.5;
  const thresholds = thresholdDepthAt(grid, target);
  const out: PeriodBinSelection[] = [];
  for (const t of thresholds) {
    const centre = (t.periodLo + t.periodHi) / 2;
    const geo = geometricTransitProbability(centre, opts.starRadiusSolar, opts.starMassSolar);
    const observed = t.depthPpm;
    const trueDepth = observed == null ? null : dilutionInflatedDepth(observed, opts.dilutionFactor);
    out.push({
      periodLo: t.periodLo,
      periodHi: t.periodHi,
      periodCentreDays: centre,
      geometricTransitProb: geo,
      observedDepth50Ppm: observed,
      trueDepth50Ppm: trueDepth,
      dilutionFactor: opts.dilutionFactor,
      selectionWeightAt50: trueDepth == null ? null : target * geo,
    });
  }
  return out;
}

/**
 * Contrast window: given the brightest UNRESOLVED companion's magnitude contrast (dmag = host -
 * companion, from gaiaDilution) and the resolution limit of the follow-up imaging (the faintest
 * companion that could have been detected, dmagLimit), classify whether the measured dilution can be
 * trusted. If a companion BRIGHTER than the imaging limit could hide inside the aperture
 * (dmag <= dmagLimit means it is within reach), the dilution is at least partly measurable; if the
 * brightest expected contaminant is fainter than the limit, dilution is unconstrained and the true
 * depth is uncertain by more than the correction. Returns a documented, conservative flag -- never a
 * rejection (a real planet can legitimately sit in front of a diluted host).
 */
export function contrastWindowAssessment(
  brightestContrastMag: number,
  imagingContrastLimitMag: number,
): { dilutionMeasurable: boolean; worstCaseExtraDilutionPpm: number; note: string } {
  if (!Number.isFinite(brightestContrastMag)) {
    return { dilutionMeasurable: false, worstCaseExtraDilutionPpm: Infinity, note: "no neighbour measured; dilution unconstrained" };
  }
  // A companion at contrast dmag contributes flux ratio 10^(-0.4*dmag). Anything fainter than the
  // imaging limit (dmag > limit) is unresolved and could add up to the limit's flux undetected.
  const measurable = brightestContrastMag <= imagingContrastLimitMag;
  const undetectedFluxRatio = Math.pow(10, -0.4 * imagingContrastLimitMag); // flux/host at the limit
  return {
    dilutionMeasurable: measurable,
    worstCaseExtraDilutionPpm: undetectedFluxRatio,
    note: measurable
      ? "brightest contaminant is within the imaging contrast limit; dilution is measurable"
      : "a companion up to the imaging limit could be unresolved; dilution is a lower bound",
  };
}
