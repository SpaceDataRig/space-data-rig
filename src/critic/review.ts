// mission-critic seat: the acceptance decision.
//
// Turns a raw TransitCandidate + sim-runner confidence into a defensible
// verdict ("accepted" / "needs-more-data" / "rejected") with a written reason
// and a 0..100 composite score.
//
// BLIND BY DEFAULT. The verdict is driven ONLY by evidence the pipeline could
// compute without knowing the answer: BLS SNR, the noise-color calibrated
// false-alarm probability, physical sanity of the fit, transit coverage, alias
// cleanliness, the sim-runner re-injection recovery confidence, and (for real
// photometry) the pixel centroid shift. A known truth period -- when we have one
// -- is demoted to a POST-HOC informational cross-check: it is recorded for
// transparency but NEVER gates and NEVER scores. This is the honest protocol: a
// "recovery" only counts if the evidence would have convinced us without peeking.
//
// A significant, physically-consistent signal with NO catalog match is capped at
// "needs-more-data" -- it is flagged for follow-up, never auto-accepted as a
// discovery. That both guards the "we do not claim new planets" red line and keeps
// the money-path auto-anchor (accepted-only) from ever staking a novel candidate.
//
// RECOVERY gating (verdict anchored on the period error vs a known truth) is an
// explicit opt-in (recoveryGating: true) reserved for benchmark self-tests where we
// deliberately injected a known signal and want to grade the recovery.
//
// Keeping this in one place (instead of inline in a script) is what lets the
// orchestrator, the API and the bundle all report an identical verdict.

import type { ArchivePlanet, TransitCandidate } from "../core/types.ts";
import type { ConfidenceResult } from "../sim/confidence.ts";
import { crossmatchPeriod } from "../data/exoplanetArchive.ts";
import { detectionSnrOf } from "../detect/depthAdoption.ts";

export interface ReviewInput {
  candidate: TransitCandidate;
  /** odd-even alias multiple from the resolver (1 = clean). */
  aliasMultiple: number;
  /** catalog to cross-match against (real NASA rows or fallback). */
  catalog: ArchivePlanet[];
  /** restrict cross-match to one host when we know the target star. */
  hostName?: string;
  /**
   * Provenance of the `catalog` slice handed to the critic (audit #5 crossmatch tri-state). When it is
   * "fallback" or "failed" the slice is NOT an authoritative reference, so a "no match" must read as
   * "lookup incomplete", never as "novel". Absent => treated as an unknown-but-present slice, and the
   * review output is byte-for-byte identical to before (the deterministic synthetic/bundle path untouched).
   */
  catalogSource?: "nasa-tap" | "fallback" | "failed" | "unknown";
  /**
   * Targeted per-host cross-match from fetchPlanetsByHost, supplied by the caller ONLY when the bulk slice
   * produced no match. [] = lookup completed, nothing announced for this host; non-empty = a planet IS
   * announced outside the slice ("off-slice"); null = the targeted lookup FAILED. Absent => the tri-state is
   * not exercised and the result is unchanged.
   */
  hostCatalog?: ArchivePlanet[] | null;
  /** sim-runner per-signal recovery confidence (0..1). */
  confidence?: ConfidenceResult;
  /** what the reference period is: an injection or a catalog value (real photometry). */
  truthSource?: "injected" | "catalog";
  /**
   * Known reference period. In the DEFAULT blind mode this is used ONLY as a post-hoc,
   * non-gating, non-scoring cross-check (recorded in `checks` for transparency). It gates the
   * verdict only when `recoveryGating` is explicitly true.
   */
  truthPeriodDays?: number;
  /**
   * Opt-in RECOVERY gating for benchmark self-tests only. When true AND `truthPeriodDays` is
   * supplied, the verdict is anchored on the period error vs truth (did we get the known planet
   * back?) -- appropriate when we deliberately injected a known signal. DEFAULT false: the verdict
   * is BLIND, driven only by evidence, and truth is a post-hoc informational cross-check. This is
   * the honest default: a recovery must stand on evidence, not on already knowing the answer.
   */
  recoveryGating?: boolean;
  /** minimum SNR to consider (default 7). */
  minSnr?: number;
  /** number of in-transit points expected for a single transit; for context. */
  nTransitsObserved?: number;
  /**
   * Optional false-positive vetting evidence. Populated ONLY for real photometry when
   * the caller has computed it (pixel centroid shift, calibrated BLS FAP). When absent
   * the review is byte-for-byte identical to the un-vetted path, so the deterministic
   * synthetic/bundle-hash behaviour is untouched. Each sub-field, when present, adds a
   * named check and can force a rejection; a value left undefined adds nothing.
   */
  vetting?: ReviewVetting;
}

