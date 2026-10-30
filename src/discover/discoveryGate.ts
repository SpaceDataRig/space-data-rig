// THE EARNED DISCOVERY GATE (discovery roadmap: turning the standing `discoveryClaim=false` prohibition into a
// predicate that can only be satisfied, never toggled).
//
// WHY THIS EXISTS. For the rig's whole life `discoveryClaim` has been a hard-coded false (src/candidate/*,
// enforced by assertHonest and the redline-artifact-scan corpus test). That prohibition is correct UNTIL there is a
// way to EARN a claim. This module is that way: it does not flip a boolean, it computes a tier from measured,
// independent evidence against a PRE-REGISTERED protocol (discovery-protocol.json, frozen before any prospective
// data is inspected). When nothing is earned -- which is every real candidate today, because p99's prospective
// held-out precision (0.43-0.61) is far below the protocol's 0.95 floor and no human has signed anything -- the gate
// returns tier "none" and discoveryClaimAllowed=false. The door exists, is armed, and is locked.
//
// WHAT EACH TIER MEANS (see the protocol's honesty block):
//   "none"        a prerequisite is unmet. Nothing claimed.
//   "nomination"  every per-candidate corroboration + significance bar passed. Wording is bounded to
//                 "nominated, pending independent confirmation". STILL NOT a discovery claim.
//   "announcement" nomination bars AND a prospective-validation record clearing the precision floor AND an explicit
//                 human/peer sign-off. This is the ONLY tier that may set discoveryClaim=true, and even here the
//                 automated path is forbidden from doing so (protocol.release.automatedMaySetDiscoveryClaim=false);
//                 the caller that renders the outward text must itself be the signed human step.
//
// This module is pure and dependency-injected: no network, no filesystem, not imported by the worker, so it cannot
// change a production verdict, bundle hash, or the money path on its own. It only classifies evidence it is handed.

export type DiscoveryTier = "none" | "nomination" | "announcement";

export interface GateNovelty {
  inConfirmed: boolean;
  inToi: boolean;
  confirmedScanned: number; // <0 means the confirmed catalog was not available this run
  toiScanned: number;
}
export interface GateCorroboration {
  crossSectorEphemerisCoherentSectors: number; // how many sectors carry one phase-coherent ephemeris (p78)
  catalogDuplicate: boolean; // a known planet already at this period/host
  gaiaBlendRuledOut: boolean; // dilution/blend census clears an on-target companion (p97/p81)
  psfOrDiffImagingClear: boolean; // centroid / PSF / difference-imaging rules out an instrumental dip (p53/p44)
  harmonicAliasFpp: number; // probability the signal is a harmonic/period alias (p81)
  oddEvenAsymmetryFrac: number; // odd-vs-even transit depth asymmetry (shape consistency)
}
export interface GateSignificance {
  snr: number;
  ar1FalseAlarmProb: number; // FAR under the AR(1)-model null (calibratedFap, p98)
}
export interface GateProspective {
  validated: boolean; // was the operating point frozen, then applied to never-tuned FORWARD data?
  precisionWilsonLowerBound: number; // measured precision LB on that forward set
  expectedFalseClaims: number; // nAnnounced * FAR at the threshold (expected false discoveries in the batch)
}
export interface GateSignoff {
  humanApproved: boolean;
  reviewer: string;
}

export interface CandidateEvidence {
  novelty: GateNovelty;
  corroboration: GateCorroboration;
  significance: GateSignificance;
  prospective?: GateProspective | null; // absent/null until a prospective run is done -> cannot announce
  signoff?: GateSignoff | null; // absent/null until a human signs -> cannot announce
}

export interface DiscoveryProtocol {
  status: string;
  corroborationBars: {
    requireNoveltyEstablished: boolean;
    requireNotAlreadyKnown: boolean;
    minCrossSectorEphemerisCoherentSectors: number;
    requireNoCatalogDuplicate: boolean;
    requireGaiaBlendRuledOut: boolean;
    requirePsfOrDiffImagingClear: boolean;
    maxHarmonicAliasFpp: number;
    maxOddEvenAsymmetryFrac: number;
  };
  significanceBars: { minSnr: number; maxAr1FalseAlarmProb: number };
  prospectiveValidation: { required: boolean; minPrecisionWilsonLowerBound: number; maxExpectedFalseClaimsPerAnnouncementBatch: number };
  release: { announcementRequiresHumanSignoff: boolean; automatedMaySetDiscoveryClaim: boolean };
}

export interface GateResult {
  tier: DiscoveryTier;
  discoveryClaimAllowed: boolean; // true ONLY at "announcement" AND when a non-automated path may render it
  unmet: string[]; // one line per failed prerequisite, in stable order -- the auditable trail
}

/** Wilson score lower bound at ~95% (z=1.96) for k successes in n trials; the floor the protocol keys precision on. */
export function wilsonLowerBound(k: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.96;
  const phat = k / n;
  const denom = 1 + (z * z) / n;
  const centre = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return (centre - margin) / denom;
}

