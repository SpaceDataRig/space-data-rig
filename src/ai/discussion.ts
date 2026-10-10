// Data-grounded multi-seat discussion -- LLM-aware wrapper.
//
// The pure, runtime-agnostic grounded builders (buildGroundedDiscussion / threadsFor and
// the turn/thread types) live in ./threads.ts so the Cloudflare Worker can reuse them
// without importing the process.env-based llm.ts. This module re-exports them (so existing
// importers keep their paths) and adds buildDiscussion, which layers genuine model-written
// critique on top of the grounded turns -- one per configured provider, each model given a
// DIFFERENT review lens (see LENSES). With no key it returns the grounded turns unchanged --
// honest and always populated.

import type { Finding } from "../core/types.ts";
import { completeWithProvider, listProviders, type LlmCred } from "./llm.ts";
import { buildGroundedDiscussion, type DiscussionTone, type DiscussionTurn } from "./threads.ts";

export type { DiscussionTone, DiscussionTurn, DiscussionThread } from "./threads.ts";
export { buildGroundedDiscussion, threadsFor } from "./threads.ts";

const ppm = (frac: number) => Math.round(frac * 1e6);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * A review lens: one mandate a model is asked to play, grounded on the same real numbers.
 * Different models get different lenses so the war room is genuinely multi-voiced rather
 * than N copies of one question. Every lens forbids inventing numbers and caps the length.
 */
interface Lens {
  /** short label surfaced on the turn so viewers see which job the model did. */
  role: string;
  tone: DiscussionTone;
  system: string;
  ask: string;
}

// Lens 1 -- quantitative skeptic: is the recovery itself trustworthy?
// Lens 2 -- adversarial red-team: strongest argument it is a false positive, and the one
// follow-up observation that would settle it. Complementary, not redundant.
const LENSES: Lens[] = [
  {
    role: "Statistical critic",
    tone: "challenge",
    system: "You are the Mission Critic on an autonomous exoplanet analysis team. Be concise, quantitative and skeptical. Never invent a number that was not given.",
    ask: "In one short sentence, state the single most important caveat a non-expert should know about how reliably this signal was recovered.",
  },
  {
    role: "Red-team reviewer",
    tone: "hedge",
    system: "You are the Red-Team Reviewer on an autonomous exoplanet analysis team. Your only job is to argue the signal could be a FALSE POSITIVE -- systematics, an ephemeris alias, stellar contamination, or injected-signal bias. Be concrete and skeptical. Never invent a number that was not given.",
    ask: "In one or two sentences: give the strongest argument this is NOT a genuine new transit, then name the single follow-up observation that would settle it.",
  },
];

/**
 * Pick a lens for a provider: match by model/base family when we recognise it (DeepSeek ->
 * statistical, Grok -> red-team), otherwise fall back to positional order so any set of
 * OpenAI-compatible models still gets distinct lenses. Pure function -- unit-testable.
 */
export function lensForProvider(p: { base: string; model: string }, index: number): Lens {
  const sig = `${p.model} ${p.base}`.toLowerCase();
  if (/grok|x\.ai/.test(sig)) return LENSES[1];
  if (/deepseek/.test(sig)) return LENSES[0];
  return LENSES[index % LENSES.length];
}

/**
 * Grounded thread, upgraded with one genuine model-written turn PER configured provider,
 * each model playing a different review lens and labeled with the model that produced it.
 * With no key (or all models failing) the grounded turns stand alone -- honest and always
 * populated. Callers that hold runtime bindings (the Worker) pass creds explicitly; Node
 * relies on process.env.
 */
export async function buildDiscussion(f: Finding, creds?: LlmCred | LlmCred[]): Promise<DiscussionTurn[]> {
  const turns = buildGroundedDiscussion(f);
  const providers = listProviders(creds);
  if (providers.length === 0) return turns;
  const c = f.candidate;
  const numbers =
    `Signal: period ${c.periodDays.toFixed(3)} d, depth ${ppm(c.depthFrac)} ppm, SNR ${c.snr.toFixed(1)}, ` +
    `duration ${c.durationHours.toFixed(2)} h, recovery confidence ${f.recoveryConfidence != null ? pct(f.recoveryConfidence) : "unknown"}, ` +
    `cross-match ${f.crossmatch.matchedKnownPlanet ? f.crossmatch.knownPlanetName : "none"}, verdict ${f.verdict}.`;
  // Ask every model at the same time so total latency is one call, not N; a provider that
  // returns null (unconfigured/failed) simply contributes no turn, so the thread stays honest.
  const reviews = await Promise.all(
    providers.map(async (p, i) => {
      const lens = lensForProvider(p, i);
      const text = await completeWithProvider(p, lens.system, `${numbers} ${lens.ask}`, { maxTokens: 120 });
      return { p, lens, text };
    }),
  );
  const extra: DiscussionTurn[] = reviews
    .filter((x) => x.text)
    .map((x) => ({ seat: "mission-critic", ts: f.createdAt, tone: x.lens.tone, text: `[${x.lens.role}] ${x.text as string}`, model: x.p.name }));
  turns.splice(turns.length - 1, 0, ...extra);
  return turns;
}