/** Externally-computed vetting metrics handed to the critic (see src/data/mastS3Pixels, src/detect/fap). */
export interface ReviewVetting {
  /** in-transit photocenter displacement in arcsec (large => the dip is off the target). */
  centroidShiftArcsec?: number;
  /** shift above which the candidate is flagged a blend/background EB (default 2.0 arcsec,
   *  empirically calibrated: confirmed planets measured by scripts/p2-vet-calibrate.ts cluster
   *  at <=0.5 arcsec, so a 2.0 arcsec cut rejects blends without dropping true positives). */
  shiftThresholdArcsec?: number;
  /** calibrated false-alarm probability of the BLS peak (see src/detect/significance.ts calibratedFap -- AR(1)-model nulls matched to the star's own noise color). */
  fap?: number;
  /** FAP above which the peak is deemed not significant against the null (default 0.05, calibrated on real planets and kept above the ensemble resolution floor 1/(nNull+1)). */
  fapThreshold?: number;
  /**
   * Coherent-systematics false-alarm probability of the BLS peak (src/detect/instrumentalNull.ts
   * systematicsAwareFap -- a null that includes the ensemble-common instrumental systematic, not just this
   * star's own noise). Populated ONLY when the caller has a same-cadence ensemble to build that null; when
   * absent the review is byte-for-byte the noise-only path. It attacks the FP class the per-star noise FAP
   * is blind to (a dip/spike shared across many stars at one cadence). Safety-certified before enabling:
   * scripts/p40-fp-safety.ts measures it declines ~0% of real detections under subtract-then-gate.
   */
  systematicsFap?: number;
  /** systematics-aware FAP above which the peak is deemed explainable by the coherent systematic (default 0.05, above the resolution floor). */
  systematicsFapThreshold?: number;
  /**
   * Odd/even transit depth asymmetry, normalized (|odd-even| / mean depth). A true single
   * planet is symmetric (~0); a half-period alias or blend shows unequal odd/even depths.
   * NOTE: the pipeline does NOT populate this for gating yet -- calibration showed single-
   * sector real data reaches >100% for confirmed planets, so it is logged as a diagnostic
   * only. Rejection is wired here for when a robust multi-transit ephemeris version exists.
   */
  oddEvenDiffFrac?: number;
  /** odd/even asymmetry above which the signal is deemed an alias/blend (default 0.5). */
  oddEvenDiffThreshold?: number;
  /** secondary-eclipse depth / primary-eclipse depth. A planet is << 1; an EB approaches 1. */
  secondaryRatio?: number;
  /** secondary/primary ratio at or above which the source is deemed an EB (default 0.5). */
  secondaryRatioThreshold?: number;
  /**
   * Soft blend-likelihood in [0,1] (higher = more blend-like), a CONTINUOUS summary of the pixel / dilution
   * vetting evidence rather than a binary veto. P57-P59 measured that those tools false-kill known planets, so
   * this is ADVISORY ONLY: it adds a non-gating informational check and a BOUNDED downweight to the ranking
   * score, and it can NEVER flip the verdict or enter the rejection reasons -- so the accepted-only money path
   * (auto-anchor) is untouched. Absent (undefined) => the review output is byte-for-byte identical to before.
   */
  blendScore?: number;
}

export interface CrossmatchInfo {
  matchedKnownPlanet: boolean;
  knownPlanetName?: string;
  knownPeriodDays?: number;
  periodDeltaPct?: number;
  /** which harmonic matched (1 = direct). */
  harmonic?: number;
  /**
   * crossmatch tri-state (audit #5): "hit" (direct slice match) / "alias" (harmonic-only) / "none" (the per-host
   * lookup COMPLETED and announced nothing -- a genuine novel reading) / "off-slice" (announced for this host but
   * outside the magnitude-limited slice) / "lookup-failed" (the catalog cross-match never completed -- a fetch
   * error) / "lookup-not-run" (a real row whose per-host re-query was never attempted, e.g. a missing host name --
   * novelty undetermined, explicitly NOT the same as a completed-and-empty "none").
   * Absent for the default path so pre-tri-state callers and their bundle hashes are unchanged.
   */
  status?: "hit" | "alias" | "none" | "off-slice" | "lookup-failed" | "lookup-not-run";
  /** for "off-slice": the name of the planet announced for this host outside the slice. */
  offSliceName?: string;
}

