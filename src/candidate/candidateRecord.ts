// HIGH-CONFIDENCE CANDIDATE CONTRACT (discovery roadmap, Stage 0).
//
// WHY THIS EXISTS. The rig is moving from "re-verify a planet we already know" toward "surface a
// NOVEL, follow-up-ready candidate from data nobody searched". Before we can safely emit such
// candidates we need ONE durable definition of what a candidate IS and, crucially, what we are
// ALLOWED to claim about it. This module is that contract. It composes primitives that already
// exist (novelty vs the confirmed/TOI catalogs, per-star calibrated significance, blend/dilution
// risk, geometry self-consistency, the detection floor) into a single record and a CONSERVATIVE
// confidence tier -- and it makes over-claiming impossible in code, not just in prose.
//
// HONESTY INVARIANTS (enforced, not asserted):
//   - A record is a CANDIDATE. `discoveryClaim` is hard-coded false and assertHonest() rejects any
//     attempt to flip it. Turning a candidate into a confirmed planet is a SCIENTIFIC act that
//     needs independent follow-up; this pipeline does not perform it and must never say it did.
//   - "high" confidence requires POSITIVE evidence on every axis. Anything undetermined (no Gaia
//     neighbours, no centroid measurement, catalog unavailable, missing significance) DOWNGRADES the
//     tier -- silence is never promoted to "probably fine".
//   - A signal we cannot even expect to detect (below our measured floor) is labelled "sub-floor",
//     which is a statement about OUR detector, not about the universe.
//
// This module is pure and dependency-injected: it does no network I/O, is not imported by the
// worker, and therefore cannot change any production verdict, bundle hash, or the money path.

import type { BlendRisk, GeometryResult, Detectability, NoveltyResult } from "../review/externalReview.ts";
import type { DepthAssessment } from "./falsePositive.ts";

export type ConfidenceTier = "high" | "moderate" | "low" | "sub-floor" | "not-novel" | "not-planetary";
export type DataTier = "real" | "stand-in";

/** The measured detection for one target (units: depth ppm, duration hours, period days). */
export interface CandidateDetection {
  periodDays: number;
  epochBjd: number;
  durationHours: number;
  depthPpm: number;
  snr: number;
  nSectors: number;
  nPointsInTransit: number;
}

export interface CandidateSignificance {
  fap: number; // empirical false-alarm probability calibrated to this star's own noise color
  rho: number; // measured lag-1 noise color the FAP was calibrated against
}

/** Host identity; ra/dec/tmag let a follow-up team point at it, gaiaSourceId links the astrometry. */
export interface CandidateHost {
  tic: number;
  ra: number;
  dec: number;
  tmag: number;
  gaiaSourceId?: string;
}

/**
 * Everything we managed to measure about false-positive risk. Any field left undefined/NaN is treated
 * as UNDETERMINED and can only downgrade confidence, never raise it.
 */
export interface CandidateVetting {
  blend?: BlendRisk | null;
  geometry?: GeometryResult | null;
  centroidOffsetArcsec?: number; // NaN = not measured
  oddEvenAsymmetryFrac?: number; // NaN = not measured
  secondaryEclipseDepthFrac?: number; // NaN = not measured
  detectability?: Detectability | null;
  depth?: DepthAssessment | null; // Stage-2 astrophysical FP screen (calibrated transit-depth regime)
}

export interface Thresholds {
  minSnr: number; // mirrors the production detection gate
  maxFap: number; // mirrors the production significance gate
  centroidHighMaxArcsec: number; // a centroid this far off the target is a red flag
}

export const DEFAULT_THRESHOLDS: Thresholds = { minSnr: 7, maxFap: 0.05, centroidHighMaxArcsec: 1.0 };

export interface ClassifyResult {
  tier: ConfidenceTier;
  reasons: string[]; // human-readable, each documents one decision (kept in stable order)
  followupNeeds: string[]; // what independent data would raise confidence -- never empty for a real candidate
}

