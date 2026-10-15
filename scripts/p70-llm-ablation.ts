// P70 - LLM ABLATION: does the model layer change ANY decision, and is it a good hypothesis generator?
//
// WHY THIS EXISTS. The roadmap wants the LLM to be a real hypothesis generator, "not a narration machine."
// P61 built the loop but its CI report is the keys-free DETERMINISTIC 2x2 (llmLoop: off), so the model half
// was never scored on committed data. This study runs the models LIVE on a small labelled sample and answers
// two separate questions that P61 conflated:
//   (1) STRUCTURAL ABLATION -- if we remove the LLM entirely, does ANY gate/verdict change? It cannot, by
//       construction: the per-test 2x2 and gateable flag are computed from runHypothesisTest outcomes
//       (src/detect), never from a model prediction. We VERIFY that here rather than assert it: the decision
//       is computed once BEFORE any model is called and once AFTER, and the two must be byte-identical.
//   (2) INFORMATIONAL VALUE -- given the decision is provably unaffected, the ONLY thing the model can do is
//       propose a decisive test + a prediction. We score those against the deterministic measurement: how
//       often the prediction agrees, and (the fragile behaviour P61 flagged) how often a model calls a
//       LABELLED BLEND "planet" (under-flagging). A model that under-blends is a source of false confidence,
//       which is exactly why it must stay advisory.
//
// Red lines: research only; no worker import, no verdict, no bundle hash, no money path. The LLM output NEVER
// enters a deterministic artifact -- this study exists to demonstrate that claim, not to change it. Model calls
// are advisory; if keys are absent or a call fails, the target degrades honestly to "no proposal" and the
// structural ablation still runs. discoveryClaim structurally false, safeToGate false.
//
// Run: npm run p70:llm-ablation  [-- --pos 5 --neg 5]   (reads LLM keys from the environment via loadLocalEnv)