export interface ReviewResult {
  verdict: "accepted" | "rejected" | "needs-more-data";
  reason: string;
  score: number; // 0..100 composite confidence for the UI ranking
  crossmatch: CrossmatchInfo;
  checks: { name: string; pass: boolean; detail: string }[];
}

/** A box SNR above this cannot be a physically plausible single transit on a TESS baseline, so the critic refuses
 * to call such a signal "physically-consistent". Named constant so the browser projection-relabel mirror
 * (web/relabel.js) and this authority stay guarded-equal by tests/degeneracy-relabel.test.ts. */
export const SNR_IMPLAUSIBLE = 1000;

/** Physical sanity bounds for a genuine transit signal. */
const SANITY = {
  minDepthPpm: 20,
  maxDepthFrac: 0.5, // deeper than 50% is an eclipsing binary / artifact
  minDurationHours: 0.2,
  maxDurationHours: 24,
  minPointsInTransit: 6,
};

/** Cross-match a candidate period against the catalog, reporting the harmonic. */
function crossmatch(c: TransitCandidate, catalog: ArchivePlanet[], hostName?: string, tolPct = 2): CrossmatchInfo {
  const match = crossmatchPeriod(c.periodDays, catalog, hostName, tolPct);
  if (!match || match.pl_orbper == null) {
    return { matchedKnownPlanet: false };
  }
  // identify which harmonic produced the match
  let harmonic = 1;
  let bestErr = Infinity;
  for (const f of [1, 2, 0.5, 3, 1 / 3, 4, 1 / 4]) {
    const err = Math.abs(c.periodDays * f - match.pl_orbper) / match.pl_orbper;
    if (err < bestErr) {
      bestErr = err;
      harmonic = f;
    }
  }
  return {
    matchedKnownPlanet: true,
    knownPlanetName: match.pl_name,
    knownPeriodDays: match.pl_orbper,
    periodDeltaPct: bestErr * 100,
    harmonic,
  };
}

