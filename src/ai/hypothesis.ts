// Hypothesis layer for the LLM -> measurement CLOSED LOOP (research; discovery roadmap P61).
//
// WHY. The two wired models (DeepSeek statistical critic, Grok red-team) currently only write
// ADVISORY NARRATION about a result the deterministic pipeline already produced. This module turns
// them into genuine research inputs WITHOUT touching that guarantee: instead of asking "what do you
// think of this number", it asks each model to PROPOSE a falsifiable hypothesis and CHOOSE the single
// discriminating test most likely to refute it. The rig then RUNS that test deterministically on real
// photometry and records whether the data SUPPORTS or REFUTES the model's prediction. An LLM "idea"
// only becomes a research result once a deterministic measurement agrees with it -- and even then it is
// logged as a candidate clue, never a discovery claim.
//
// SAFETY / INTEGRITY red lines:
//  - A model may ONLY pick from the fixed TEST_MENU below (ids), never name a function, a file, a
//    URL, or an arbitrary command. Anything off-menu is rejected at parse time.
//  - Model output is non-deterministic, so NOTHING here feeds the run pipeline, the bundle manifest,
//    the bundle hash, a verdict, or any money path. It is a research side-path (like the pNN scripts).
//  - The models are instructed never to invent numbers; they emit a claim + a choice, and the rig's own
//    deterministic executor produces every number.
//
// Pure and runtime-agnostic (no fetch, no process.env): the callers that hold keys / run the tests live
// in the script; this module is fully unit-testable offline.

/** What the model expects the chosen test to show IF the signal is a genuine planet transit. */
export type Prediction = "planet" | "blend" | "inconclusive";

export interface MenuTest {
  /** stable id the model must echo; the executor maps it to a deterministic detector. */
  id: string;
  label: string;
  /** the question the test answers, shown to the model so it can reason about which to pick. */
  question: string;
}

// The allowed discriminating tests -- all cheap single-light-curve checks the pipeline already owns, so
// the loop runs on one downloaded SPOC curve per target (pixel/Gaia tests can be added as the menu grows).
export const TEST_MENU: MenuTest[] = [
  { id: "bls-snr", label: "Independent re-detection strength", question: "Does a fresh box-least-squares fold clear SNR >= 7 at (or near) the claimed period?" },
  { id: "odd-even-depth", label: "Odd vs even transit depth", question: "Do successive (odd vs even) transits have equal depths? A large mismatch points to an eclipsing binary, not a planet." },
  { id: "secondary-eclipse", label: "Secondary-eclipse depth", question: "Is there a comparable dip half a period after the primary? A strong secondary eclipse points to a stellar companion." },
  { id: "shape-coherence", label: "Folded shape coherence", question: "Is the folded dip a coherent, repeated box, or a single-point spike masquerading as a transit?" },
  { id: "psf-localize", label: "PSF double-difference localization", question: "Does the transit light, imaged off the target, come from an off-axis blended source rather than the host star? (needs target-pixel data)" },
  { id: "gaia-dilution", label: "Gaia aperture dilution", question: "How much of the light in the photometric aperture is a resolved contaminant rather than the host? (needs Gaia neighbours)" },
  { id: "multisector-phase", label: "Multi-sector phase consistency", question: "Does the transit recur at the SAME ephemeris, as a planet-plausible dip, in two or more INDEPENDENT sectors? (needs per-sector curves)" },
  { id: "common-mode-residual", label: "Common-mode residual survival", question: "After removing the ensemble-common instrumental signal, does the dip survive (source-localized) or vanish (a shared artifact)? (needs an ensemble correction)" },
  { id: "dilution-prior", label: "Blended-EB false-positive prior", question: "What is the measured-Gaia analytic probability that this depth is a diluted blended eclipsing binary rather than a planet? (needs a blend prior)" },
];

const MENU_IDS = new Set(TEST_MENU.map((t) => t.id));

export interface HypothesisProposal {
  ok: true;
  /** the menu id the model chose to run. */
  test: string;
  /** what the model predicts that deterministic test will show for a true planet. */
  prediction: Prediction;
  hypothesis: string;
  rationale: string;
}

export interface ProposalFailure {
  ok: false;
  reason: string;
}

export type ParsedProposal = HypothesisProposal | ProposalFailure;

/** Extract the first balanced {...} JSON object from a possibly-fenced / prose-wrapped reply. */
function firstJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fenced ? fenced[1] : raw;
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const clip = (x: unknown, max: number): string =>
  typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * Parse + VALIDATE one model reply into a proposal. Strict: the reply must be (or contain) a JSON
 * object whose `test` is a menu id and whose `prediction` is one of the allowed enum values; anything
 * else fails closed (returns {ok:false}) so a misbehaving or prompt-injected model can only ever pick a
 * whitelisted test or be ignored -- it can never trigger arbitrary work.
 */
export function parseProposal(raw: string): ParsedProposal {
  if (!raw || !raw.trim()) return { ok: false, reason: "empty reply" };
  const blob = firstJsonObject(raw);
  if (!blob) return { ok: false, reason: "no JSON object found in reply" };
  let obj: unknown;
  try {
    obj = JSON.parse(blob);
  } catch {
    return { ok: false, reason: "JSON parse failed" };
  }
  if (!obj || typeof obj !== "object") return { ok: false, reason: "reply JSON is not an object" };
  const o = obj as Record<string, unknown>;
  const test = typeof o.test === "string" ? o.test.trim().toLowerCase() : "";
  if (!MENU_IDS.has(test)) return { ok: false, reason: `test '${clip(o.test, 40) || "(none)"}' is not in the menu` };
  const predRaw = typeof o.prediction === "string" ? o.prediction.trim().toLowerCase() : "";
  const prediction: Prediction = predRaw === "planet" || predRaw === "blend" || predRaw === "inconclusive" ? (predRaw as Prediction) : "inconclusive";
  const hypothesis = clip(o.hypothesis, 240);
  const rationale = clip(o.rationale, 240);
  if (!hypothesis) return { ok: false, reason: "missing hypothesis text" };
  return { ok: true, test, prediction, hypothesis, rationale };
}

/** Build the system prompt: JSON-only, menu-constrained, never invent numbers. */
export function hypothesisSystemPrompt(): string {
  const menu = TEST_MENU.map((t) => `- ${t.id}: ${t.label} -- ${t.question}`).join("\n");
  return (
    "You are the hypothesis generator for an autonomous exoplanet vetting rig. " +
    "Propose ONE falsifiable claim that, if the signal is actually a false positive (a blend, an " +
    "eclipsing binary, a spike or an ephemeris alias), a specific test would expose. Then pick the " +
    "SINGLE test below most likely to FALSIFY your claim if you are wrong.\n\n" +
    "Tests (choose one id EXACTLY as written):\n" + menu + "\n\n" +
    "Reply with ONLY a JSON object, no prose, of the form:\n" +
    '{"hypothesis":"<one sentence claim>","test":"<menu id>","prediction":"planet|blend|inconclusive","rationale":"<one sentence: what result would falsify you>"}\n' +
    '"prediction" is what you expect the chosen test to show for a GENUINE planet. Never invent a number that was not given.'
  );
}

/** Build the user prompt from a data-grounded candidate summary (all numbers come from the pipeline). */
export function hypothesisUserPrompt(summary: string): string {
  return `Candidate: ${summary}\nPropose your falsifiable hypothesis and choose the decisive test. Reply JSON only.`;
}
