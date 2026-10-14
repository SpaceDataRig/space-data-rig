// SOFT BLEND-LIKELIHOOD SCORE (roadmap: turn the pixel / dilution vetting tools into a CONTINUOUS score,
// not a binary veto -- P57..P59 proved those tools false-kill known planets, so a hard gate is unsafe).
//
// WHY A SCORE AND NOT A VETO. A binary veto throws the signal away; a continuous 0..1 blend-likelihood keeps
// the INFORMATION (how blend-like the pixel + aperture evidence looks) while letting the human/critic weigh it.
// It is deliberately DIAGNOSTIC: this module never gates, never rejects, never touches a verdict or a money
// path. The critic may consume `blendLikelihood` as a bounded, non-gating WEIGHT on its ranking score ONLY,
// and only when a caller explicitly passes it. The honest price of the soft form is published up front:
// `falseVetoAtThreshold` measures how many KNOWN planets would fall above a given cut -- i.e. how many real
// planets the score wrongly flags -- which is why it stays advisory and never becomes a hard reject.
//
// Pure + deterministic + runtime-agnostic: no network, no fetch, no process.env, no worker import. Fully
// unit-testable offline. Every input is optional; absent signals contribute nothing rather than fabricating a
// risk, and a candidate with NO determined signal is `undetermined` (score NaN) so the critic adds nothing.

import { wilsonInterval } from "../sim/completenessGrid.ts";

export interface SoftScoreSignals {
  /** PSF double-difference best-fit source offset from the host, arcsec (larger = the light is off-target). */
  psfOffsetArcsec?: number;
  /** legacy full-aperture in-transit photocenter shift, arcsec (larger = off-target; the P44-calibrated axis). */
  centroidShiftArcsec?: number;
  /** Gaia aperture dilution factor: host fraction of aperture light in [0,1] (lower = more contaminant). */
  dilutionFactor?: number;
}

export interface SoftScoreResult {
  /** 0 (looks like the host) .. 1 (looks like a blend). NaN when no signal is determined. */
  score: number;
  /** how many distinct vetting signals fed the score (0 => undetermined). */
  nSignals: number;
  determined: boolean;
  /** per-signal normalized risk terms, for transparency in the report / dashboard. */
  components: { name: string; risk: number }[];
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : NaN);

// reference saturations (arcsec / dilution): a signal this far off-target, or an aperture this diluted, is
// treated as fully blend-like. Chosen from the P44/P53 calibration (confirmed planets cluster well inside 1-2
// arcsec; 4" is beyond any real-planet scatter observed). These make the score monotonic, NOT a decision.
const OFFSET_REF_ARCSEC = 4;
const CENTROID_REF_ARCSEC = 2;

/**
 * Combine the available pixel / aperture vetting measurements into ONE continuous blend-likelihood in [0,1].
 * Higher = more blend-like. Each present signal contributes an equally-weighted monotonic risk term; a signal
 * that is missing or non-finite is simply left out. With zero usable signals the score is undetermined (NaN).
 */
export function blendLikelihood(s: SoftScoreSignals): SoftScoreResult {
  const components: { name: string; risk: number }[] = [];
  if (Number.isFinite(s.psfOffsetArcsec) && (s.psfOffsetArcsec as number) >= 0) {
    components.push({ name: "psf-offset", risk: clamp01((s.psfOffsetArcsec as number) / OFFSET_REF_ARCSEC) });
  }
  if (Number.isFinite(s.centroidShiftArcsec) && (s.centroidShiftArcsec as number) >= 0) {
    components.push({ name: "centroid-shift", risk: clamp01((s.centroidShiftArcsec as number) / CENTROID_REF_ARCSEC) });
  }
  if (Number.isFinite(s.dilutionFactor) && (s.dilutionFactor as number) >= 0 && (s.dilutionFactor as number) <= 1) {
    components.push({ name: "dilution", risk: clamp01(1 - (s.dilutionFactor as number)) });
  }
  const usable = components.filter((c) => Number.isFinite(c.risk));
  if (usable.length === 0) return { score: NaN, nSignals: 0, determined: false, components };
  const mean = usable.reduce((a, c) => a + c.risk, 0) / usable.length;
  return { score: mean, nSignals: usable.length, determined: true, components: usable };
}

export interface SoftVetoCase {
  /** true when the labelled truth is a blend / false positive; false for a known planet. */
  isBlend: boolean;
  /** the soft blend-likelihood score (NaN scores are ignored). */
  score: number;
}

export interface SoftVetoMetrics {
  threshold: number;
  nPlanets: number;
  falseKills: number;
  /** fraction of KNOWN planets scoring at/above the threshold -- the honest cost of the soft cut. */
  falseVetoRate: number;
  nBlends: number;
  caughtBlends: number;
  /** fraction of labelled blends scoring at/above the threshold (the "catch" rate). */
  blendCatchRate: number;
  blendCatchCI: [number, number];
}

/**
 * Score the soft cut against the labelled sample: at a given threshold, how many known planets would be wrongly
 * flagged (false-veto) and how many blends would be caught. Reused to publish the false-kill rate for the very
 * reason this stays advisory -- a soft score with a non-zero false-veto rate is information, not a gate.
 */
export function falseVetoAtThreshold(cases: SoftVetoCase[], threshold: number): SoftVetoMetrics {
  const scored = cases.filter((c) => Number.isFinite(c.score));
  const planets = scored.filter((c) => !c.isBlend);
  const blends = scored.filter((c) => c.isBlend);
  const falseKills = planets.filter((c) => c.score >= threshold).length;
  const caughtBlends = blends.filter((c) => c.score >= threshold).length;
  const blendCatchRate = blends.length ? caughtBlends / blends.length : NaN;
  const [lo, hi] = blends.length ? wilsonInterval(caughtBlends, blends.length) : [NaN, NaN];
  return {
    threshold,
    nPlanets: planets.length,
    falseKills,
    falseVetoRate: planets.length ? falseKills / planets.length : NaN,
    nBlends: blends.length,
    caughtBlends,
    blendCatchRate,
    blendCatchCI: [lo, hi],
  };
}