/** Run the full mission-critic review on one candidate. */
export function reviewCandidate(input: ReviewInput): ReviewResult {
  const c = input.candidate;
  const minSnr = input.minSnr ?? 7;
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // --- cross-match ---
  const cm = crossmatch(c, input.catalog, input.hostName);

  // crossmatch tri-state (audit #5): distinguish a direct hit / harmonic alias from "no match", and crucially
  // from a lookup that never completed or a planet announced OUTSIDE the magnitude-limited slice. Backward
  // compatible: unless the caller supplies catalogSource / hostCatalog, the status is hit/alias/none, no extra
  // check is added, and the deterministic synthetic/bundle path (and its hash) is byte-for-byte untouched. It
  // can only ever DOWNGRADE a "novel" reading -- it never produces a new accept (accept still needs a direct hit).
  const lookupGiven = input.catalogSource != null || input.hostCatalog !== undefined;
  let lookupStatus: "hit" | "alias" | "none" | "off-slice" | "lookup-failed" | "lookup-not-run";
  if (cm.matchedKnownPlanet) lookupStatus = cm.harmonic === 1 ? "hit" : "alias";
  else if (input.hostCatalog != null) {
    const off = crossmatchPeriod(c.periodDays, input.hostCatalog, input.hostName);
    if (off) { cm.offSliceName = off.pl_name; lookupStatus = "off-slice"; }
    else lookupStatus = "none";
  } else if (input.hostCatalog === null) lookupStatus = "lookup-failed";
  else if (input.catalogSource === "fallback" || input.catalogSource === "failed") lookupStatus = "lookup-failed";
  // R4: reaching here means hostCatalog is undefined AND the source was not a known-failed/fallback pull. If the
  // caller supplied a catalogSource (lookupGiven) but no per-host list, the per-host re-query never ran (the real
  // production case is a missing host name -- workflow.ts only fetches it when meta.hostName is present): novelty is
  // UNDETERMINED, NOT a completed-and-empty "none". When the caller supplied NOTHING (the default synthetic/bundle
  // path, lookupGiven false) this stays the byte-for-byte prior "none" so its reason and hash are untouched.
  else lookupStatus = lookupGiven ? "lookup-not-run" : "none";
  // Only stamp the tri-state onto the crossmatch object / add the check when the caller actually exercised it,
  // so the deterministic synthetic/bundle path (no lookup fields) keeps a byte-identical crossmatch and hash.
  if (lookupGiven) {
    cm.status = lookupStatus;
    checks.push({
      name: "catalog-lookup (informational, non-gating)",
      pass: lookupStatus !== "lookup-failed" && lookupStatus !== "lookup-not-run",
      detail: `crossmatch lookup state = ${lookupStatus}${cm.offSliceName ? ` (${cm.offSliceName} announced for this host outside the slice)` : ""}`,
    });
  }

  // --- SNR check ---
  // The floor is applied to the statistic the SEARCH produced, not to the significance of a refined depth: the
  // >= 7 threshold and the calibrated FAP ensemble are both distributions of the box statistic (the null runs
  // BLS and records its SNR), so comparing a shape fit's re-priced SNR against them would be a unit mismatch.
  // The published depth keeps its own SNR in `c.snr`, which is what the score, the reason and the record show.
  const gateSnr = detectionSnrOf(c);
  const snrPass = gateSnr >= minSnr;
  checks.push({
    name: "snr",
    pass: snrPass,
    detail: Math.abs(gateSnr - c.snr) < 1e-9
      ? `SNR ${c.snr.toFixed(1)} (need >= ${minSnr})`
      : `detection SNR ${gateSnr.toFixed(1)} on the box depth (need >= ${minSnr}); the published ${(1e6 * c.depthFrac).toFixed(0)} ppm depth carries SNR ${c.snr.toFixed(1)} at the same scatter`,
  });

  // --- depth sanity ---
  const depthPpm = c.depthFrac * 1e6;
  const depthPass = depthPpm >= SANITY.minDepthPpm && c.depthFrac <= SANITY.maxDepthFrac;
  checks.push({ name: "depth", pass: depthPass, detail: `depth ${depthPpm.toFixed(0)} ppm` });

  // --- duration sanity ---
  const durPass = c.durationHours >= SANITY.minDurationHours && c.durationHours <= SANITY.maxDurationHours;
  checks.push({ name: "duration", pass: durPass, detail: `duration ${c.durationHours.toFixed(2)} h` });

  // --- enough points in transit ---
  const nPass = c.nPointsInTransit >= SANITY.minPointsInTransit;
  checks.push({ name: "coverage", pass: nPass, detail: `${c.nPointsInTransit} points in transit` });

  // --- alias cleanliness ---
  const aliasPass = input.aliasMultiple === 1;
  checks.push({
    name: "odd-even",
    pass: aliasPass,
    detail: aliasPass ? "period is clean (alias x1)" : `period alias x${input.aliasMultiple} resolved by odd-even test`,
  });

  // --- sim-runner recovery confidence ---
  const conf = input.confidence?.confidence;
  if (conf != null) {
    const confPass = conf >= 0.5;
    checks.push({ name: "recovery-confidence", pass: confPass, detail: `re-injection recovery ${(conf * 100).toFixed(0)}%` });
  }

  // --- period accuracy vs truth ---
  // In the DEFAULT blind mode this is a POST-HOC informational cross-check: recorded for
  // transparency, never gating, never scored. It gates the verdict only when recoveryGating is on.
  const recoveryGating = input.recoveryGating === true && input.truthPeriodDays != null;
  let periodErrPct: number | null = null;
  if (input.truthPeriodDays != null) {
    periodErrPct = (Math.abs(c.periodDays - input.truthPeriodDays) / input.truthPeriodDays) * 100;
    const pPass = periodErrPct < 2;
    const refLabel = input.truthSource === "catalog" ? "catalog" : "injected";
    checks.push(
      recoveryGating
        ? { name: "period-vs-truth", pass: pPass, detail: `period error ${periodErrPct.toFixed(2)}% vs injected` }
        : { name: "period-vs-truth (post-hoc, non-gating)", pass: pPass, detail: `period error ${periodErrPct.toFixed(2)}% vs the ${refLabel} value -- informational only; the verdict is evidence-driven and never peeked at truth` },
    );
  }

  // --- composite score (0..100) ---
  // Truth contributes ONLY in explicit recovery-gating mode; in the blind default it must not
  // inflate the score -- the verdict has to stand on evidence alone.
  let score = 0;
  score += Math.min(40, (c.snr / 20) * 40); // SNR contributes up to 40
  if (conf != null) score += conf * 25; // recovery confidence up to 25
  else score += 10; // unknown confidence: neutral-low
  if (cm.matchedKnownPlanet) score += 20; // cross-match up to 20
  if (aliasPass) score += 10; // clean odd-even 10
  if (recoveryGating && periodErrPct != null) score += periodErrPct < 1 ? 5 : periodErrPct < 2 ? 3 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // --- degeneracy guard (honesty, NOT a verdict gate) ---
  // A box SNR far above anything a real transit on this baseline can reach, a depth whose significance was
  // re-priced on a different number, or a period pinned on the long-edge of the search grid are NOT evidence of
  // a "physically-consistent" signal. These flags never move the verdict tier (already capped at needs-more-data
  // unless a DIRECT catalog match holds) -- they only stop the written reason from asserting a physical
  // consistency the degenerate metrics do not support. An audit found 6 live findings whose reason claimed
  // "physically-consistent transit" while carrying SNR up to 45171, a non-positive/repriced depth, or P=16.0000
  // at the search boundary. Broadening harmonic detection elsewhere can only SHRINK the accepted set (acceptance
  // requires harmonic===1), so this stays money-path conservative.
  const snrImplausible = Math.abs(c.snr) > SNR_IMPLAUSIBLE;
  let depthSigInconsistent = false;
  if (Number.isFinite(c.noiseSigmaFrac as number) && (c.noiseSigmaFrac as number) > 0 && Number.isFinite(c.snr)) {
    const nIn0 = Math.max(1, c.nPointsInTransit || 1);
    const snrDepth0 = (c.snr * (c.noiseSigmaFrac as number)) / Math.sqrt(nIn0);
    if (snrDepth0 > 0 && c.depthFrac > 0) {
      const f0 = snrDepth0 / c.depthFrac;
      if (f0 > 1.5 || f0 < 1 / 1.5) depthSigInconsistent = true;
    }
  }
  const degenerateSig = snrImplausible || depthSigInconsistent || c.atSearchBoundary === true;

  // --- verdict ---
  const hardFail = !depthPass || !durPass || !nPass || !snrPass;
  let verdict: ReviewResult["verdict"];
  let reason: string;

  if (recoveryGating) {
    // RECOVERY self-test mode (opt-in): did we get the KNOWN planet back? Truth gates here.
    const refLabel = input.truthSource === "catalog" ? "the catalog transits" : "the injected signal";
    if (periodErrPct != null && periodErrPct < 2 && snrPass) {
      verdict = "accepted";
      reason = `Recovers ${refLabel}: period error ${periodErrPct.toFixed(2)}%, SNR ${c.snr.toFixed(0)}` +
        (cm.matchedKnownPlanet ? `, cross-matches ${cm.knownPlanetName}` : "") + `.`;
    } else if (periodErrPct != null && periodErrPct < 5 && !hardFail) {
      verdict = "needs-more-data";
      reason = `Close but not conclusive: period error ${periodErrPct.toFixed(2)}%, SNR ${c.snr.toFixed(1)}. Needs a second sector.`;
    } else {
      verdict = "rejected";
      reason = hardFail && !snrPass
        ? `Too weak to trust: SNR ${c.snr.toFixed(1)} < ${minSnr}; likely noise or a single-transit artifact.`
        : `Period error ${periodErrPct?.toFixed(2) ?? "?"}% exceeds tolerance; not a reliable recovery.`;
    }
  } else {
    // BLIND mode (DEFAULT): the verdict is driven ONLY by evidence; truth is never consulted.
    // Acceptance is deliberately STRICTER than the old truth-gated recovery (it adds the alias,
    // confidence, coverage and noise-color FAP gates and requires a DIRECT catalog match), so the
    // accepted set is a SUBSET of the old one -- on the money path that means fewer or equal
    // auto-anchors, never more. Everything short of a clean blind recovery is capped at
    // needs-more-data (flag for follow-up), never rejected outright unless the evidence fails.
    const confLow = conf != null && conf < 0.35;
    const fewTransits = input.nTransitsObserved != null && input.nTransitsObserved < 3;
    const directMatch = cm.matchedKnownPlanet && cm.harmonic === 1;
    if (hardFail) {
      verdict = "rejected";
      reason = !snrPass
        ? `SNR ${c.snr.toFixed(1)} below threshold ${minSnr}; signal not significant.`
        : `Fit fails physical sanity (${checks.filter((x) => !x.pass).map((x) => x.name).join(", ")}).`;
    } else if (confLow || fewTransits) {
      verdict = "needs-more-data";
      const why = confLow ? `re-injection recovery only ${((conf ?? 0) * 100).toFixed(0)}%` : `only ${input.nTransitsObserved} transits observed`;
      reason = `Plausible but under-constrained (${why}). Flag for follow-up with more sectors.`;
    } else if (!aliasPass) {
      verdict = "needs-more-data";
      reason = `Significant transit, but the period is an odd-even alias (x${input.aliasMultiple}); the fundamental period is not cleanly resolved. Flag for follow-up.`;
    } else if (directMatch) {
      // Evidence-strong AND it independently cross-matches a catalog planet at its fundamental
      // period -> a genuine blind recovery (no truth period was consulted to reach this verdict).
      verdict = "accepted";
      reason = `Blind recovery: ${degenerateSig ? "significant but DEGENERATE transit (SNR/depth-significance/search-edge flagged in the checks; physical consistency is not asserted)" : "significant, physically-consistent transit"} (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%) independently cross-matches ${cm.knownPlanetName} (P=${cm.knownPeriodDays?.toFixed(3)}d) at its fundamental period on evidence alone, without using any truth period.`;
    } else if (cm.matchedKnownPlanet) {
      // Matched ONLY via a harmonic (x2, x3, x1/2 ...): a probable alias of a known planet, not a
      // clean recovery. Never accepted/anchored -- flagged for follow-up.
      verdict = "needs-more-data";
      reason = `Significant transit cross-matches ${cm.knownPlanetName} only at harmonic x${cm.harmonic} -- a probable alias, not a clean blind recovery. Flag for follow-up.`;
    } else {
      // Evidence-strong but NO match inside the slice: the honest ceiling. Never auto-accepted. The tri-state
      // separates genuinely-novel ("none") from "announced outside our slice" ("off-slice") and from a lookup
      // that never completed ("lookup-failed"), so a silent fetch failure is never read as novelty. The default
      // "none" wording is byte-for-byte the prior text, so callers not exercising the tri-state are unchanged.
      verdict = "needs-more-data";
      if (lookupStatus === "off-slice") {
        reason = `Significant transit, no match inside the bulk catalog slice, but ${cm.offSliceName ?? "a planet"} IS announced for this host at a cross-matching period (the authoritative per-host lookup completed) -- already published outside the slice we scanned, NOT novel. Flag for follow-up, not a claimed discovery.`;
      } else if (lookupStatus === "lookup-failed" || lookupStatus === "lookup-not-run") {
        reason = `${degenerateSig ? "Significant but DEGENERATE transit (SNR/depth-significance/search-edge flagged in the checks; physical consistency is not asserted)" : "Significant, physically-consistent transit"} (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%) but the catalog cross-match did NOT complete (the per-host lookup either failed or was never run for this host) -- novelty is undetermined, this is neither evidence of a new planet nor of a known one. Flag for a re-run with a working catalog lookup.`;
      } else {
        reason = `${degenerateSig ? "Significant but DEGENERATE transit (SNR/depth-significance/search-edge flagged in the checks; physical consistency is not asserted)" : "Significant, physically-consistent transit"} (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%) with no catalog match -- a candidate for follow-up, not a claimed discovery.`;
      }
    }
  }

  // --- false-positive vetting (only when the caller supplies evidence) ---
  // This block is fully gated on input.vetting: with no vetting the checks array, score,
  // verdict and reason are exactly as computed above, so the default (synthetic) path and
  // its bundle hash are unchanged. When present, each available metric adds a named check;
  // a failed metric is disqualifying (a large photocenter shift means the dip is not on the
  // target star; an insignificant FAP means the peak is not distinguishable from the null).
  if (input.vetting) {
    const v = input.vetting;
    const shiftThr = v.shiftThresholdArcsec ?? 2.0; // calibrated on real confirmed planets (see p2-vet-calibrate)
    const fapThr = v.fapThreshold ?? 0.05; // calibrated on REAL planets (see p1-fap-calibrate): must sit ABOVE the empirical-FAP resolution floor 1/(nNull+1), else every candidate -- real planets included -- is floored to a value > threshold and silently killed. With nNull~120 the floor is ~0.008; known SNR>=7 planets all measure at the floor, so 0.05 keeps ~4x margin while still rejecting genuinely insignificant peaks.
    const failReasons: string[] = [];
    let anyVetting = false;

    if (v.centroidShiftArcsec != null && isFinite(v.centroidShiftArcsec)) {
      anyVetting = true;
      const ok = v.centroidShiftArcsec <= shiftThr;
      checks.push({
        name: "centroid-shift",
        pass: ok,
        detail: `in-transit photocenter shift ${v.centroidShiftArcsec.toFixed(2)} arcsec (need <= ${shiftThr})`,
      });
      if (!ok) failReasons.push(`photocenter shift ${v.centroidShiftArcsec.toFixed(2)} arcsec places the light off the target star (blend / background eclipsing binary)`);
    }

    if (v.fap != null && isFinite(v.fap)) {
      anyVetting = true;
      const ok = v.fap <= fapThr;
      checks.push({
        name: "fap",
        pass: ok,
        detail: `BLS false-alarm probability ${v.fap.toPrecision(2)} (need <= ${fapThr})`,
      });
      if (!ok) failReasons.push(`false-alarm probability ${v.fap.toPrecision(2)} is not significant against the phase-scrambled null`);
    }

    const sysFapThr = v.systematicsFapThreshold ?? 0.05;
    if (v.systematicsFap != null && isFinite(v.systematicsFap)) {
      anyVetting = true;
      const ok = v.systematicsFap <= sysFapThr;
      checks.push({
        name: "systematics-fap",
        pass: ok,
        detail: `coherent-systematics false-alarm probability ${v.systematicsFap.toPrecision(2)} (need <= ${sysFapThr})`,
      });
      if (!ok) failReasons.push(`false-alarm probability ${v.systematicsFap.toPrecision(2)} is within what the ensemble-common instrumental systematic alone produces -- a coherent artifact, not a planet`);
    }

    const oddEvenThr = v.oddEvenDiffThreshold ?? 0.5;
    if (v.oddEvenDiffFrac != null && isFinite(v.oddEvenDiffFrac)) {
      anyVetting = true;
      const ok = v.oddEvenDiffFrac <= oddEvenThr;
      checks.push({
        name: "odd-even-depth",
        pass: ok,
        detail: `odd/even transit-depth asymmetry ${v.oddEvenDiffFrac.toFixed(2)} (need <= ${oddEvenThr})`,
      });
      if (!ok) failReasons.push(`odd/even transit depths differ by ${(v.oddEvenDiffFrac * 100).toFixed(0)}% -- a half-period alias or blend, not a once-per-orbit planet`);
    }

    const secThr = v.secondaryRatioThreshold ?? 0.5;
    if (v.secondaryRatio != null && isFinite(v.secondaryRatio)) {
      anyVetting = true;
      const ok = v.secondaryRatio < secThr;
      checks.push({
        name: "secondary-eclipse",
        pass: ok,
        detail: `secondary/primary depth ratio ${v.secondaryRatio.toFixed(2)} (need < ${secThr})`,
      });
      if (!ok) failReasons.push(`phase-0.5 secondary is ${v.secondaryRatio.toFixed(2)}x the primary -- an eclipsing binary, not a planet`);
    }

    if (failReasons.length > 0) {
      verdict = "rejected";
      reason = `False-positive vetting failed: ${failReasons.join("; ")}.`;
      score = Math.min(score, 20);
    } else if (anyVetting) {
      // every supplied vetting metric passed -> reinforce (bounded), never manufacture an accept
      score = Math.min(100, score + 5);
    }

    // --- soft blend-likelihood: an ADVISORY weight on the ranking score, never a gate ---
    // The pixel/dilution tools are known to false-kill real planets (P57-P59), so we surface their continuous
    // blend-likelihood as information + at most a 15% ranking downweight. This deliberately does NOT touch
    // `verdict` or `failReasons`; the money-path auto-anchor keys off `verdict` (accepted-only) and is safe.
    if (v.blendScore != null && isFinite(v.blendScore)) {
      const bs = Math.min(1, Math.max(0, v.blendScore));
      checks.push({
        name: "blend-likelihood (soft, non-gating)",
        pass: bs < 0.5,
        detail: `soft blend-likelihood ${bs.toFixed(2)} -- informational ranking weight only; never a veto (these tools false-kill known planets, P57-P59)`,
      });
      score = Math.max(0, Math.round(score * (1 - 0.15 * bs)));
    }
  }

  // --- search-range boundary: INFORMATIONAL ONLY, and deliberately so ---
  // A BLS peak that lands on the longest period the grid tried is not a measurement of that period: the search
  // ran out of range. Measured on the live rig, 3 of 90 findings sat exactly on the k=0 node of a 16-day maximum
  // and one had already been announced publicly as "P=16.00d". Gating on this would change verdict semantics
  // without a calibration run, so it is recorded, reported, and NOT allowed to move `verdict`, `failReasons` or
  // `score`. The name carries "non-gating" so scienceProjection() excludes it and the content address is
  // unchanged -- the bundle still commits to the fact, and no already-anchored science re-prices.
  if (c.atSearchBoundary) {
    const lim = Number.isFinite(c.searchMaxPeriodDays as number) ? (c.searchMaxPeriodDays as number) : NaN;
    checks.push({
      name: "period-at-search-boundary (informational, non-gating)",
      pass: false,
      detail: Number.isFinite(lim)
        ? `the recovered period ${c.periodDays.toFixed(2)} d is the LONG-PERIOD EDGE of the trial grid (max ${lim} d), so it is a lower bound on a longer signal, not a measured period`
        : `the recovered period ${c.periodDays.toFixed(2)} d is the long-period edge of the trial grid, not a measured period`,
    });
  }

  // THE DEPTH AND THE SIGNIFICANCE MUST DESCRIBE THE SAME NUMBER. `snr` is not an independent measurement: it is
  // depth/sigma*sqrt(nIn), computed by the detector from the BOX depth and the out-of-box scatter. If a record
  // publishes a depth refined by a per-sector shape fit while still quoting that original significance, the two
  // numbers describe different transits and cannot be read together. Inverting the same formula recovers the depth
  // the SNR was measured on, which is what makes this checkable rather than a matter of opinion: on KELT-24 b it
  // returned 6100 ppm against a published 38 ppm, and 38 ppm on that scatter would require a per-point noise below
  // the instrument's photon floor. src/detect/depthAdoption.ts now re-prices the SNR whenever it publishes a
  // refined depth, so a NEW record cannot fail this; a failure means some path replaced a depth without going
  // through that helper -- which is exactly what this check exists to catch. Recorded, never gated: the 80 legacy
  // rows carrying the contradiction are anchored history and gating here would retroactively move their verdicts.
  if (Number.isFinite(c.noiseSigmaFrac as number) && (c.noiseSigmaFrac as number) > 0 && Number.isFinite(c.snr)) {
    const nIn = Math.max(1, c.nPointsInTransit || 1);
    const snrDepth = (c.snr * (c.noiseSigmaFrac as number)) / Math.sqrt(nIn);
    if (snrDepth > 0 && c.depthFrac > 0) {
      const f = snrDepth / c.depthFrac;
      if (f > 1.5 || f < 1 / 1.5) {
        checks.push({
          name: "depth-vs-significance-consistency (informational, non-gating)",
          pass: false,
          detail: `the quoted SNR ${c.snr.toFixed(1)} on ${(1e6 * (c.noiseSigmaFrac as number)).toFixed(1)} ppm scatter over ${nIn} in-transit points describes a ${(1e6 * snrDepth).toFixed(0)} ppm depth, while the record publishes ${(1e6 * c.depthFrac).toFixed(0)} ppm (${f.toFixed(1)}x apart); the significance is the detector's box measurement, not the published depth${c.depthSource === "per-sector-median" ? ", which was refined by a per-sector shape fit" : ""}`,
        });
      }
    }
  }

  if (snrImplausible) {
    checks.push({
      name: "significance-plausibility (informational, non-gating)",
      pass: false,
      detail: `the quoted SNR ${c.snr.toFixed(0)} is far above what a real transit on this baseline can reach, so the significance is a fit artifact, not physical-consistency evidence`,
    });
  }

  return { verdict, reason, score, crossmatch: cm, checks };
}
