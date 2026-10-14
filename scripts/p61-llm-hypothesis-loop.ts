// P61 - LLM -> measurement CLOSED LOOP, at scale and against ground-truth classes (research; roadmap).
//
// Two upgrades over the v1 pilot:
//  (1) NEGATIVE CLASS: both classes now come from ONE token-free public source, the ExoFOP TOI table
//      (src/data/toiDispositions.ts) -- confirmed-planet rows (KP) are positives, FP/EB rows are labelled
//      blends. So for every menu test we can compute the REAL operating point: catch-rate on true blends
//      and false-veto rate on true planets, scored with src/candidate/vetoAcceptance (a full 2x2 + Wilson
//      CI + an acceptVetoTool safe/not-safe verdict). This is the measurement the earlier veto work (P57/58/59)
//      wanted, now driven through the LLM-chosen-test loop.
//  (2) DEEPER MENU: two pixel/Gaia tests (PSF double-difference localization, aperture dilution) are in
//      the menu; they activate under `--deep` (which fetches a target-pixel cube + a Gaia neighbourhood per
//      target). Without --deep they degrade honestly to undetermined, so the cheap light-curve 2x2 always runs.
//
// The loop: each model proposes a falsifiable hypothesis + picks the decisive test (fixed menu; off-menu
// rejected), the rig measures it on real photometry, and we record agreement/divergence AND, separately,
// each test's class-discriminating power. An idea becomes a result only when the measurement agrees; a TEST
// becomes gate-worthy only when its 2x2 shows zero false-vetoes AND real power -- both are reported as-is
// (the expected honest outcome is "not safe to gate", consistent with P53/P58/P59).
//
// Red lines: no worker import, no verdict, no bundle hash, no money path; model output is advisory.
// discoveryClaim and (aggregate) safeToGate stay false.
//
// Run: npm run p61:llm-hypothesis  [-- --pos 8 --neg 8 --deep --no-llm]

import { writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { runHypothesisTest, type TestContext, type TestOutcome } from "../src/detect/hypothesisTests.ts";
import { TEST_MENU, parseProposal, hypothesisSystemPrompt, hypothesisUserPrompt, type Prediction } from "../src/ai/hypothesis.ts";
import { listProviders, completeWithProvider } from "../src/ai/llm.ts";
import { loadLocalEnv } from "../src/solana/anchor.ts";
import { fetchToiTable, labelledNegatives, confirmedPositives, isPlaceable, type ToiRecord } from "../src/data/toiDispositions.ts";
import { fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { fetchGaiaNeighborhood, dilutionFromNeighbors, angularSepArcsec, type DilutionResult } from "../src/data/gaiaDilution.ts";
import { vetoMetrics, acceptVetoTool, type VetoCase } from "../src/candidate/vetoAcceptance.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const wantPos = Math.max(1, parseInt(arg("pos", "8"), 10));
const wantNeg = Math.max(0, parseInt(arg("neg", "8"), 10));
const deep = hasFlag("deep");
const useLlm = !hasFlag("no-llm");

interface ModelTurn {
  model: string; hypothesis: string; test: string; prediction: Prediction;
  dataOutcome: Prediction; agreement: boolean; diverged: boolean; detail: string;
}
interface Target {
  name: string; tic: number; isBlend: boolean; periodDays: number; depthPpm: number | null;
  audit: Record<string, TestOutcome>; llm: ModelTurn[];
}
const ppm = (frac: number) => Math.round(frac * 1e6);

async function fetchCurve(rec: ToiRecord, name: string): Promise<{ lc: LightCurve; sector: number } | null> {
  for (const s of (rec.sectors && rec.sectors.length ? rec.sectors : []).slice(0, 3)) {
    let lc: LightCurve | null = null;
    try { lc = await fetchSpocLightCurve(rec.tic, [s], name); } catch { lc = null; }
    if (lc && lc.points.length >= 120) return { lc, sector: s };
  }
  return null;
}

async function dilutionFor(ra: number, dec: number): Promise<DilutionResult | null> {
  try {
    const neigh = await fetchGaiaNeighborhood(ra, dec, { radiusDeg: 21 / 3600 });
    if (!neigh.length) return null;
    let host = neigh[0]; let best = Infinity;
    for (const s of neigh) { const d = angularSepArcsec(ra, dec, s.ra, s.dec); if (d < best) { best = d; host = s; } }
    const others = neigh.filter((s) => angularSepArcsec(ra, dec, s.ra, s.dec) > 0.5);
    return dilutionFromNeighbors(host.gmag, ra, dec, others, 21);
  } catch { return null; }
}

async function processOne(rec: ToiRecord, isBlend: boolean, providers: { key: string; base: string; model: string; name: string }[]): Promise<Target | null> {
  const name = `TIC ${rec.tic}${rec.toi ? ` / ${rec.toi}` : ""}`;
  const got = await fetchCurve(rec, name);
  if (!got) { console.log(`  ${name.padEnd(22)} [${isBlend ? "NEG" : "POS"}]: no SPOC curve; skip`); return null; }
  const lc = got.lc;

  const ctx: TestContext = { lc, t0Bjd: rec.epochBjd, periodDays: rec.periodDays, durationHours: rec.durationHours };
  // peak depth for reporting only (the pipeline's own fold), not used to gate.
  let depthPpm: number | null = null;
  try { const b = bls(lc, { maxPeriodDays: rec.periodDays * 1.5 }); depthPpm = ppm(b.depth); } catch { /* leave null */ }

  if (deep) {
    try { ctx.cube = await fetchSpocTargetPixels(rec.tic, got.sector, name) as unknown as TestContext["cube"]; } catch { /* leave undefined */ }
    ctx.dilution = (await dilutionFor(rec.ra, rec.dec)) ?? undefined;
  }

  const audit: Record<string, TestOutcome> = {};
  for (const t of TEST_MENU) audit[t.id] = runHypothesisTest(t.id, ctx);

  const llm: ModelTurn[] = [];
  if (providers.length) {
    const summary = `period ${rec.periodDays.toFixed(4)} d, depth ${depthPpm ?? rec.depthPpm ?? "?"} ppm, duration ${(rec.durationHours || 0).toFixed(2)} h (real single-sector TESS-SPOC curve)`;
    const sys = hypothesisSystemPrompt();
    const user = hypothesisUserPrompt(summary);
    const replies = await Promise.all(providers.map((pr) => completeWithProvider(pr, sys, user, { maxTokens: 220, timeoutMs: 55000 })));
    providers.forEach((pr, i) => {
      const parsed = parseProposal(replies[i] ?? "");
      if (!parsed.ok) return;
      const outcome = audit[parsed.test] ?? runHypothesisTest(parsed.test, ctx);
      const det = outcome.determined;
      llm.push({
        model: pr.name, hypothesis: parsed.hypothesis, test: parsed.test, prediction: parsed.prediction,
        dataOutcome: outcome.outcome, agreement: det && parsed.prediction === outcome.outcome,
        diverged: det && parsed.prediction !== outcome.outcome && outcome.outcome !== "inconclusive", detail: outcome.detail,
      });
    });
  }
  const a = Object.values(audit).map((o) => `${o.test}:${o.determined ? o.outcome : "?"}`).join(" ");
  const l = llm.map((t) => `${t.model}->${t.test}(${t.prediction})=${t.dataOutcome}${t.agreement ? " AGREE" : t.diverged ? " DIVERGE" : ""}`).join(" | ");
  console.log(`  ${name.padEnd(22)} [${isBlend ? "NEG" : "POS"}] P=${rec.periodDays.toFixed(3)}d  audit[${a}]  ${l}`);
  return { name, tic: rec.tic, isBlend, periodDays: rec.periodDays, depthPpm, audit, llm };
}

async function main(): Promise<void> {
  let providers: { key: string; base: string; model: string; name: string }[] = [];
  if (useLlm) { try { loadLocalEnv(); } catch { /* ambient */ } providers = listProviders(); }

  console.log(`P61 LLM->measurement loop @ ground-truth classes: ${wantPos} positive (KP) + ${wantNeg} negative (FP/EB) from the public TOI table.`);
  console.log(`  deep pixel/Gaia tests: ${deep ? "ON (--deep)" : "OFF (light-curve tests only; pixel/Gaia degrade to undetermined)"}`);
  console.log(`  LLM proposal layer: ${providers.length ? providers.map((p) => p.name).join(", ") : "OFF (no keys) -> deterministic 2x2 only"}\n`);

  const records = await fetchToiTable();
  if (!records.length) { console.log("Could not fetch the public TOI table (network). VERDICT: NO-USEFUL-DATA"); return; }
  const byBright = (a: ToiRecord, b: ToiRecord) => (a.tessMag || 99) - (b.tessMag || 99);
  const posPick = confirmedPositives(records).filter(isPlaceable).sort(byBright).slice(0, wantPos);
  const negPick = labelledNegatives(records).filter(isPlaceable).sort(byBright).slice(0, wantNeg);

  const targets: Target[] = [];
  for (const r of posPick) { const t = await processOne(r, false, providers); if (t) targets.push(t); }
  for (const r of negPick) { const t = await processOne(r, true, providers); if (t) targets.push(t); }

  const nPos = targets.filter((t) => !t.isBlend).length;
  const nNeg = targets.filter((t) => t.isBlend).length;
  if (!nPos) { console.log("\nno usable positive targets. VERDICT: INSUFFICIENT-DATA"); return; }

  // Per-test 2x2 on ground-truth classes: veto := the test tagged the target "blend"; isBlend := a labelled FP/EB.
  const perTest: Record<string, { cases: number; power: number | null; powerCI: [number, number] | null; falseVetoRate: number | null; safeToGate: boolean; reason: string }> = {};
  for (const t of TEST_MENU) {
    const cases: VetoCase[] = targets.map((tg) => ({ isBlend: tg.isBlend, veto: tg.audit[t.id]?.outcome === "blend" }));
    const m = vetoMetrics(cases);
    const acc = acceptVetoTool(cases);
    perTest[t.id] = { cases: cases.length, power: m.vetoPower, powerCI: m.vetoPowerCI, falseVetoRate: m.falseVetoRate, safeToGate: acc.safeToGate, reason: acc.reason };
  }

  const turns = targets.flatMap((t) => t.llm);
  const agreed = turns.filter((t) => t.agreement).length;
  const diverged = turns.filter((t) => t.diverged).length;

  console.log(`\n=== P61 SUMMARY (${nPos} known planets + ${nNeg} labelled FP/EB blends) ===`);
  for (const t of TEST_MENU) {
    const p = perTest[t.id];
    const pw = p.power == null ? "n/a" : `${(100 * p.power).toFixed(0)}%`;
    const fv = p.falseVetoRate == null ? "n/a" : `${(100 * p.falseVetoRate).toFixed(0)}%`;
    console.log(`  [2x2] ${t.id.padEnd(16)} catch ${pw} [${p.powerCI ? `${(100 * p.powerCI[0]).toFixed(0)},${(100 * p.powerCI[1]).toFixed(0)}` : "-"}]  false-veto ${fv}  safeToGate=${p.safeToGate}`);
    console.log(`         -> ${p.reason}`);
  }
  if (providers.length) console.log(`  [loop] model predictions matched the measurement ${agreed}/${turns.length}, diverged ${diverged}`);

  const anyGateable = TEST_MENU.some((t) => perTest[t.id].safeToGate);
  console.log(`\nVERDICT: ${providers.length ? "LOOP-RAN" : "DETERMINISTIC-2X2-ONLY"}; gateable-via-loop=${anyGateable ? "SOME" : "NONE"} (advisory; a test gates only on zero false-vetoes AND power above chance; discoveryClaim false, aggregate safeToGate false).`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p61-llm-hypothesis-loop.ts", nPos, nNeg, deep, providers: providers.map((p) => p.name), useLlm,
      positiveSource: "TOI-table KP dispositions (confirmed planets)", negativeSource: "TOI-table FP/EB dispositions (labelled blends)",
      note: "LLM proposes a falsifiable hypothesis + picks a menu test; the rig measures it on real photometry; each test's catch/false-veto is scored as a 2x2 on ground-truth classes via vetoAcceptance. Advisory; deterministic 2x2 runs even with no keys. Not a discovery claim.",
      integrity: "no worker import, no verdict, no bundle hash, no money path; model output never enters any deterministic artifact.",
    },
    perTest,
    llmLoop: providers.length ? { proposals: turns.length, matchedPrediction: agreed, diverged } : { off: true },
    gateableViaLoop: anyGateable,
    safeToGate: false,
    discoveryClaim: false,
    targets,
  };
  writeFileSync("reports/p61-llm-hypothesis.json", JSON.stringify(json, null, 2) + "\n");

  const fmtPct = (x: number | null) => (x == null ? "n/a" : `${(100 * x).toFixed(0)}%`);
  const md = [
    "# P61 an LLM-chosen test, scored as a 2x2 on ground-truth classes (closed loop @ scale)",
    "",
    `Reproduce: \`npm run p61:llm-hypothesis -- --pos ${wantPos} --neg ${wantNeg}${deep ? " --deep" : ""}${providers.length ? "" : " --no-llm"}\`  (models: ${providers.length ? providers.map((p) => p.name).join(", ") : "none -> deterministic 2x2"})`,
    "",
    `Both classes come from ONE token-free public source (the ExoFOP TOI table): **${nPos} confirmed planets (positives)**`,
    `and **${nNeg} FP/EB dispositions (labelled blends)**. Each menu test is run on real photometry and scored as a`,
    `full 2x2 via \`src/candidate/vetoAcceptance\` (catch-rate on blends, false-veto on known planets, acceptVetoTool).`,
    deep ? "Pixel (PSF double-difference) and Gaia-dilution tests are ACTIVE (--deep)." : "Pixel/Gaia tests degrade to undetermined without --deep (light-curve tests below are the operating point).",
    "",
    `| test | catch-rate on labelled blends | 95% Wilson CI | false-veto on known planets | safe to gate? |`,
    `|---|---|---|---|---|`,
    ...TEST_MENU.map((t) => { const p = perTest[t.id]; return `| ${t.id} | ${fmtPct(p.power)} | ${p.powerCI ? `[${(100 * p.powerCI[0]).toFixed(0)}, ${(100 * p.powerCI[1]).toFixed(0)}]` : "-"} | ${fmtPct(p.falseVetoRate)} | ${p.safeToGate} |`; }),
    "",
    providers.length ? `LLM loop: ${turns.length} proposals, prediction matched the measurement ${agreed}, diverged ${diverged}.` : `LLM layer OFF -- this is the deterministic per-test 2x2.`,
    "",
    `Gateable via the loop: ${anyGateable ? "SOME" : "NONE"}. ${anyGateable ? "At least one test met the zero-false-veto + power bar on this sample; it still needs a larger, labelled re-run before it could be proposed as a gate." : "No test met the zero-false-veto + power-above-chance bar, so none is gate-worthy here -- every one is a diagnostic score only."}`,
    "",
    `An LLM idea becomes a result only when the deterministic measurement agrees; a TEST becomes gate-worthy only when`,
    `its 2x2 shows zero false-vetoes AND real power. Nothing is wired into a verdict / bundle / money path (safeToGate`,
    `false, discoveryClaim false).`,
    "",
  ].join("\n");
  writeFileSync("reports/p61-llm-hypothesis.md", md);
  console.log("\nwrote reports/p61-llm-hypothesis.md and reports/p61-llm-hypothesis.json");
}

main().catch((e) => { console.error(`[p61] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
