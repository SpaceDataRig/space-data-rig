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

/** Trader-facing label + color for a verdict (used by the findings board). */
export function verdictBadge(verdict: Finding["verdict"]): { label: string; tone: "good" | "warn" | "bad" } {
  switch (verdict) {
    case "accepted":
      return { label: "CONFIRMED", tone: "good" };
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
export function narrateFinding(f: Finding): { headline: string; explainer: string; stats: Record<string, string> } {
  const c = f.candidate;
  const badge = verdictBadge(f.verdict);
  const depthPpm = Math.round(c.depthFrac * 1e6);
  const planetYear = c.periodDays;

  let headline: string;
  if (f.verdict === "accepted") {
    headline = f.crossmatch.matchedKnownPlanet
      ? `Confirmed: a planet orbiting every ${planetYear.toFixed(2)} days, matching ${f.crossmatch.knownPlanetName}.`
      : `Confirmed: a planet-like signal with a ${planetYear.toFixed(2)}-day orbit (possible new candidate).`;
  } else if (f.verdict === "needs-more-data") {
    headline = `Promising but unproven: a possible ${planetYear.toFixed(2)}-day signal that needs more data.`;
  } else {
    headline = `Rejected: the ${planetYear.toFixed(2)}-day signal did not pass scrutiny.`;
  }

  const confPct = f.recoveryConfidence != null ? Math.round(f.recoveryConfidence * 100) : null;

  const explainer =
    `The star's brightness dips by about ${depthPpm} parts per million once every ${planetYear.toFixed(2)} days -- ` +
    `that repeating dip is the fingerprint of a planet crossing (transiting) the star. ` +
    `The signal is ${explainSnr(c.snr)}. ` +
    (confPct != null
      ? `When we replayed this exact signal through fresh simulated noise, the pipeline recovered it ${confPct}% of the time, ` +
        `which is our honest measure of how trustworthy it is. `
      : "") +
    `Mission Critic verdict: ${badge.label} -- ${f.verdictReason}`;

  const stats: Record<string, string> = {
    Target: f.targetId,
    "Planet year (period)": `${planetYear.toFixed(4)} days`,
    "Transit depth": `${depthPpm} ppm (${(c.depthFrac * 100).toFixed(3)}%)`,
    "Transit duration": `${c.durationHours.toFixed(2)} hours`,
    "Signal strength (SNR)": c.snr.toFixed(1),
    "Recovery confidence": confPct != null ? `${confPct}%` : "n/a",
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
