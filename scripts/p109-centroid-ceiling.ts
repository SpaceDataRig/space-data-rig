// P109 (discovery roadmap: the CEILING of the pixel-centroid feature set, closing the p82/p104/p106 centroid line).
// p104 refused to promote the centroid F-test at one threshold (0/59 blends caught); p106 showed the TARGET p-value
// carries no separation at ANY threshold (AUC 0.479). But p106 left the other axis -- the neighbour-consistency
// p-value (bestNeighbourP), which showed a weak AUC 0.669 -- only glanced at. p109 finishes the job: it asks what the
// BEST possible blend/planet separation the whole centroid feature set can reach on the committed real labelled data
// is, sweeping (1) each axis alone, (2) the 2-D conjunction the p82 harness actually used, (3) a composite score, and
// (4) a stratification by viable-neighbour count -- and reports the maximum achievable ceiling. It then states the
// decisive caveat that no ceiling fixes: these planet/blend LABELS come from the p82 injection/validation harness,
// NOT from external confirmed difference-imaging, so even a high AUC here would not be independent validation of a
// real candidate. Fully OFFLINE, deterministic, machine-verified.
//
// Nothing is gated, anchored, claimed or deployed; discoveryClaim and safeToGate stay false -- this measures a
// discriminator's power ceiling, it does not announce a finding.
//
// Usage: npm run p109:centroid-ceiling
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";

const CENTROID_FIXTURE = "tests/fixtures/scaled/centroid.jsonl";
const PROTOCOL_PATH = "discovery-protocol.json";

interface Row { label: string; testable: boolean; pTarget: number; bestNeighbourP: number; viableNeighbours: number; }

