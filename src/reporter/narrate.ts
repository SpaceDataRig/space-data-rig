// reporter seat: plain-language narration.
//
// The rig does real astronomy, but the frontend audience is traders, not
// astronomers. The reporter's job is to translate every event and finding into
// a sentence a non-specialist understands *without* throwing away the real
// numbers (period, depth, SNR, recovery confidence). Nothing here invents
// data -- it only re-phrases what the other seats produced.
//
// All strings are ASCII English (no emoji, no non-Latin characters) so they
// render identically in the terminal, the JSON bundle and the browser.

import type { Finding, RigEvent, SeatName } from "../core/types.ts";
import { wilsonInterval } from "../sim/completenessGrid.ts";
import { isRealPhotometry } from "../data/dataTier.ts";

/** Trader-facing label + color for a verdict (used by the findings board). */
export function verdictBadge(verdict: Finding["verdict"]): { label: string; tone: "good" | "warn" | "bad" } {
  switch (verdict) {
    case "accepted":
      // "RECOVERED" (not "CONFIRMED"): the rig re- detects a signal in the pixels, it does not
      // confirm a planet. Kept byte-identical to the frontend BADGE map so card + narration agree.
      return { label: "RECOVERED", tone: "good" };
    case "needs-more-data":
      return { label: "WATCHLIST", tone: "warn" };
    default:
      return { label: "REJECTED", tone: "bad" };
  }
}

/** A short human name for each seat, for the live topology view. */
export function seatRole(seat: SeatName): string {
  switch (seat) {
    case "data-fetch":
      return "Data Fetcher (pulls real NASA star data)";
    case "anomaly-scout":
      return "Anomaly Scout (hunts for transit dips)";
    case "sim-runner":
      return "Sim Runner (replays the signal to prove it is real)";
    case "mission-critic":
      return "Mission Critic (accepts or rejects the finding)";
    case "reporter":
      return "Reporter (writes the plain-English summary)";
  }
}

/** Turn one RigEvent into a single feed line. */
export function narrateEvent(ev: RigEvent): string {
  const role = ev.seat;
  const prefix = ev.level === "error" ? "[!] " : ev.level === "result" ? "[+] " : "";
  return `${prefix}${role}: ${ev.message}`;
}

/** Plain-English explainer for what "SNR" means, tuned to the value. */
function explainSnr(snr: number): string {
  if (snr >= 20) return `very strong (SNR ${snr.toFixed(0)}) -- the dip towers over the noise`;
  if (snr >= 10) return `strong (SNR ${snr.toFixed(0)}) -- clearly above the noise`;
  if (snr >= 7) return `solid (SNR ${snr.toFixed(0)}) -- above our detection threshold`;
  return `weak (SNR ${snr.toFixed(0)}) -- barely distinguishable from noise`;
}

/**
 * Build the trader-facing story for a Finding: a one-line headline, a plain
 * explainer paragraph, and the hard numbers. This is exactly what the frontend
 * finding card renders, and what gets written into the reproducible bundle.
 */
