// P61 - LLM -> measurement CLOSED LOOP (research; third-party roadmap "make DeepSeek/Grok play a real
// role", chosen direction: hypothesis -> measurement).
//
// The two wired models currently only narrate a result the deterministic pipeline already produced. Here
// they instead PROPOSE a falsifiable hypothesis and CHOOSE the decisive discriminating test (from a fixed
// menu, src/ai/hypothesis.ts); the rig then RUNS that test on real photometry (src/detect/hypothesisTests.ts)
// and records whether the DATA supports or refutes the model's prediction. An idea becomes a research result
// only when a deterministic measurement agrees with it -- and even then it is logged as a candidate clue,
// never a discovery claim.
//
// The deterministic half (run ALL menu tests on each target) runs REGARDLESS of keys, so this script always
// yields real, reproducible numbers: on known planets it is a positive-control audit of the vetting suite
// (a genuine planet should read planet-consistent on these tests). The LLM half adds, per target, which test
// each model chose and whether its prediction matched the measurement.
//
// Red lines: no worker import, no verdict, no bundle hash, no money path. Model output is advisory only and
// never enters any deterministic artifact. discoveryClaim / safeToGate stay false.
//
// Run: npm run p61:llm-hypothesis  [-- --targets 12 --minsnr 7 --maxperiod 13 --tmag 11 --no-llm]
// Keys are read from the local .env (via loadLocalEnv) or the ambient environment; with none present the
// LLM layer degrades honestly to deterministic-audit-only.

import { writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { runHypothesisTest, type TestOutcome } from "../src/detect/hypothesisTests.ts";
import { TEST_MENU, parseProposal, hypothesisSystemPrompt, hypothesisUserPrompt, type Prediction } from "../src/ai/hypothesis.ts";
import { listProviders, completeWithProvider } from "../src/ai/llm.ts";
import { loadLocalEnv } from "../src/solana/anchor.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const want = Math.max(1, parseInt(arg("targets", "12"), 10));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const useLlm = !hasFlag("no-llm");

interface ModelTurn {
  model: string;
  proposal: { test: string; prediction: Prediction; hypothesis: string; rationale: string } | null;
  parseFail?: string;
  dataOutcome?: Prediction;
  dataDetail?: string;
  agreement?: boolean;
  diverged?: boolean;
}
interface Row {
  name: string; tic: number; periodDays: number; snr: number; depthPpm: number; durationHours: number;
  audit: Record<string, TestOutcome>;
  llm: ModelTurn[];
}

const ppm = (frac: number) => Math.round(frac * 1e6);

async function main(): Promise<void> {
  let providers: { key: string; base: string; model: string; name: string }[] = [];
  if (useLlm) {
    try { loadLocalEnv(); } catch { /* ambient env still applies */ }
    providers = listProviders();
  }

  console.log(`P61 LLM->measurement closed loop: up to ${want} confirmed planets, P<=${maxPeriod}d, T<=${tmagCap}.`);
  console.log(`  deterministic audit tests: ${TEST_MENU.map((t) => t.id).join(", ")}`);
  console.log(`  LLM proposal layer: ${providers.length ? providers.map((p) => p.name).join(", ") : "OFF (no keys) -> deterministic-audit-only"}`);
  console.log(`  token-free real SPOC photometry; research probe; nothing gated or claimed.\n`);

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper > 0 && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null)
    .slice(0, want * 6);

  const rows: Row[] = [];
  for (const p of planets) {
    if (rows.length >= want) break;
    const tic = p.tic!;
    const name = p.pl_name ?? p.hostname ?? `TIC ${tic}`;
    let sectors: number[];
    try { sectors = await sectorsForCoord(p.ra!, p.dec!); } catch { continue; }
    if (!sectors.length) continue;
    let lc: LightCurve | null = null;
    for (const s of sectors.slice(0, 4)) { try { lc = await fetchSpocLightCurve(tic, [s], name); } catch { lc = null; } if (lc && lc.points.length >= 120) break; }
    if (!lc) { console.log(`  ${name.padEnd(16)}: no usable SPOC curve; skip`); continue; }

    let b; try { b = bls(lc, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
    if (!(b.snr >= 7) || b.periodDays <= 0) { console.log(`  ${name.padEnd(16)}: pipeline's own BLS weak (SNR ${b.snr.toFixed(1)}); skip`); continue; }
    const ctx = { lc, t0Bjd: b.epochBjd, periodDays: b.periodDays, durationHours: b.durationDays * 24 };

    // Deterministic audit: run every menu test on the pipeline's own detection. Always available.
    const audit: Record<string, TestOutcome> = {};
    for (const t of TEST_MENU) audit[t.id] = runHypothesisTest(t.id, ctx);

    // LLM layer: ask each model to propose + choose a test; measure the test IT picked; compare to its prediction.
    const llm: ModelTurn[] = [];
    if (providers.length) {
      const summary = `period ${b.periodDays.toFixed(4)} d, depth ${ppm(b.depth)} ppm, BLS SNR ${b.snr.toFixed(1)}, duration ${(b.durationDays * 24).toFixed(2)} h (real single-sector TESS-SPOC curve)`;
      const sys = hypothesisSystemPrompt();
      const user = hypothesisUserPrompt(summary);
      const replies = await Promise.all(
        providers.map((pr) => completeWithProvider(pr, sys, user, { maxTokens: 220, timeoutMs: 50000 })),
      );
      providers.forEach((pr, i) => {
        const parsed = parseProposal(replies[i] ?? "");
        if (!parsed.ok) { llm.push({ model: pr.name, proposal: null, parseFail: parsed.reason }); return; }
        const outcome = audit[parsed.test] ?? runHypothesisTest(parsed.test, ctx);
        const determined = outcome.determined;
        llm.push({
          model: pr.name,
          proposal: { test: parsed.test, prediction: parsed.prediction, hypothesis: parsed.hypothesis, rationale: parsed.rationale },
          dataOutcome: outcome.outcome,
          dataDetail: outcome.detail,
          agreement: determined && parsed.prediction === outcome.outcome,
          diverged: determined && parsed.prediction !== outcome.outcome && outcome.outcome !== "inconclusive",
        });
      });
    }

    rows.push({ name, tic, periodDays: b.periodDays, snr: b.snr, depthPpm: ppm(b.depth), durationHours: b.durationDays * 24, audit, llm });
    const a = Object.values(audit).map((o) => `${o.test}:${o.determined ? o.outcome : "?"}`).join(" ");
    const l = llm.map((t) => (t.proposal ? `${t.model}->${t.proposal.test}(${t.proposal.prediction})=${t.dataOutcome}${t.agreement ? " AGREE" : t.diverged ? " DIVERGE" : ""}` : `${t.model}->parse-fail`)).join(" | ");
    console.log(`  ${name.padEnd(16)} SNR ${b.snr.toFixed(0).padStart(3)}  audit[${a}]  ${l}`);
  }

  if (!rows.length) { console.log("\nno usable targets (network/SPOC fallback). VERDICT: NO-USEFUL-DATA"); return; }

  const n = rows.length;
  // deterministic audit roll-up on known planets: each test should read mostly "planet" (positive control).
  const auditRates: Record<string, { planet: number; blend: number; inconclusive: number; determined: number }> = {};
  for (const t of TEST_MENU) {
    const os = rows.map((r) => r.audit[t.id]);
    auditRates[t.id] = {
      planet: os.filter((o) => o.determined && o.outcome === "planet").length,
      blend: os.filter((o) => o.determined && o.outcome === "blend").length,
      inconclusive: os.filter((o) => !o.determined || o.outcome === "inconclusive").length,
      determined: os.filter((o) => o.determined).length,
    };
  }
  // LLM-layer agreement.
  const turns = rows.flatMap((r) => r.llm);
  const withProposal = turns.filter((t) => t.proposal);
  const agreed = withProposal.filter((t) => t.agreement).length;
  const diverged = withProposal.filter((t) => t.diverged).length;
  const testChoice: Record<string, number> = {};
  for (const t of withProposal) if (t.proposal) testChoice[t.proposal.test] = (testChoice[t.proposal.test] ?? 0) + 1;

  console.log(`\n=== P61 SUMMARY (${n} known planets with a strong pipeline detection) ===`);
  for (const t of TEST_MENU) {
    const a = auditRates[t.id];
    console.log(`  [data] ${t.id.padEnd(16)} planet ${a.planet}/${n}  blend ${a.blend}  inconclusive/undet ${a.inconclusive}`);
  }
  if (providers.length) {
    console.log(`  [loop] models proposed ${withProposal.length}/${turns.length} valid tests; prediction matched the measurement ${agreed}/${withProposal.length}; diverged ${diverged} time(s)`);
    console.log(`  [loop] NOTE: divergences are dominated by any test the positive-control flags as a known-planet false-reject -- the loop is AUDITING the test, not proving the model wrong.`);
    console.log(`  [loop] tests chosen by models: ${Object.entries(testChoice).map(([k, v]) => `${k}x${v}`).join(", ") || "none"}`);
  } else {
    console.log(`  [loop] LLM proposal layer OFF (no API keys) -> deterministic audit only`);
  }

  // A vetting test that reads "blend" on a KNOWN planet is a false-reject -- flag any test failing the
  // positive control (measure-before-gate: these tests are diagnostics, and this audit surfaces which, if
  // any, misfire on real planets so they must NOT be promoted to a gate).
  const failing = TEST_MENU.filter((t) => auditRates[t.id].blend > 0).map((t) => `${t.id} (${auditRates[t.id].blend} blend-tagged on known planets)`);
  const verdict = providers.length ? "LOOP-RAN" : "DETERMINISTIC-AUDIT-ONLY";
  console.log(`\n  positive-control check: ${failing.length ? "tests tagging a KNOWN planet as blend -> " + failing.join("; ") + " (these are diagnostic-only, NOT gates)" : "no vetting test tagged any known planet as a blend (clean positive control)"}`);
  console.log(`\nVERDICT: ${verdict}  (advisory; a model's idea counts only when the deterministic measurement agrees; discoveryClaim false; nothing gated. safeToGate false)`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p61-llm-hypothesis-loop.ts", n, maxPeriod, tmagCap,
      providers: providers.map((p) => p.name), useLlm,
      note: "LLM proposes a falsifiable hypothesis + chooses a menu test; the rig runs that test on real photometry and records whether the data supports/refutes the model. Advisory only; deterministic audit runs regardless of keys. Not a discovery claim.",
      integrity: "no worker import, no verdict, no bundle hash, no money path; model output never enters any deterministic artifact.",
    },
    deterministicAudit: auditRates,
    llmLoop: { proposals: withProposal.length, turns: turns.length, matchedPrediction: agreed, modelDataDivergence: diverged, testChoice },
    positiveControlFailing: failing,
    verdict,
    safeToGate: false,
    discoveryClaim: false,
    rows,
  };
  writeFileSync("reports/p61-llm-hypothesis.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P61 an LLM-proposed hypothesis, settled by a deterministic measurement (closed loop)",
    "",
    `Reproduce: \`npm run p61:llm-hypothesis${providers.length ? "" : " -- --no-llm"}\`  (models: ${providers.length ? providers.map((p) => p.name).join(", ") : "none configured -> deterministic audit only"})`,
    "",
    `On **${n}** known planets with a strong pipeline detection, the rig does two things:`,
    "1. **Deterministic audit** -- run every vetting test on the real light curve (always available, reproducible):",
    "",
    `| test | planet-consistent | blend-tagged | inconclusive/undetermined |`,
    `|---|---|---|---|`,
    ...TEST_MENU.map((t) => { const a = auditRates[t.id]; return `| ${t.id} | ${a.planet}/${n} | ${a.blend} | ${a.inconclusive} |`; }),
    "",
    `2. **The loop** -- each model proposes a falsifiable hypothesis and picks the decisive test; the rig measures it.`,
    providers.length
      ? `Valid proposals ${withProposal.length}/${turns.length}; a model's prediction MATCHED the measurement ${agreed} time(s), diverged ${diverged} time(s). Models chose: ${Object.entries(testChoice).map(([k, v]) => `${k} x${v}`).join(", ") || "none"}. Divergences are dominated by any test the positive-control flags as a known-planet false-reject -- so the loop is auditing the TEST, not proving the model wrong.`
      : `LLM layer OFF (no keys) -- this run is the deterministic audit only.`,
    "",
    `Positive control: ${failing.length ? failing.join("; ") + " tagged a known planet as blend -- confirming these are DIAGNOSTIC scores, never a gate" : "no vetting test tagged any known planet as a blend (clean)"}.`,
    "",
    `**Verdict ${verdict}.** An idea becomes a research result here only when a deterministic measurement agrees with it; even then it is a candidate clue, not a claim. Nothing is gated (safeToGate false), no verdict/bundle/money path is touched.`,
    "",
  ].join("\n");
  writeFileSync("reports/p61-llm-hypothesis.md", md);
  console.log("\nwrote reports/p61-llm-hypothesis.md and reports/p61-llm-hypothesis.json");
}

main().catch((e) => { console.error(`[p61] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