/**
 * Classify one candidate against the frozen protocol. Deterministic for fixed inputs; touches no I/O. The result is a
 * RECOMMENDATION plus the reason trail -- it never itself mutates any artifact. Callers that write a claim out must
 * check `discoveryClaimAllowed` AND that they are the human sign-off step the protocol demands.
 */
export function evaluateDiscoveryGate(c: CandidateEvidence, p: DiscoveryProtocol): GateResult {
  const unmet: string[] = [];
  const cb = p.corroborationBars;

  if (!/PRE-REGISTERED/i.test(p.status)) unmet.push("protocol is not pre-registered/frozen (criteria could move after seeing results)");

  // --- nomination prerequisites: novelty + every independent corroboration bar + significance ---
  if (cb.requireNoveltyEstablished && (c.novelty.confirmedScanned < 0 || c.novelty.toiScanned < 0)) {
    unmet.push("novelty not established (confirmed/TOI catalogs unavailable this run)");
  }
  if (cb.requireNotAlreadyKnown && (c.novelty.inConfirmed || c.novelty.inToi)) {
    unmet.push("not novel: host is already in the confirmed catalog or TOI list");
  }
  if (c.corroboration.crossSectorEphemerisCoherentSectors < cb.minCrossSectorEphemerisCoherentSectors) {
    unmet.push(`cross-sector phase-coherent ephemeris on ${c.corroboration.crossSectorEphemerisCoherentSectors} sector(s), below the required ${cb.minCrossSectorEphemerisCoherentSectors}`);
  }
  if (cb.requireNoCatalogDuplicate && c.corroboration.catalogDuplicate) unmet.push("signal duplicates a catalogued planet");
  if (cb.requireGaiaBlendRuledOut && !c.corroboration.gaiaBlendRuledOut) unmet.push("Gaia blend/dilution census has not ruled out an on-target companion");
  if (cb.requirePsfOrDiffImagingClear && !c.corroboration.psfOrDiffImagingClear) unmet.push("PSF / difference-imaging has not cleared an instrumental origin");
  if (!(c.corroboration.harmonicAliasFpp <= cb.maxHarmonicAliasFpp)) unmet.push(`harmonic/alias false-positive probability ${c.corroboration.harmonicAliasFpp} exceeds ${cb.maxHarmonicAliasFpp}`);
  if (!(c.corroboration.oddEvenAsymmetryFrac <= cb.maxOddEvenAsymmetryFrac)) unmet.push(`odd/even transit asymmetry ${c.corroboration.oddEvenAsymmetryFrac} exceeds ${cb.maxOddEvenAsymmetryFrac}`);
  if (!(c.significance.snr >= p.significanceBars.minSnr)) unmet.push(`SNR ${c.significance.snr} below ${p.significanceBars.minSnr}`);
  if (!(c.significance.ar1FalseAlarmProb <= p.significanceBars.maxAr1FalseAlarmProb)) unmet.push(`AR(1) false-alarm probability ${c.significance.ar1FalseAlarmProb} exceeds ${p.significanceBars.maxAr1FalseAlarmProb}`);

  const nominationEarned = unmet.length === 0;
  if (!nominationEarned) return { tier: "none", discoveryClaimAllowed: false, unmet };

  // --- announcement prerequisites: prospective validation clears the floor + human sign-off ---
  const prov = p.prospectiveValidation;
  const announceUnmet: string[] = [];
  if (prov.required) {
    if (!c.prospective || !c.prospective.validated) {
      announceUnmet.push("no prospective (never-tuned, forward) validation record -- the operating point is not yet validated on data it did not tune on");
    } else {
      if (!(c.prospective.precisionWilsonLowerBound >= prov.minPrecisionWilsonLowerBound)) {
        announceUnmet.push(`prospective precision Wilson LB ${c.prospective.precisionWilsonLowerBound.toFixed(3)} below the floor ${prov.minPrecisionWilsonLowerBound}`);
      }
      if (!(c.prospective.expectedFalseClaims <= prov.maxExpectedFalseClaimsPerAnnouncementBatch)) {
        announceUnmet.push(`expected false claims ${c.prospective.expectedFalseClaims} exceed the ceiling ${prov.maxExpectedFalseClaimsPerAnnouncementBatch}`);
      }
    }
  }
  if (p.release.announcementRequiresHumanSignoff && !(c.signoff && c.signoff.humanApproved && c.signoff.reviewer.trim().length > 0)) {
    announceUnmet.push("no human/peer sign-off for the announcement");
  }

  if (announceUnmet.length > 0) {
    // Earned nomination, not yet an announcement. Nomination is NOT a discovery claim.
    return { tier: "nomination", discoveryClaimAllowed: false, unmet: announceUnmet };
  }
  // Everything cleared AND a human signed. The claim may be true, but only the signed human path may render it:
  // an automated writer is forbidden by the protocol from setting discoveryClaim even here.
  return { tier: "announcement", discoveryClaimAllowed: !p.release.automatedMaySetDiscoveryClaim ? false : true, unmet: [] };
}