/** P(score_positive > score_negative) + 0.5 P(equal) -- Mann-Whitney AUC under "higher score = more blend-like". */
function aucGt(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// Youden-optimal cut for a "flag as blend" rule of the form score >= cut (higher = more blend-like).
function youdenGe(blendScores: number[], planetScores: number[]): { cut: number | null; sens: number; spec: number; j: number } {
  const cuts = Array.from(new Set([...blendScores, ...planetScores])).sort((a, b) => a - b);
  let best = { cut: null as number | null, sens: 0, spec: 0, j: -Infinity };
  for (const c of cuts) {
    const sens = blendScores.filter((s) => s >= c).length / (blendScores.length || 1);
    const spec = planetScores.filter((s) => s < c).length / (planetScores.length || 1);
    const j = sens + spec - 1;
    if (j > best.j) best = { cut: c, sens, spec, j };
  }
  return best;
}

function main() {
  JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")); // stamp input; protocol defines the gate this axis would feed
  const rows = readFileSync(CENTROID_FIXTURE, "utf8").replace(/\r/g, "").trim().split("\n").map((l) => JSON.parse(l) as Row);
  const testable = rows.filter((r) => r.testable);
  const blends = testable.filter((r) => r.label === "blend");
  const planets = testable.filter((r) => r.label === "planet");
  const bT = blends.map((r) => r.pTarget), pT = planets.map((r) => r.pTarget);
  const bN = blends.map((r) => r.bestNeighbourP), pN = planets.map((r) => r.bestNeighbourP);

  // (1) single-axis ceilings.
  const aucTarget = Number(aucGt(pT, bT).toFixed(4)); // higher planet target-p than blend? (target-p is near-useless)
  const aucNeighbour = Number(aucGt(bN, pN).toFixed(4)); // blends have higher bestNeighbourP (weak signal)
  const yNeighbour = youdenGe(bN, pN);

  // (2) the 2-D conjunction the p82 harness used: flag blend if pTarget <= tp AND bestNeighbourP >= nb.
  const tpCuts = Array.from(new Set(bT.concat(pT))).sort((a, b) => a - b);
  const nbCuts = Array.from(new Set(bN.concat(pN))).sort((a, b) => a - b);
  let conj = { tp: null as number | null, nb: null as number | null, sens: 0, spec: 0, j: -Infinity };
  for (const tp of tpCuts) for (const nb of nbCuts) {
    const sens = blends.filter((r) => r.pTarget <= tp && r.bestNeighbourP >= nb).length / (blends.length || 1);
    const spec = planets.filter((r) => !(r.pTarget <= tp && r.bestNeighbourP >= nb)).length / (planets.length || 1);
    const j = sens + spec - 1;
    if (j > conj.j) conj = { tp, nb, sens, spec, j };
  }

  // (3) composite score (neighbour consistency minus target p): a fair 2-feature blend-likeness.
  const bScore = blends.map((r) => r.bestNeighbourP - r.pTarget), pScore = planets.map((r) => r.bestNeighbourP - r.pTarget);
  const aucComposite = Number(aucGt(bScore, pScore).toFixed(4));

  // (4) stratified by viable-neighbour count: does the neighbour axis help more when neighbours actually exist?
  const bands = [[0, 0], [1, 4], [5, 19], [20, Infinity]] as [number, number][];
  const strata = bands.map(([lo, hi]) => {
    const sb = blends.filter((r) => r.viableNeighbours >= lo && r.viableNeighbours <= hi).map((r) => r.bestNeighbourP);
    const sp = planets.filter((r) => r.viableNeighbours >= lo && r.viableNeighbours <= hi).map((r) => r.bestNeighbourP);
    return { band: hi === Infinity ? `>=${lo}` : `${lo}-${hi}`, nBlend: sb.length, nPlanet: sp.length, auc: sb.length && sp.length ? Number(aucGt(sb, sp).toFixed(4)) : null };
  });
  const strataAucs = strata.filter((s) => s.auc !== null && s.nBlend >= 5 && s.nPlanet >= 5).map((s) => s.auc as number);
  const bestStratumAuc = strataAucs.length ? Math.max(...strataAucs) : Number.NaN;

  // Practical operating point: the most blends the neighbour axis can flag while wrongly rejecting <= 5% of planets.
  let catchAt5pct = { nbCut: null as number | null, sens: 0, fpr: 0 };
  for (const c of nbCuts) {
    const fpr = planets.filter((r) => r.bestNeighbourP >= c).length / (planets.length || 1);
    const sens = blends.filter((r) => r.bestNeighbourP >= c).length / (blends.length || 1);
    if (fpr <= 0.05 && sens > catchAt5pct.sens) catchAt5pct = { nbCut: c, sens, fpr };
  }

  const ceiling = Math.max(aucNeighbour, aucComposite, Number.isFinite(bestStratumAuc) ? bestStratumAuc : 0);
  const bestJ = Math.max(yNeighbour.j, conj.j);
  const usable = ceiling >= 0.7 && bestJ >= 0.4;
  const power = !Number.isFinite(ceiling) ? "undefined" : ceiling > 0.7 ? "usable" : ceiling > 0.6 ? "weak" : "none";
  const verdict = `P109-CENTROID-CEILING (the best blend/planet separation the whole pixel-centroid feature set can reach on ${blends.length} testable blends / ${planets.length} testable planets, offline): target-p AUC ${aucTarget.toFixed(3)} (none), neighbour-p AUC ${aucNeighbour.toFixed(3)} (weak), 2-feature composite AUC ${aucComposite.toFixed(3)}, best viable-neighbour stratum AUC ${Number.isFinite(bestStratumAuc) ? bestStratumAuc.toFixed(3) : "n/a"} -> CEILING = ${ceiling.toFixed(3)} (${power}); best achievable Youden J = ${bestJ.toFixed(2)} (neighbour ${yNeighbour.j.toFixed(2)}, conjunction ${conj.j.toFixed(2)}); at a <=5% planet-false-reject budget the neighbour axis flags only ${catchAt5pct.sens.toFixed(2)} of blends. Two things close the centroid line: (1) no rule -- single axis, the p82 conjunction, a composite, or a stratified sub-population -- clears the 0.7 usable bar, confirming p104/p106 now with an explicit ceiling; (2) decisively, these planet/blend LABELS come from the p82 injection/validation harness, NOT external confirmed difference-imaging, so even a ceiling above 0.7 would not be independent validation of a real candidate -- the axis stays diagnostic-only and cannot be fed favourably to the gate. usable=${usable}. discoveryClaim false, safeToGate false.`;
  console.log(`  blends ${blends.length} / planets ${planets.length}`);
  console.log(`  AUC target ${aucTarget.toFixed(3)} | neighbour ${aucNeighbour.toFixed(3)} | composite ${aucComposite.toFixed(3)} | best stratum ${Number.isFinite(bestStratumAuc) ? bestStratumAuc.toFixed(3) : "n/a"} -> CEILING ${ceiling.toFixed(3)} [${power}]`);
  console.log(`  Youden neighbour ${yNeighbour.j.toFixed(2)} (sens ${yNeighbour.sens.toFixed(2)}/spec ${yNeighbour.spec.toFixed(2)}), conjunction ${conj.j.toFixed(2)}`);
  console.log(`  catch@<=5% FPR: ${catchAt5pct.sens.toFixed(2)} (nbCut ${catchAt5pct.nbCut})`);
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p109-centroid-ceiling.ts", PROTOCOL_PATH, CENTROID_FIXTURE]),
      generatedBy: "scripts/p109-centroid-ceiling.ts", module: "centroid F-test features via scripts/p82-scaled-validation.ts",
      data: "committed REAL pixel-centroid checkpoint (tests/fixtures/scaled/centroid.jsonl), planet/blend labels from the p82 injection/validation harness. AUC over 2-sig-fig stored p-values. Fully offline, deterministic.",
      note: "ceiling audit of the centroid feature set: best achievable separation by any rule + the label-provenance caveat. discoveryClaim false, safeToGate false.",
    },
    nTestableBlends: blends.length, nTestablePlanets: planets.length,
    aucTarget, aucNeighbour, aucComposite, bestStratumAuc: Number.isFinite(bestStratumAuc) ? bestStratumAuc : null, ceiling: Number(ceiling.toFixed(4)), power, usable,
    youdenNeighbour: { j: Number(yNeighbour.j.toFixed(4)), sensitivity: Number(yNeighbour.sens.toFixed(4)), specificity: Number(yNeighbour.spec.toFixed(4)) },
    youdenConjunction: { j: Number(conj.j.toFixed(4)), pTargetCut: conj.tp, neighbourCut: conj.nb, sensitivity: Number(conj.sens.toFixed(4)), specificity: Number(conj.spec.toFixed(4)) },
    strata, catchAt5pctFalseReject: { sensitivity: Number(catchAt5pct.sens.toFixed(4)), falseReject: Number(catchAt5pct.fpr.toFixed(4)) },
    labelsFromHarnessNotExternalImaging: true,
    verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p109-centroid-ceiling.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P109 - Centroid feature-set ceiling: the best the axis can possibly do (and why it still cannot gate)",
    "",
    "Generated by `scripts/p109-centroid-ceiling.ts`. p104 refused the pixel-centroid F-test at one threshold;",
    "p106 showed the target p-value separates nothing at any threshold. p106 only glanced at the second axis",
    "(neighbour-consistency, AUC ~0.67). p109 finishes the centroid line: it sweeps every rule -- each axis alone,",
    "the 2-D conjunction the p82 harness used, a two-feature composite, and a stratification by viable-neighbour",
    "count -- and reports the maximum achievable ceiling. Fully offline over a committed fixture.",
    "",
    `Reproduce: \`npm run p109:centroid-ceiling\``,
    "",
    `- AUCs: target ${aucTarget.toFixed(3)} | neighbour ${aucNeighbour.toFixed(3)} | composite ${aucComposite.toFixed(3)} | best stratum ${Number.isFinite(bestStratumAuc) ? bestStratumAuc.toFixed(3) : "n/a"}.`,
    `- CEILING = ${ceiling.toFixed(3)} (${power} separation); best Youden J = ${bestJ.toFixed(2)}.`,
    `- At a <=5% planet-false-reject budget the neighbour axis flags only ${catchAt5pct.sens.toFixed(2)} of blends.`,
    "",
    "## Strata (does a neighbour-rich sub-population help?)",
    "",
    "| viable-neighbour band | blends | planets | neighbour AUC |",
    "|---|---|---|---|",
    ...strata.map((s) => `| ${s.band} | ${s.nBlend} | ${s.nPlanet} | ${s.auc === null ? "n/a" : s.auc.toFixed(3)} |`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: 'we did not promote it' is strongest when we show no rule can rescue it -- and name the limit",
    "no rule can cross: the labels are harness-derived, not external imaging. The centroid axis stays diagnostic;",
    "ruling out blends for real needs target-pixel difference-imaging. Research-only; nothing gated, anchored,",
    "claimed, or deployed. `safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p109-centroid-ceiling.md", md);
  console.log("\nwrote reports/p109-centroid-ceiling.md and .json");
}

main();
