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

export interface ReviewInput {
  candidate: TransitCandidate;
  /** odd-even alias multiple from the resolver (1 = clean). */
  aliasMultiple: number;
  /** catalog to cross-match against (real NASA rows or fallback). */
  catalog: ArchivePlanet[];
  /** restrict cross-match to one host when we know the target star. */
  hostName?: string;
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
}

export interface CrossmatchInfo {
  matchedKnownPlanet: boolean;
  knownPlanetName?: string;
  knownPeriodDays?: number;
  periodDeltaPct?: number;
  /** which harmonic matched (1 = direct). */
  harmonic?: number;
}

export interface ReviewResult {
  verdict: "accepted" | "rejected" | "needs-more-data";
  reason: string;
  score: number; // 0..100 composite confidence for the UI ranking
  crossmatch: CrossmatchInfo;
  checks: { name: string; pass: boolean; detail: string }[];
}

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
  for (const f of [1, 2, 0.5, 3, 1 / 3]) {
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

  // --- SNR check ---
  const snrPass = c.snr >= minSnr;
  checks.push({ name: "snr", pass: snrPass, detail: `SNR ${c.snr.toFixed(1)} (need >= ${minSnr})` });

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
      reason = `Blind recovery: significant, physically-consistent transit (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%) independently cross-matches ${cm.knownPlanetName} (P=${cm.knownPeriodDays?.toFixed(3)}d) at its fundamental period on evidence alone, without using any truth period.`;
    } else if (cm.matchedKnownPlanet) {
      // Matched ONLY via a harmonic (x2, x3, x1/2 ...): a probable alias of a known planet, not a
      // clean recovery. Never accepted/anchored -- flagged for follow-up.
      verdict = "needs-more-data";
      reason = `Significant transit cross-matches ${cm.knownPlanetName} only at harmonic x${cm.harmonic} -- a probable alias, not a clean blind recovery. Flag for follow-up.`;
    } else {
      // Evidence-strong but NO catalog match: the honest ceiling. A novel signal is flagged for
      // follow-up, NEVER auto-accepted as a discovery (guards the no-claim red line + money path).
      verdict = "needs-more-data";
      reason = `Significant, physically-consistent transit (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%) with no catalog match -- a candidate for follow-up, not a claimed discovery.`;
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
  }

  return { verdict, reason, score, crossmatch: cm, checks };
}
