// Data-grounded multi-seat discussion -- the pure, runtime-agnostic half.
//
// Produces a threaded conversation between the five seats using ONLY the real numbers the
// deterministic pipeline already computed for a finding (period, depth, SNR, duration,
// recovery confidence, cross-match, verdict). It imports no LLM layer and touches no
// runtime-specific globals, so the SAME builder runs on Node and on the Cloudflare Worker.
// When a chat key is present, both runtimes enrich these turns with one model-written
// caveat via discussion.ts -> buildDiscussion() (nodejs_compat supplies process.env on the
// edge); with no key -- or a failing model -- the grounded turns stand alone, honest and
// always populated.

import type { Finding, SeatName } from "../core/types.ts";

export type DiscussionTone = "brief" | "speak" | "hedge" | "challenge" | "verdict" | "summary";

export interface DiscussionTurn {
  seat: SeatName;
  ts: string;
  tone: DiscussionTone;
  text: string;
}

export interface DiscussionThread {
  findingId: string;
  targetId: string;
  verdict: Finding["verdict"];
  turns: DiscussionTurn[];
}

const ppm = (frac: number) => Math.round(frac * 1e6);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const VERDICT_WORD: Record<Finding["verdict"], string> = {
  accepted: "ACCEPT",
  "needs-more-data": "WATCHLIST",
  rejected: "REJECT",
};

/** Grounded conversation composed from a finding's real fields. */
export function buildGroundedDiscussion(f: Finding): DiscussionTurn[] {
  const c = f.candidate;
  const ts = f.createdAt;
  const period = c.periodDays.toFixed(3);
  const depth = ppm(c.depthFrac);
  const snr = c.snr.toFixed(1);
  const dur = c.durationHours.toFixed(2);
  const conf = f.recoveryConfidence;
  const next = f.ephemeris?.nextTransitsBjd?.slice(0, 2).map((x) => x.toFixed(2)).join(", ") || "n/a";
  const cm = f.crossmatch;

  const turns: DiscussionTurn[] = [];
  turns.push({ seat: "data-fetch", ts, tone: "brief", text: `Loaded ${f.targetId} from real catalog parameters. The light curve is in memory and the source data hash is stamped.` });
  turns.push({ seat: "anomaly-scout", ts, tone: "speak", text: `I folded the series and there is a repeating dip every ${period} days -- depth ${depth} ppm, ${dur}h long, SNR ${snr}. That shape looks like a transit to me.` });
  if (conf != null && conf < 0.5) {
    turns.push({ seat: "sim-runner", ts, tone: "hedge", text: `Careful -- replaying this exact signal through fresh noise brought it back only ${pct(conf)} of the time. That is fragile. Next transits would land at BJD ${next}.` });
  } else {
    turns.push({ seat: "sim-runner", ts, tone: "speak", text: `I replayed it through simulated noise and recovered it ${conf != null ? pct(conf) : "n/a"} of the time -- that holds up. Next transits predicted at BJD ${next}.` });
  }
  turns.push({
    seat: "mission-critic",
    ts,
    tone: "challenge",
    text: cm.matchedKnownPlanet
      ? `Cross-check: this lines up with ${cm.knownPlanetName}, only ${cm.periodDeltaPct?.toFixed(2) ?? "?"}% off in period. That means it is very likely the known planet, not a fresh discovery.`
      : `Cross-check: no catalogued planet sits near ${period} days within tolerance, so this could be genuine -- but I will weigh SNR ${snr} and depth ${depth} ppm against the noise first.`,
  });
  turns.push({ seat: "mission-critic", ts, tone: "verdict", text: `My call: ${VERDICT_WORD[f.verdict]}. ${f.verdictReason}` });
  const bundle = f.bundleHash ? ` Bundle sealed and hash-verified: ${f.bundleHash.slice(0, 12)}...` : "";
  turns.push({ seat: "reporter", ts, tone: "summary", text: `${f.narration?.headline ?? f.verdictReason}${bundle}` });
  return turns;
}

/** Grounded threads for a set of findings (sync + cheap), used to seed the dashboard. */
export function threadsFor(findings: Finding[]): DiscussionThread[] {
  return findings.map((f) => ({
    findingId: f.id,
    targetId: f.targetId,
    verdict: f.verdict,
    turns: buildGroundedDiscussion(f),
  }));
}