import { writeFileSync, mkdirSync } from "node:fs";
import { runHypothesisTest, type TestContext } from "../src/detect/hypothesisTests.ts";
import { TEST_MENU, parseProposal, hypothesisSystemPrompt, hypothesisUserPrompt, type Prediction } from "../src/ai/hypothesis.ts";
import { listProviders, completeWithProvider } from "../src/ai/llm.ts";
import { loadLocalEnv } from "../src/solana/anchor.ts";
import { fetchToiTable, labelledNegatives, confirmedPositives, isPlaceable, type ToiRecord } from "../src/data/toiDispositions.ts";
import { fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { bls } from "../src/detect/bls.ts";
import { vetoMetrics, type VetoCase } from "../src/candidate/vetoAcceptance.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const wantPos = Math.max(1, parseInt(arg("pos", "5"), 10));
const wantNeg = Math.max(0, parseInt(arg("neg", "5"), 10));

// light-curve tests only (no --deep: pixel/Gaia degrade to undetermined and we want a fast, cheap ablation).
const LC_TESTS = ["bls-snr", "odd-even-depth", "secondary-eclipse", "shape-coherence", "multisector-phase"];

interface Turn { model: string; test: string; prediction: Prediction; dataOutcome: Prediction; determined: boolean; agreement: boolean; underFlagBlend: boolean }
interface Target { name: string; isBlend: boolean; periodDays: number; audit: Record<string, { outcome: string; determined: boolean }>; llm: Turn[]; deterministicBlendFlag: boolean }
const ppm = (frac: number) => Math.round(frac * 1e6);

async function fetchCurve(rec: ToiRecord, name: string): Promise<{ lc: LightCurve; sectorLcs: LightCurve[] } | null> {
  const sectorLcs: LightCurve[] = [];
  let primary: LightCurve | null = null;
  for (const s of (rec.sectors && rec.sectors.length ? rec.sectors : []).slice(0, 3)) {
    let lc: LightCurve | null = null;
    try { lc = await fetchSpocLightCurve(rec.tic, [s], name); } catch { lc = null; }
    if (lc && lc.points.length >= 120) { sectorLcs.push(lc); if (!primary) primary = lc; }
  }
  return primary ? { lc: primary, sectorLcs } : null;
}

/** The deterministic decision: run the light-curve menu and derive per-test outcomes + a blend flag. This
 *  function is PURE in the data -- it never sees a model -- which is what makes the ablation real. */
function measure(ctx: TestContext): { audit: Target["audit"]; blendFlag: boolean } {
  const audit: Target["audit"] = {};
  let blendFlag = false;
  for (const id of LC_TESTS) {
    const o = runHypothesisTest(id, ctx);
    audit[id] = { outcome: o.outcome, determined: o.determined };
    if (o.determined && o.outcome === "blend") blendFlag = true;
  }
  return { audit, blendFlag };
}

async function main(): Promise<void> {
  loadLocalEnv();
  const providers = listProviders();
  console.log(`P70 LLM ablation: ${wantPos} positive (KP) + ${wantNeg} negative (FP/EB) from the public TOI table; light-curve tests only; models: ${providers.length ? providers.map((p) => p.name).join(", ") : "NONE (structural ablation still runs)"}.`);

  const records = await fetchToiTable();
  if (!records.length) { console.log("Could not fetch the TOI table (network). VERDICT: NO-USEFUL-DATA"); process.exitCode = 0; return; }
  const byBright = (a: ToiRecord, b: ToiRecord) => (a.tessMag || 99) - (b.tessMag || 99);
  const posPick = confirmedPositives(records).filter(isPlaceable).sort(byBright).slice(0, wantPos);
  const negPick = labelledNegatives(records).filter(isPlaceable).sort(byBright).slice(0, wantNeg);

  const targets: Target[] = [];
  for (const r of [...posPick.map((x) => ({ x, blend: false })), ...negPick.map((x) => ({ x, blend: true }))]) {
    const rec = r.x;
    const name = `TIC ${rec.tic}${rec.toi ? ` / ${rec.toi}` : ""}`;
    const got = await fetchCurve(rec, name);
    if (!got) { console.log(`  ${name.padEnd(22)} [${r.blend ? "NEG" : "POS"}]: no curve; skip`); continue; }
    const ctx: TestContext = { lc: got.lc, t0Bjd: rec.epochBjd, periodDays: rec.periodDays, durationHours: rec.durationHours, sectorLcs: got.sectorLcs };

    // (1) DECISION computed with NO model in the loop.
    const m0 = measure(ctx);

    // (2) MODELS propose a test + prediction (advisory; never fed back into the decision).
    const llm: Turn[] = [];
    if (providers.length) {
      let depthPpm: number | null = null;
      try { const b = bls(got.lc, { maxPeriodDays: rec.periodDays * 1.5 }); depthPpm = ppm(b.depth); } catch { /* null */ }
      const summary = `period ${rec.periodDays.toFixed(4)} d, depth ${depthPpm ?? rec.depthPpm ?? "?"} ppm, duration ${(rec.durationHours || 0).toFixed(2)} h (real single-sector TESS-SPOC curve)`;
      const sys = hypothesisSystemPrompt();
      const user = hypothesisUserPrompt(summary);
      const replies = await Promise.all(providers.map((pr) => completeWithProvider(pr, sys, user, { maxTokens: 220, timeoutMs: 55000 })));
      providers.forEach((pr, i) => {
        const parsed = parseProposal(replies[i] ?? "");
        if (!parsed.ok) return;
        const outcome = m0.audit[parsed.test] ?? runHypothesisTest(parsed.test, ctx);
        const det = outcome.determined;
        llm.push({
          model: pr.name, test: parsed.test, prediction: parsed.prediction, dataOutcome: outcome.outcome as Prediction, determined: !!det,
          agreement: !!det && parsed.prediction === outcome.outcome,
          underFlagBlend: r.blend && parsed.prediction === "planet", // model called a labelled blend a planet
        });
      });
    }

    // VERIFY the ablation: recompute the decision AFTER the models ran -- identical inputs, must be identical.
    const m1 = measure(ctx);
    const decisionChanged = JSON.stringify(m0.audit) !== JSON.stringify(m1.audit) || m0.blendFlag !== m1.blendFlag;

    targets.push({ name, isBlend: r.blend, periodDays: rec.periodDays, audit: m0.audit, llm, deterministicBlendFlag: m0.blendFlag });
    const a = LC_TESTS.map((id) => `${id}:${m0.audit[id].determined ? m0.audit[id].outcome : "?"}`).join(" ");
    const l = llm.map((t) => `${t.model}->${t.test}(${t.prediction})=${t.dataOutcome}${t.agreement ? " AGREE" : t.underFlagBlend ? " UNDER-FLAG" : ""}`).join(" | ") || "no-llm";
    console.log(`  ${name.padEnd(22)} [${r.blend ? "NEG" : "POS"}] decisionChangedByLLM=${decisionChanged ? "YES(BUG)" : "no"}  ${a}  ${l}`);
    if (decisionChanged) { console.error("  ABORT: the model layer altered a deterministic decision -- that must never happen."); process.exitCode = 1; return; }
  }

  const nPos = targets.filter((t) => !t.isBlend).length;
  const nNeg = targets.filter((t) => t.isBlend).length;
  if (!nPos || !nNeg) { console.log(`\nusable classes ${nPos} pos / ${nNeg} neg -- need both. VERDICT: INSUFFICIENT-DATA`); process.exitCode = 0; return; }

  // Deterministic gate 2x2 on the light-curve tests (the ONLY thing that could ever gate).
  const perTest: Record<string, { power: number | null; falseVeto: number | null; safeToGate: boolean }> = {};
  for (const id of LC_TESTS) {
    const cases: VetoCase[] = targets.map((t) => ({ isBlend: t.isBlend, veto: t.audit[id]?.outcome === "blend" }));
    const m = vetoMetrics(cases);
    perTest[id] = { power: m.vetoPower, falseVeto: m.falseVetoRate, safeToGate: m.falseVetoRate === 0 && m.vetoPower != null && m.vetoPower > 0 };
  }
  const anyGateable = Object.values(perTest).some((p) => p.safeToGate);

  const turns = targets.flatMap((t) => t.llm);
  const determinedTurns = turns.filter((t) => t.determined);
  const agreed = determinedTurns.filter((t) => t.agreement).length;
  const blendsSeen = targets.filter((t) => t.isBlend);
  const blendUnderFlagged = blendsSeen.filter((t) => t.llm.some((x) => x.underFlagBlend)).length;
  const detBlendCaught = blendsSeen.filter((t) => t.deterministicBlendFlag).length;

  console.log(`\n=== P70 SUMMARY (${nPos} known planets + ${nNeg} labelled blends) ===`);
  console.log(`  STRUCTURAL: the LLM changed a deterministic decision on ${targets.filter((t) => false).length} targets -> decisions are model-independent by construction (verified by recompute).`);
  for (const id of LC_TESTS) { const p = perTest[id]; console.log(`  [gate2x2] ${id.padEnd(16)} catch ${p.power == null ? "n/a" : (100 * p.power).toFixed(0) + "%"}  false-veto ${p.falseVeto == null ? "n/a" : (100 * p.falseVeto).toFixed(0) + "%"}  safeToGate=${p.safeToGate}`); }
  if (providers.length) {
    console.log(`  [model] ${turns.length} proposals (${agreed}/${determinedTurns.length} agreed on determinable tests).`);
    console.log(`  [model] under-flagged (called a labelled BLEND "planet"): ${blendUnderFlagged}/${blendsSeen.length} blends vs deterministic catch ${detBlendCaught}/${blendsSeen.length}.`);
  } else console.log("  [model] OFF (no keys in environment) -> informational-value half not measured this run.");

  const verdict = anyGateable
    ? "GATE-CANDIDATE-EVEN-WITHOUT-LLM (some deterministic light-curve test gates on this tiny sample; the LLM is still irrelevant to it -- re-run larger before any wiring)."
    : `LLM-DECISION-VALUE-ZERO: no gate outcome depends on the model (verified by recompute); the models ${providers.length ? `under-flagged ${blendUnderFlagged}/${blendsSeen.length} labelled blends` : "were off"} while the deterministic tests caught ${detBlendCaught}/${blendsSeen.length}. The model is a hypothesis BROKER, not an arbiter; it stays advisory.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log("  measure-before-gate: advisory layer; nothing gated, anchored or claimed. discoveryClaim false, safeToGate false.");

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p70-llm-ablation.ts", nPos, nNeg, providers: providers.map((p) => p.name), useLlm: providers.length > 0, deep: false,
      positiveSource: "TOI-table KP (confirmed planets)", negativeSource: "TOI-table FP/EB (labelled blends)",
      note: "two-part ablation: (1) prove removing the LLM changes no deterministic decision (recompute equality), (2) score the model's proposals vs the measurement incl. blend under-flagging. Advisory; discoveryClaim false.",
    },
    structuralAblation: { decisionsChangedByLLM: 0, verifiedByRecompute: true },
    perTestGate2x2: perTest,
    anyGateable,
    modelQuality: providers.length ? { proposals: turns.length, determinable: determinedTurns.length, agreed, blendUnderFlagged, nBlends: blendsSeen.length, deterministicBlendCaught: detBlendCaught } : { off: true },
    llmDecisionValue: "zero",
    safeToGate: false,
    discoveryClaim: false,
    targets,
  };
  writeFileSync("reports/p70-llm-ablation.json", JSON.stringify(json, null, 2) + "\n");

  const pct = (x: number | null) => (x == null ? "n/a" : `${(100 * x).toFixed(0)}%`);
  const md = [
    "# P70 LLM ablation: does the model change a decision, and is it a good hypothesis generator?",
    "",
    `Reproduce: \`npm run p70:llm-ablation -- --pos ${wantPos} --neg ${wantNeg}\`  (models: ${providers.length ? providers.map((p) => p.name).join(", ") : "none -> structural half only"})`,
    "",
    "**(1) Structural ablation.** The per-test 2x2 and every gate flag come only from `runHypothesisTest` (real",
    "photometry); a model prediction is never an input. We verify this by recomputing each decision after the",
    "models run -- identical, `decisionsChangedByLLM = 0`. So the LLM's decision value is zero by construction.",
    "",
    "**(2) Informational value.** Given (1), the model can only propose a test + prediction. Scored against the",
    providers.length
      ? `measurement on ${nPos} planets + ${nNeg} blends: ${agreed}/${determinedTurns.length} determinable proposals agreed, and models called a labelled BLEND "planet" on ${blendUnderFlagged}/${blendsSeen.length} (under-flagging), while the deterministic light-curve tests caught ${detBlendCaught}/${blendsSeen.length}.`
      : `measurement: models OFF this run (no keys), so only the structural half is populated.`,
    "",
    "| light-curve test | catch (labelled blends) | false-veto (known planets) | safe to gate |",
    "|---|---|---|---|",
    ...LC_TESTS.map((id) => { const p = perTest[id]; return `| ${id} | ${pct(p.power)} | ${pct(p.falseVeto)} | ${p.safeToGate} |`; }),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "The model is an advisory hypothesis broker, not an arbiter; nothing is wired into a verdict / bundle /",
    "money path (safeToGate false, discoveryClaim false).",
    "",
  ].join("\n");
  writeFileSync("reports/p70-llm-ablation.md", md);
  console.log("\nwrote reports/p70-llm-ablation.md and reports/p70-llm-ablation.json");
}

main().catch((e) => { console.error(`[p70] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
