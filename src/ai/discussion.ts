// Data-grounded multi-seat discussion -- LLM-aware wrapper.
//
// The pure, runtime-agnostic grounded builders (buildGroundedDiscussion / threadsFor and
// the turn/thread types) live in ./threads.ts so the Cloudflare Worker can reuse them
// without importing the process.env-based llm.ts. This module re-exports them (so existing
// importers keep their paths) and adds buildDiscussion, which layers ONE genuine model
// critic caveat on top of the grounded turns when a chat key is configured. With no key it
// returns the grounded turns unchanged -- honest and always populated.

import type { Finding } from "../core/types.ts";
import { complete, llmConfigured, type LlmCred } from "./llm.ts";
import { buildGroundedDiscussion, type DiscussionTurn } from "./threads.ts";

export type { DiscussionTone, DiscussionTurn, DiscussionThread } from "./threads.ts";
export { buildGroundedDiscussion, threadsFor } from "./threads.ts";

const ppm = (frac: number) => Math.round(frac * 1e6);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Grounded thread, upgraded with one genuine model-written critic caveat when a chat
 *  key is present. Falls back to the grounded turns alone otherwise. Callers that hold
 *  runtime bindings (the Worker) pass them via cred; Node relies on process.env. */
export async function buildDiscussion(f: Finding, cred?: LlmCred): Promise<DiscussionTurn[]> {
  const turns = buildGroundedDiscussion(f);
  if (!llmConfigured(cred)) return turns;
  const c = f.candidate;
  const system = "You are the Mission Critic on an autonomous exoplanet analysis team. Be concise, quantitative and skeptical. Never invent a number that was not given.";
  const user =
    `Signal: period ${c.periodDays.toFixed(3)} d, depth ${ppm(c.depthFrac)} ppm, SNR ${c.snr.toFixed(1)}, ` +
    `duration ${c.durationHours.toFixed(2)} h, recovery confidence ${f.recoveryConfidence != null ? pct(f.recoveryConfidence) : "unknown"}, ` +
    `cross-match ${f.crossmatch.matchedKnownPlanet ? f.crossmatch.knownPlanetName : "none"}, verdict ${f.verdict}. ` +
    `In one short sentence, state the single most important caveat a non-expert should know.`;
  const extra = await complete(system, user, { maxTokens: 120 }, cred);
  if (extra) turns.splice(turns.length - 1, 0, { seat: "mission-critic", ts: f.createdAt, tone: "challenge", text: extra });
  return turns;
}