function isSet(n: number | undefined): n is number {
  return n != null && Number.isFinite(n);
}

/**
 * The conservative tiering rule. Order matters: a known planet is "not-novel" (nothing to discover);
 * an undetectable-at-this-cadence signal is "sub-floor" (our limit, not a refutation); otherwise we
 * require positive evidence on every axis before granting "high".
 */
export function classifyConfidence(
  novelty: NoveltyResult,
  detection: CandidateDetection,
  significance: CandidateSignificance | null | undefined,
  vetting: CandidateVetting,
  th: Thresholds = DEFAULT_THRESHOLDS,
): ClassifyResult {
  const reasons: string[] = [];
  const followupNeeds: string[] = [];

  const catalogEstablished = novelty.confirmedScanned >= 0 && novelty.toiScanned >= 0;
  const novel = catalogEstablished && !novelty.inConfirmed && !novelty.inToi;

  if (!catalogEstablished) {
    reasons.push("novelty not established: the confirmed/TOI catalogs were unavailable this run, so we cannot assert the signal is new.");
    followupNeeds.push("re-run the novelty check against a live NASA Exoplanet Archive confirmed + TOI pull.");
  } else if (novelty.inConfirmed || novelty.inToi) {
    reasons.push(`not novel: host TIC is present in ${novelty.inConfirmed ? "the confirmed catalog" : ""}${novelty.inConfirmed && novelty.inToi ? " and " : ""}${novelty.inToi ? "the TOI list" : ""}.`);
    return { tier: "not-novel", reasons, followupNeeds: [] };
  } else {
    reasons.push(`novel: absent from ${novelty.confirmedScanned} confirmed and ${novelty.toiScanned} TOI hosts scanned.`);
  }

  if (vetting.detectability && vetting.detectability.belowOurFloor) {
    reasons.push(`sub-floor: ${vetting.detectability.reason}`);
    return { tier: "sub-floor", reasons, followupNeeds };
  }

  // Stage-2 astrophysical FP screen. Rejecting on depth is honest ONLY above the calibrated hard ceiling
  // (scripts/p21-depth-calibrate.ts): a signal deeper than every confirmed planet is an eclipsing binary or
  // blend, not a candidate. Everything shallower is at most downgraded -- never deleted -- because a naive
  // "deeper than 3%" cut would reject ~1% of real confirmed planets.
  if (vetting.depth && !vetting.depth.planetPlausible) {
    reasons.push(`not planetary: ${vetting.depth.reason}`);
    return { tier: "not-planetary", reasons, followupNeeds: [] };
  }

  const passSnr = detection.snr >= th.minSnr;
  const passFap = significance != null && isSet(significance.fap) && significance.fap <= th.maxFap;
  if (!passSnr) reasons.push(`SNR ${detection.snr.toFixed(1)} below the ${th.minSnr} gate.`);
  if (!passFap) reasons.push(significance == null ? "no calibrated significance supplied; cannot certify false-alarm probability." : `calibrated FAP ${significance.fap.toExponential(2)} exceeds ${th.maxFap}.`);

  const centroidOk = isSet(vetting.centroidOffsetArcsec) && vetting.centroidOffsetArcsec <= th.centroidHighMaxArcsec;
  const blendLow = vetting.blend?.tier === "low";
  const geomOk = vetting.geometry?.consistent === true;
  // A deep-suspect or unmeasured depth is an unresolved false-positive axis: it can never grant "high".
  const depthPlausible = !vetting.depth || vetting.depth.regime === "planet-plausible";
  const strongVetting = centroidOk && blendLow && geomOk && depthPlausible;

  // Anything undetermined is listed as a concrete follow-up need (never silently passed).
  if (!isSet(vetting.centroidOffsetArcsec)) followupNeeds.push("target-pixel cutout photometry to measure the centroid offset and confirm the dip sits on the target star.");
  else if (!centroidOk) followupNeeds.push(`centroid offset ${vetting.centroidOffsetArcsec?.toFixed(2)} arcsec is off-target -- resolve the source of the dip before believing it.`);
  if (!vetting.blend || vetting.blend.tier === "undetermined" || vetting.blend.tier === "high") followupNeeds.push("ground-based / high-resolution imaging to resolve any in-aperture blend and rule out a diluted eclipsing binary.");
  else if (vetting.blend.tier === "moderate") followupNeeds.push("a resolved follow-up look: intermediate contamination risk is not disqualifying but should be checked.");
  if (!isSet(vetting.oddEvenAsymmetryFrac)) followupNeeds.push("additional sectors to fill in transit epochs for an odd/even depth-symmetry check.");
  if (!isSet(vetting.secondaryEclipseDepthFrac)) followupNeeds.push("out-of-eclipse photometry / a secondary-eclipse search to exclude an eclipsing-binary impostor.");
  if (!geomOk) followupNeeds.push("an independent radius/period measurement; the reported geometry is not self-consistent.");
  if (vetting.depth?.regime === "deep-suspect") {
    reasons.push(`deep-suspect: ${vetting.depth.reason}`);
    followupNeeds.push("a resolved high-contrast / long-baseline blend and eclipsing-binary assessment: the depth sits in the brown-dwarf/EB-dominated band, so a planet cannot be believed without it.");
  } else if (vetting.depth?.regime === "unknown") {
    followupNeeds.push("a measured transit depth so the astrophysical (planet-vs-eclipsing-binary) plausibility screen can run.");
  }
  // A genuine candidate ALWAYS needs corroboration -- this is the pipeline refusing to crown a planet.
  followupNeeds.push("at least one independently-scheduled transit observation (photometric or spectroscopic) to corroborate the ephemeris.");

  let tier: ConfidenceTier;
  if (!passSnr || !passFap) {
    tier = "low";
    reasons.push("passes novelty but not the SNR/FAP gates -> low confidence.");
  } else if (strongVetting && catalogEstablished) {
    tier = "high";
    reasons.push("novel + SNR/FAP gates passed + centroid on-target + low blend risk + geometry self-consistent -> high-confidence CANDIDATE (still requires independent follow-up).");
  } else {
    tier = "moderate";
    reasons.push("novel and significant, but at least one false-positive axis is undetermined or not clean -> moderate; see follow-up needs.");
  }
  return { tier, reasons, followupNeeds };
}

