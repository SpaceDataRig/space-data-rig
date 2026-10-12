// ASTROPHYSICAL FALSE-POSITIVE SCREEN by transit depth (discovery roadmap, Stage 2).
//
// WHY THIS EXISTS. The blind search (p19) surfaced periodic dips, but full-frame-image light curves are
// dominated by eclipsing binaries (EBs), not planets. Stage 2 is the step that tells them apart enough to
// emit honest candidates. Earlier calibration (odd/even depth symmetry, secondary-eclipse ratio) proved
// those 1D discriminators MIS-KILL true planets on real single-sector data, so they must NOT gate. Transit
// DEPTH is one of the very few 1D measures safe to classify on -- but only once it is calibrated, because a
// naive "deeper than 3% = EB" line would reject ~1% of every CONFIRMED planet (the deepest hot Jupiters
// reach ~16.7% in the live catalog). This module encodes the measured, auditable thresholds rather than a
// guessed one.
//
// THE MEASUREMENT. scripts/p21-depth-calibrate.ts pulls the live NASA Exoplanet Archive confirmed transiting
// planets and reports the empirical depth distribution. As calibrated (n=4207, 2026-10-12): p99 ~30.6 ppt ppm,
// p99.5 ~37500 ppm, observed MAX ~166590 ppm. Two honest consequences:
//   - Only a signal DEEPER than every known planet can be flatly rejected as non-planetary -> hard ceiling
//     200000 ppm (20%, ~1.2x the observed maximum).
//   - The sparse-but-real 40000-200000 ppm band is "deep-suspect": never excluded on depth alone, but capped
//     below "high" until a blend/eclipsing-binary check corroborates it.
//
// PURE + DI + RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash / money path.
// The caller may inject its own calibration so this rule is testable and future-updatable.

export type DepthRegime = "planet-plausible" | "deep-suspect" | "not-planetary" | "unknown";

export interface DepthCalibration {
  /** Above this depth the signal is deeper than ANY confirmed planet -> an EB/blend, not a planetary candidate. */
  hardCeilingPpm: number;
  /** Above this (but at or below the hard ceiling) it is planet-plausible only with corroborating follow-up. */
  deepSuspectPpm: number;
  /** Provenance + as-of so the number is auditable, never a silent magic constant. */
  source: string;
}

/** Defaults are the MEASURED values from scripts/p21-depth-calibrate.ts (npm run p21:depth-calibrate). */
export const CALIBRATED_DEPTH: DepthCalibration = {
  hardCeilingPpm: 200000,
  deepSuspectPpm: 40000,
  source:
    "NASA Exoplanet Archive pscomppars, discoverymethod=Transit, n=4207 confirmed depths, " +
    "p99=30589ppm p99.5=37503ppm max=166590ppm, calibrated 2026-10-12 (scripts/p21-depth-calibrate.ts)",
};

export interface DepthAssessment {
  regime: DepthRegime;
  /** False ONLY when the depth exceeds the calibrated hard ceiling; unknown/suspect stay true (never reject on thin evidence). */
  planetPlausible: boolean;
  reason: string;
}

/**
 * Classify one candidate's transit depth against a calibration. Monotonic in depth: plausible -> suspect -> not
 * planetary. A non-finite depth is "unknown" and is deliberately treated as planet-plausible (missing data must
 * not silently delete a candidate) while the contract still refuses to grant it "high".
 */
export function classifyDepthRegime(depthPpm: number, cal: DepthCalibration = CALIBRATED_DEPTH): DepthAssessment {
  if (!Number.isFinite(depthPpm)) {
    return { regime: "unknown", planetPlausible: true, reason: "transit depth not measured; cannot screen on astrophysical plausibility" };
  }
  if (depthPpm > cal.hardCeilingPpm) {
    return {
      regime: "not-planetary",
      planetPlausible: false,
      reason: `depth ${depthPpm.toFixed(0)} ppm exceeds ${cal.hardCeilingPpm} ppm -- deeper than every confirmed planet (${cal.source}); this is an eclipsing binary or blend, not a planetary candidate`,
    };
  }
  if (depthPpm > cal.deepSuspectPpm) {
    return {
      regime: "deep-suspect",
      planetPlausible: true,
      reason: `depth ${depthPpm.toFixed(0)} ppm is in the sparse 40000-200000 ppm band where a few real hot Jupiters live but brown dwarfs / EBs dominate -- planet-plausible only with a resolved blend/eclipsing-binary check`,
    };
  }
  return { regime: "planet-plausible", planetPlausible: true, reason: `depth ${depthPpm.toFixed(0)} ppm is within the bulk of the confirmed-planet population` };
}