export function narrateFinding(
  f: Finding,
  opts?: { lightCurveSource?: string },
): { headline: string; explainer: string; stats: Record<string, string> } {
  const c = f.candidate;
  const badge = verdictBadge(f.verdict);
  const depthPpm = Math.round(c.depthFrac * 1e6);
  const planetYear = c.periodDays;

  // Data-source honesty (HANDOFF red line): every user-facing headline must say whether its
  // photons are real TESS photometry or a reproducible stand-in. Uses the single canonical
  // discriminator (src/data/dataTier.ts), schema-pinned by tests/schemaContract.test.ts -- BOTH
  // branches are labelled, never a hardcoded stand-in.
  const prov = isRealPhotometry(opts?.lightCurveSource) ? "[real TESS photometry] " : "[stand-in synthetic curve] ";

  let headline: string;
  if (f.verdict === "accepted") {
    headline = f.crossmatch.matchedKnownPlanet
      ? `${prov}Recovered a ${planetYear.toFixed(2)}-day signal matching known ${f.crossmatch.knownPlanetName}.`
      : `${prov}Recovered a planet-like ${planetYear.toFixed(2)}-day signal (candidate; needs independent follow-up).`;
  } else if (f.verdict === "needs-more-data") {
    headline = `${prov}Possible ${planetYear.toFixed(2)}-day signal -- promising but unproven, needs more data.`;
  } else {
    headline = `${prov}The ${planetYear.toFixed(2)}-day signal did not pass scrutiny.`;
  }

  const confPct = f.recoveryConfidence != null ? Math.round(f.recoveryConfidence * 100) : null;
  const trials = f.recoveryTrials;
  // Present the recovery number WITH its sample size + binomial CI, and state plainly that it is a
  // CONDITIONAL (search window brackets the recovered period) targeted re-injection -- not blind-search
  // capability. An integer percent off a handful of trials carries ~+/-17% scatter, so a bare "%" overstates it.
  let recoveryNote = "";
  let recoveryStat = "n/a";
  if (confPct != null) {
    if (trials && trials.nTrials > 0) {
      const [lo, hi] = wilsonInterval(trials.nRecovered, trials.nTrials);
      recoveryStat = `${confPct}% (${trials.nRecovered}/${trials.nTrials}, ${Math.round(lo * 100)}-${Math.round(hi * 100)}% CI)`;
      recoveryNote =
        `A targeted re-injection (search window brackets the recovered period) recovered this signal in ` +
        `${trials.nRecovered}/${trials.nTrials} trials (${confPct}%, 95% Wilson CI ${Math.round(lo * 100)}-${Math.round(hi * 100)}%). ` +
        `This gauges how trustworthy the signal is, NOT the pipeline's blind-search capability. `;
    } else {
      recoveryStat = `${confPct}%`;
      recoveryNote = `Re-injection recovered this signal about ${confPct}% of the time (trial count not recorded). `;
    }
  }

  const explainer =
    `The star's brightness dips by about ${depthPpm} parts per million once every ${planetYear.toFixed(2)} days -- ` +
    `that repeating dip is the fingerprint of a planet crossing (transiting) the star. ` +
    `The signal is ${explainSnr(c.snr)}. ` +
    recoveryNote +
    `Mission Critic verdict: ${badge.label} -- ${f.verdictReason}`;

  const stats: Record<string, string> = {
    Target: f.targetId,
    "Planet year (period)": `${planetYear.toFixed(4)} days`,
    "Transit depth": `${depthPpm} ppm (${(c.depthFrac * 100).toFixed(3)}%)`,
    "Transit duration": `${c.durationHours.toFixed(2)} hours`,
    "Signal strength (SNR)": c.snr.toFixed(1),
    "Recovery confidence": recoveryStat,
    "Known-planet match": f.crossmatch.matchedKnownPlanet ? `${f.crossmatch.knownPlanetName} (${f.crossmatch.periodDeltaPct?.toFixed(2)}% off)` : "none",
    Verdict: badge.label,
  };
  if (f.bundleHash) stats["Bundle hash"] = `${f.bundleHash.slice(0, 16)}...`;
  if (f.solanaTx) stats["Solana tx"] = `${f.solanaTx.slice(0, 16)}...`;

  return { headline, explainer, stats };
}

/** One-line summary of the whole run, for the header / console. */
export function narrateRunSummary(counts: {
  tasks: number;
  accepted: number;
  review: number;
  rejected: number;
  anchored: number;
}): string {
  return (
    `Run complete: ${counts.tasks} targets processed -> ` +
    `${counts.accepted} confirmed, ${counts.review} on watchlist, ${counts.rejected} rejected. ` +
    `${counts.anchored} finding bundle(s) anchored on Solana mainnet.`
  );
}
