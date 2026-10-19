// FLUX-LEVEL VALIDATION POSTERIOR -- folds the repo's existing light-curve discriminants into ONE planet-vs-
// false-positive probability, and applies the field's statistical-validation norm (posterior > 0.99 == validated).
//
// WHY (authority roadmap, priority 2). RAVEN / TRICERATOPS / LEO-Vetter all collapse their vetting into a single
// posterior for the planet hypothesis and validate at > 0.99 (the field norm, Morton 2012; Armstrong+ 2021). The rig
// already MEASURES the right raw discriminants -- secondary-eclipse depth ratio and odd/even depth asymmetry
// (src/detect/vetting.ts) and a neighbour-based blend false-positive probability (src/candidate/falsePositiveProbability.ts)
// -- but never combined them into a probability or a validate/uncertain/reject decision. This module is that combiner.
//
// WHAT IT IS / IS NOT. A transparent log-odds blend of the discriminants we can defend, NOT a reimplementation of
// TRICERATOPS proper (that needs space-to-ground tables + limb-darkened dilution-corrected radius posteriors + a full
// neighbour-EB likelihood integration). Each term's coefficient is a stated ASSUMPTION, not fitted here, and the
// honesty rule from falsePositiveProbability.ts carries: a high posterior means "consistent with a planet GIVEN these
// discriminants and priors", nothing more -- and a flux-degenerate blend (a diluted planet with no secondary and no
// resolvable neighbour) is, correctly, NOT penalised by flux alone; only pixels break it.
//
// Pure + deterministic + research-only: no network, no worker import, wired into no verdict / bundle hash / money
// path. It scores; it does not gate production. discoveryClaim stays false.

export interface Discriminants {
  /** BLS/detector signal-to-noise of the primary event. */
  snr: number;
  /** observed primary dip depth as a flux fraction (0-1). */
  depthFrac: number;
  /** secondary-eclipse depth / primary depth from vetting.ts secondaryEclipse. */
  secondaryRatio?: number;
  secondaryDetermined?: boolean;
  /** |odd-even| depth asymmetry normalized by mean depth from vetting.ts oddEvenDepth/Refined. */
  oddEvenDiffFrac?: number;
  oddEvenDetermined?: boolean;
  /** neighbour-blend false-positive probability in [0,1] from falsePositiveProbability.ts, if computed. */
  blendFpp?: number;
}

export interface PosteriorConfig {
  /** prior probability the detection is a planet before the discriminants (neutral 0.5 default). */
  priorPlanetProb?: number;
  /** log-odds pulled FULLY against a planet at secondaryRatio = 1 (EB signature). Default 22. */
  secondaryStrength?: number;
  /** log-odds rewarded to a planet for a strictly clean secondary (ratio 0) at usable SNR. Default 6. */
  noSecondaryReward?: number;
  /** log-odds pulled fully against a planet at oddEvenDiffFrac = 1 (alias signature). Default 8. */
  oddEvenStrength?: number;
  /** log-odds pulled against a planet per unit blend FPP. Default 6. */
  blendStrength?: number;
  /** validation / rejection cut on the posterior. Default 0.99 / 0.01 (field norm). */
  validateAt?: number;
  rejectAt?: number;
}

export interface PosteriorResult {
  posteriorPlanet: number;
  logOdds: number;
  /** signed per-term log-odds contributions, for provenance. */
  contributions: { prior: number; secondary: number; oddEven: number; blend: number; depth: number };
  decision: "validated" | "uncertain" | "false-positive";
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Combine discriminants into P(planet | evidence) via additive log-odds likelihood ratios. A secondary measured
 * near ZERO at usable SNR is POSITIVE evidence for a planet (it rules out an equal-brightness companion); a
 * comparable secondary is strong evidence AGAINST (the EB signature). Each term is centered on the planet-expected
 * value so a clean, well-measured transit accumulates positive log-odds and can reach the 0.99 norm, while an EB
 * accumulates negative. An UNDETERMINED discriminant contributes nothing (absence of measurement is NOT evidence
 * for a planet), so a too-shallow signal stays "uncertain", never falsely "validated".
 */
export function planetPosterior(d: Discriminants, cfg: PosteriorConfig = {}): PosteriorResult {
  const prior = clamp01(cfg.priorPlanetProb ?? 0.5);
  const kSec = cfg.secondaryStrength ?? 22;
  const secReward = cfg.noSecondaryReward ?? 6;
  const kOe = cfg.oddEvenStrength ?? 8;
  const kBlend = cfg.blendStrength ?? 6;
  const validateAt = cfg.validateAt ?? 0.99;
  const rejectAt = cfg.rejectAt ?? 0.01;

  const priorLO = Math.log(prior / (1 - prior));

  // Secondary eclipse: reward a clean (ratio->0) measured secondary, punish a comparable one (ratio->1).
  const sec = d.secondaryDetermined ? secReward - kSec * clamp01(d.secondaryRatio ?? 0) : 0;
  // Odd/even asymmetry: a period-halved alias / blend splits alternating depths. Only counts when determined.
  const oe = d.oddEvenDetermined ? -kOe * clamp01(d.oddEvenDiffFrac ?? 0) : 0;
  // Neighbour blend FPP: P(background/on-target EB explains this), pulled against the planet hypothesis.
  const blend = d.blendFpp != null ? -kBlend * clamp01(d.blendFpp) : 0;
  // Very deep events (>5% flux) are physically implausible for a planet -> mild EB prior tilt.
  const depthPenalty = d.depthFrac > 0.05 ? -4 * clamp01((d.depthFrac - 0.05) / 0.45) : 0;

  const logOdds = priorLO + sec + oe + blend + depthPenalty;
  const posteriorPlanet = sigmoid(logOdds);
  const decision: PosteriorResult["decision"] =
    posteriorPlanet >= validateAt ? "validated" : posteriorPlanet <= rejectAt ? "false-positive" : "uncertain";

  return {
    posteriorPlanet,
    logOdds,
    contributions: { prior: priorLO, secondary: sec, oddEven: oe, blend, depth: depthPenalty },
    decision,
  };
}
