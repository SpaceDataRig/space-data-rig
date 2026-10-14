// HIERARCHICAL FALSE-POSITIVE PROBABILITY (validation roadmap, priority 2).
//
// WHAT THIS IS. A vespa / TRICERATOPS-style false-positive probability, deliberately reduced to
// the scenarios we can defend with data we already fetch. The dominant astrophysical impostor for
// a shallow periodic dip is an ECLIPSING BINARY whose light is DILUTED so it looks planetary. There
// are two ways that happens: (a) a faint background / galaxy blended EB sits inside the photometric
// aperture and its eclipse, diluted by the target's light, mimics the observed depth -- this is the
// one Gaia lets us evaluate PER SOURCE because we can SEE the neighbours; and (b) an EB on the
// target itself seen as a shallow (grazing) eclipse. We compute (a) from the measured neighbour list
// and treat (b) as an explicit literature prior rather than fabricating a depth-dependent number.
//
// WHY IT IS DEFENSIBLE. The blend term conditions on the ACTUAL Gaia neighbours in the aperture, not
// a sky-density guess: for each neighbour we invert the dilution relation to ask what intrinsic EB
// eclipse depth it would need to produce the observed dip, and count it as viable only if that depth
// is physically plausible for an EB. The EB fraction and eclipse geometry are literature constants
// and are LABELED as such (priors.source) -- they are not measured in this repo.
//
// HONESTY / SCOPE. This is a research-only probability with stated assumptions, NOT a hard gate and
// NOT a discovery. It is never wired into a verdict / bundle hash / money path here. A low P(FP) is
// "consistent with a planet given these priors", nothing more. discoveryClaim is structurally false.

export interface BlendNeighbor {
  /** Gaia G magnitude of the neighbour. */
  gmag: number;
  /** Angular separation from the target, arcsec. */
  sepArcsec: number;
}

export interface FpPriors {
  /** Fraction of relevant stars that host a (period-range) eclipsing binary. Literature approx. */
  ebFraction: number;
  /** Geometric probability an EB is aligned to eclipse (period/radius dependent). Literature approx. */
  eclipseGeoProb: number;
  /** Intrinsic EB eclipse depths considered plausible, as a flux fraction. */
  ebDepthMin: number;
  ebDepthMax: number;
  /** Prior probability that the dip is an on-target (grazing / shallow) EB, not computed from depth. */
  onTargetEbPrior: number;
  /** Photometric aperture radius, arcsec (used to filter neighbours + a positional weight). */
  apertureArcsec: number;
  /** Provenance of the priors -- which are literature constants vs measured here. */
  source: string;
}

/** Order-of-magnitude literature priors. The NEIGHBOUR LIST is measured; these constants are not. */
export const DEFAULT_FP_PRIORS: FpPriors = {
  ebFraction: 0.11,
  eclipseGeoProb: 0.3,
  ebDepthMin: 0.01,
  ebDepthMax: 0.9,
  onTargetEbPrior: 0.02,
  apertureArcsec: 21,
  source:
    "literature order-of-magnitude priors (EB fraction ~0.11, eclipse geometry ~0.3, on-target shallow-EB prior ~0.02); " +
    "NOT measured in this repo. The Gaia neighbour list IS measured. Treat the output as a prior-dependent probability.",
};

export interface ViableBlend {
  gmag: number;
  sepArcsec: number;
  /** neighbour flux / target flux. */
  fluxRatio: number;
  /** intrinsic EB eclipse depth this neighbour would need to produce the observed dip. */
  requiredEbDepth: number;
  /** probability this neighbour is the blended EB (ebFraction x geometry x positional weight). */
  probability: number;
}

export interface FalsePositiveAssessment {
  depthFraction: number;
  /** blended-EB probability summed over measured viable neighbours. */
  pBlend: number;
  /** on-target EB prior (documented constant, not computed from depth). */
  pOnTargetEb: number;
  /** total false-positive probability = 1 - (1-pBlend)(1-pOnTargetEb). */
  pFalsePositive: number;
  /** 1 - pFalsePositive. */
  pPlanet: number;
  /** pFalsePositive / pPlanet (prior-dependent odds). */
  fpOdds: number;
  viableBlends: ViableBlend[];
  neighboursConsidered: number;
  priors: FpPriors;
  determined: boolean;
  note: string;
  discoveryClaim: false;
}

const LOG10FLUX = -0.4;

/**
 * Probability a neighbour inside the aperture is a blended eclipsing binary whose diluted eclipse
 * reproduces the observed depth. For a neighbour with flux ratio k = F_nb / F_target, an intrinsic
 * eclipse depth d_nb appears to the observer as d_obs = d_nb * k / (1 + k) (diluted by the target).
 * Inverting: the neighbour is a viable blend iff requiredEbDepth = d_obs * (1 + k) / k lies within
 * the plausible EB depth range.
 */
export function assessFalsePositive(
  depthFraction: number,
  hostGmag: number,
  neighbours: BlendNeighbor[],
  priors: FpPriors = DEFAULT_FP_PRIORS,
): FalsePositiveAssessment {
  const viable: ViableBlend[] = [];
  let pBlend = 0;
  let considered = 0;

  const depthOk = Number.isFinite(depthFraction) && depthFraction > 0;
  const hostOk = Number.isFinite(hostGmag);

  if (depthOk && hostOk) {
    for (const nb of neighbours) {
      if (!Number.isFinite(nb.gmag) || !Number.isFinite(nb.sepArcsec)) continue;
      if (!(nb.sepArcsec <= priors.apertureArcsec)) continue; // outside the aperture it cannot dilute
      considered++;
      const k = Math.pow(10, LOG10FLUX * (nb.gmag - hostGmag)); // neighbour flux / target flux
      if (!(k > 0)) continue;
      const requiredEbDepth = (depthFraction * (1 + k)) / k;
      if (requiredEbDepth < priors.ebDepthMin || requiredEbDepth > priors.ebDepthMax) continue;
      // positional weight: a neighbour nearer the aperture centre is more surely inside the same
      // photometric centroid; taper linearly to 0 at the aperture edge.
      const posWeight = Math.max(0, 1 - nb.sepArcsec / priors.apertureArcsec);
      const probability = priors.ebFraction * priors.eclipseGeoProb * posWeight;
      viable.push({ gmag: nb.gmag, sepArcsec: nb.sepArcsec, fluxRatio: k, requiredEbDepth, probability });
      pBlend += probability;
    }
  }
  pBlend = Math.min(1, pBlend);
  const pOnTargetEb = Math.min(1, Math.max(0, priors.onTargetEbPrior));
  const pFalsePositive = 1 - (1 - pBlend) * (1 - pOnTargetEb);
  const pPlanet = 1 - pFalsePositive;
  const determined = depthOk && hostOk;

  return {
    depthFraction,
    pBlend,
    pOnTargetEb,
    pFalsePositive,
    pPlanet,
    fpOdds: pPlanet > 0 ? pFalsePositive / pPlanet : Infinity,
    viableBlends: viable,
    neighboursConsidered: considered,
    priors,
    determined,
    note: determined
      ? "prior-dependent probability from the measured Gaia neighbours; a low P(FP) means 'consistent with a planet given these priors', not a validated planet."
      : "insufficient inputs (need a finite depth and host magnitude); probabilities are not meaningful.",
    discoveryClaim: false,
  };
}