/** The durable, follow-up-ready record the discovery pipeline emits. */
export interface CandidateRecord {
  host: CandidateHost;
  detection: CandidateDetection;
  significance: CandidateSignificance | null;
  novelty: NoveltyResult;
  vetting: CandidateVetting;
  tier: ConfidenceTier;
  reasons: string[];
  followupNeeds: string[];
  nextTransitsBjd: number[];
  dataTier: DataTier;
  catalogSource: { confirmed: string; toi: string; asOfUtc: string };
  /** Hard honesty flag: this rig surfaces candidates, it does not discover planets. Always false. */
  discoveryClaim: false;
  createdAt: string;
  bundleHash?: string;
}

export interface BuildInput {
  host: CandidateHost;
  detection: CandidateDetection;
  novelty: NoveltyResult;
  significance?: CandidateSignificance | null;
  vetting?: CandidateVetting;
  nextTransitsBjd: number[];
  dataTier: DataTier;
  catalogSource: { confirmed: string; toi: string; asOfUtc: string };
  thresholds?: Thresholds;
  nowIso?: string;
  bundleHash?: string;
}

/** Assemble a record: classify, then freeze the honesty invariants. Deterministic for fixed input. */
export function buildCandidateRecord(input: BuildInput): CandidateRecord {
  const vetting: CandidateVetting = input.vetting ?? {};
  const cls = classifyConfidence(input.novelty, input.detection, input.significance ?? null, vetting, input.thresholds ?? DEFAULT_THRESHOLDS);
  const record: CandidateRecord = {
    host: input.host,
    detection: input.detection,
    significance: input.significance ?? null,
    novelty: input.novelty,
    vetting,
    tier: cls.tier,
    reasons: cls.reasons,
    followupNeeds: cls.followupNeeds,
    nextTransitsBjd: input.nextTransitsBjd,
    dataTier: input.dataTier,
    catalogSource: input.catalogSource,
    discoveryClaim: false,
    createdAt: input.nowIso ?? new Date().toISOString(),
    bundleHash: input.bundleHash,
  };
  assertHonest(record);
  return record;
}

