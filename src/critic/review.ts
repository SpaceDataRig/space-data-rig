// mission-critic seat: the acceptance decision.
//
// Turns a raw TransitCandidate + sim-runner confidence into a defensible
// verdict ("accepted" / "needs-more-data" / "rejected") with a written reason
// and a 0..100 composite score. Two operating modes:
//
//   - RECOVERY mode: we injected a planet with a known period (benchmark /
//     P0 demo). Verdict is anchored on the period error vs truth.
//   - BLIND mode: real MAST data, no truth available. Verdict leans on SNR,
//     physical sanity of the fit, and the sim-runner recovery confidence.
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
  /** known injected period, when running in recovery mode. */
  truthPeriodDays?: number;
  /** minimum SNR to consider (default 7). */
  minSnr?: number;
  /** number of in-transit points expected for a single transit; for context. */
  nTransitsObserved?: number;
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

  // --- period accuracy vs truth (recovery mode only) ---
  let periodErrPct: number | null = null;
  if (input.truthPeriodDays != null) {
    periodErrPct = (Math.abs(c.periodDays - input.truthPeriodDays) / input.truthPeriodDays) * 100;
    const pPass = periodErrPct < 2;
    checks.push({ name: "period-vs-truth", pass: pPass, detail: `period error ${periodErrPct.toFixed(2)}% vs injected` });
  }

  // --- composite score (0..100) ---
  let score = 0;
  score += Math.min(40, (c.snr / 20) * 40); // SNR contributes up to 40
  if (conf != null) score += conf * 25; // recovery confidence up to 25
  else score += 10; // unknown confidence: neutral-low
  if (cm.matchedKnownPlanet) score += 20; // cross-match up to 20
  if (aliasPass) score += 10; // clean odd-even 10
  if (periodErrPct != null) score += periodErrPct < 1 ? 5 : periodErrPct < 2 ? 3 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // --- verdict ---
  const hardFail = !depthPass || !durPass || !nPass || !snrPass;
  let verdict: ReviewResult["verdict"];
  let reason: string;

  if (input.truthPeriodDays != null) {
    // recovery mode: did we get the known planet back?
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
    // BLIND mode: no truth, rely on evidence.
    const confLow = conf != null && conf < 0.35;
    if (hardFail) {
      verdict = "rejected";
      reason = !snrPass
        ? `SNR ${c.snr.toFixed(1)} below threshold ${minSnr}; signal not significant.`
        : `Fit fails physical sanity (${checks.filter((x) => !x.pass).map((x) => x.name).join(", ")}).`;
    } else if (confLow || (input.nTransitsObserved != null && input.nTransitsObserved < 3)) {
      verdict = "needs-more-data";
      const why = confLow ? `re-injection recovery only ${((conf ?? 0) * 100).toFixed(0)}%` : `only ${input.nTransitsObserved} transits observed`;
      reason = `Plausible but under-constrained (${why}). Flag for follow-up with more sectors.`;
    } else {
      verdict = "accepted";
      reason = cm.matchedKnownPlanet
        ? `Significant, physically-consistent transit (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%), consistent with ${cm.knownPlanetName}.`
        : `Significant, physically-consistent transit (SNR ${c.snr.toFixed(0)}, recovery ${((conf ?? 0) * 100).toFixed(0)}%); no catalog match -> possible new candidate.`;
    }
  }

  return { verdict, reason, score, crossmatch: cm, checks };
}