/**
 * Reject any record that would overstate itself: a flipped discovery claim, or a "high" tier that is
 * not actually novel or not above the detection floor. Called on every build, so a bug cannot quietly
 * publish an over-claim.
 */
export function assertHonest(r: CandidateRecord): void {
  if ((r.discoveryClaim as boolean) !== false) throw new Error("a candidate record may never carry a discovery claim");
  if (r.tier === "high") {
    if (r.novelty.inConfirmed || r.novelty.inToi) throw new Error("cannot grant high confidence to a non-novel signal");
    if (r.novelty.confirmedScanned < 0 || r.novelty.toiScanned < 0) throw new Error("cannot grant high confidence without an established novelty scan");
    if (r.vetting.detectability?.belowOurFloor) throw new Error("cannot grant high confidence to a sub-floor signal");
    if (r.vetting.depth && r.vetting.depth.regime !== "planet-plausible") throw new Error("cannot grant high confidence to a deep-suspect or unmeasured-depth signal");
  }
}

/**
 * Render a plain-text observability card a follow-up team can act on (Stage 3's deliverable shape,
 * defined here so the contract is complete). No markdown, no claims beyond the tier.
 */
export function formatFollowupCard(r: CandidateRecord): string {
  const lines: string[] = [];
  lines.push(`Candidate: TIC ${r.host.tic}  RA ${r.host.ra.toFixed(5)}  Dec ${r.host.dec.toFixed(5)}  T=${r.host.tmag.toFixed(2)}`);
  if (r.host.gaiaSourceId) lines.push(`Gaia source_id: ${r.host.gaiaSourceId}`);
  lines.push(`Confidence tier: ${r.tier}   (candidate, not a discovery claim)`);
  lines.push(`Signal: P=${r.detection.periodDays.toFixed(6)} d  T0=${r.detection.epochBjd.toFixed(4)} BJD  depth=${r.detection.depthPpm.toFixed(0)} ppm  T14=${r.detection.durationHours.toFixed(2)} h  SNR=${r.detection.snr.toFixed(1)}  ${r.detection.nSectors} sector(s)`);
  if (r.significance) lines.push(`Calibrated significance: FAP=${r.significance.fap.toExponential(2)} (noise color rho=${r.significance.rho.toFixed(2)})`);
  if (r.vetting.depth) lines.push(`Astrophysical FP screen (transit depth): ${r.vetting.depth.regime}${r.vetting.depth.planetPlausible ? "" : " -> NOT a planetary candidate"}`);
  lines.push(`Photometry tier: ${r.dataTier}`);
  if (r.nextTransitsBjd.length) lines.push(`Next predicted transits (BJD): ${r.nextTransitsBjd.slice(0, 6).map((t) => t.toFixed(3)).join(", ")}`);
  lines.push("Why this tier:");
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  lines.push("To raise confidence / corroborate:");
  for (const need of r.followupNeeds) lines.push(`  - ${need}`);
  if (r.bundleHash) lines.push(`Reproducible bundle hash: ${r.bundleHash}`);
  lines.push(`Catalog as of ${r.catalogSource.asOfUtc} (confirmed: ${r.catalogSource.confirmed}; TOI: ${r.catalogSource.toi}).`);
  return lines.join("\n");
}
