// P68 - DISCRIMINATOR ROC: is there ANY operating point where a light-curve/pixel vetting tool rejects
// blends without killing known planets?
//
// WHY THIS EXISTS. P61 scored each vetting discriminator as a BINARY 2x2 by collapsing its continuous metric
// at a single hard-coded cut (odd/even>0.3 => blend, dilution<0.7 => blend, ...). That answers "is THIS cut
// gate-worthy" but never the reviewer's real question: does ANY threshold on ANY discriminator put false-kill
// near zero while still catching blends above chance? A tool can only be a gate if the ROC passes near the
// (false-kill=0) corner with real power. P63 published one operating point of the soft score; this study maps
// the WHOLE curve.
//
// OFFLINE RE-DERIVATION, deterministic, no network and no re-analysis (the same discipline P63 used): it reads
// the continuous per-target metrics ALREADY committed in reports/p61-llm-hypothesis.json (24 confirmed planets
// + 18 labelled FP/EB blends, run --deep so pixel/Gaia metrics are populated) and, for each discriminator,
// computes the full catch-rate (TPR on labelled blends) vs false-kill-rate (FPR on known planets) sweep plus a
// Mann-Whitney AUC (blend = positive class, oriented so higher score = more blend-like). It reuses the SAME
// numbers the report publishes -- it measures nothing new about the sky, only the threshold dimension P61 left
// on the table.
//
// Red lines: reads a committed report only; no worker import, no verdict, no bundle hash, no money path;
// positive/negative classes are both ground-truth public TOI dispositions; discoveryClaim structurally false,
// safeToGate false. If no threshold clears the corner we write the ROC down as the measured reason the tools
// stay advisory.
//
// Run: npm run p68:discriminator-roc

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";
// ROUND-26: the published verdict here ("NO-GATE-CONFIRMED") is exactly the kind of claim a reader should be able to
// re-derive, yet the report carried no stamp, so the library could only call it `unattested`. buildStamp writes
// generatedAt + gitSha + a sha256 per input; re-running reproduces the committed numbers byte for byte, so the missing
// thing was the checkable provenance, not a drift. Inputs: the P61 report whose per-target metrics are re-used, the
// interval module the CIs come from, and this script.
import { buildStamp } from "./report-freshness.ts";

interface Audit { metric: number; determined: boolean; outcome: string }
interface Target { name: string; isBlend: boolean; audit: Record<string, Audit> }

// discriminator id -> orientation. positive class is BLEND; orientedScore = orientation * metric so that a
// HIGHER oriented score always means "more blend-like" (the direction the report's own tags use).
const DISCRIMINATORS: { id: string; label: string; orient: 1 | -1 }[] = [
  { id: "odd-even-depth", label: "odd/even depth mismatch", orient: 1 },   // high mismatch => blend
  { id: "secondary-eclipse", label: "secondary/primary ratio", orient: 1 }, // high ratio => blend
  { id: "shape-coherence", label: "folded shape coherence", orient: -1 },   // low coherence => blend
  { id: "gaia-dilution", label: "aperture dilution factor", orient: -1 },   // low dilution => blend
  { id: "psf-localize", label: "PSF double-difference offset", orient: 1 }, // high offset => off-target/blend
];

// Mann-Whitney AUC with tie handling: P(blend score > planet score) + 0.5 P(tie), over usable scores only.
function mannWhitneyAuc(blendScores: number[], planetScores: number[]): number | null {
  const nB = blendScores.length, nP = planetScores.length;
  if (nB < 1 || nP < 1) return null;
  let above = 0, ties = 0;
  for (const b of blendScores) for (const p of planetScores) {
    if (b > p) above++; else if (b === p) ties++;
  }
  return (above + 0.5 * ties) / (nB * nP);
}

// Sweep every observed score as a candidate cut (reject/flag blends at score >= cut); report the catch/kill
// at that point and the best catch subject to a false-kill budget.
function rocCurve(blendScores: number[], planetScores: number[]) {
  const cuts = Array.from(new Set([...blendScores, ...planetScores])).sort((a, b) => a - b);
  const points = cuts.map((cut) => {
    const caught = blendScores.filter((s) => s >= cut).length;
    const killed = planetScores.filter((s) => s >= cut).length;
    return { cut, caught, killed, tpr: caught / blendScores.length, fpr: killed / planetScores.length };
  });
  const bestUnder = (maxFpr: number) => {
    let best: { cut: number; caught: number; tpr: number; fpr: number } | null = null;
    for (const p of points) if (p.fpr <= maxFpr && (!best || p.tpr > best.tpr)) best = { cut: p.cut, caught: p.caught, tpr: p.tpr, fpr: p.fpr };
    return best;
  };
  return { points, bestKill0: bestUnder(0), bestKill5: bestUnder(0.05), bestKill10: bestUnder(0.10) };
}

function main(): void {
  let report: { targets: Target[] };
  try {
    report = JSON.parse(readFileSync("reports/p61-llm-hypothesis.json", "utf8"));
  } catch { console.log("reports/p61-llm-hypothesis.json not found (run p61 first). VERDICT: NO-USEFUL-DATA"); process.exitCode = 0; return; }
  const targets = report.targets || [];
  const nPos = targets.filter((t) => !t.isBlend).length;
  const nNeg = targets.filter((t) => t.isBlend).length;
  console.log(`P68 DISCRIMINATOR ROC (offline re-derivation of committed P61 continuous metrics): ${nPos} known planets + ${nNeg} labelled blends.`);

  const results: Record<string, any> = {};
  let anyGateable = false;
  for (const d of DISCRIMINATORS) {
    const blendScores: number[] = [], planetScores: number[] = [];
    let determined = 0;
    for (const t of targets) {
      const a = t.audit?.[d.id];
      if (!a || !a.determined || !Number.isFinite(a.metric)) continue;
      determined++;
      (t.isBlend ? blendScores : planetScores).push(d.orient * a.metric);
    }
    const nB = blendScores.length, nP = planetScores.length;
    const auc = mannWhitneyAuc(blendScores, planetScores);
    const { points, bestKill0, bestKill5, bestKill10 } = nB && nP ? rocCurve(blendScores, planetScores) : { points: [], bestKill0: null, bestKill5: null, bestKill10: null };
    // a discriminator is GATE-WORTHY only if some cut catches blends above chance while killing ZERO known planets.
    const gateWorthy = !!(bestKill0 && bestKill0.tpr >= 1 / nB && bestKill0.caught >= 2 && auc != null && auc >= 0.7);
    if (gateWorthy) anyGateable = true;
    const tpr0CI = bestKill0 ? wilsonInterval(bestKill0.caught, nB) : null;
    results[d.id] = {
      label: d.label, orientation: d.orient === 1 ? "higher score = more blend-like" : "lower score = more blend-like",
      nBlendUsable: nB, nPlanetUsable: nP, nDetermined: determined,
      auc, aucVsChance: auc == null ? null : (auc - 0.5),
      bestCatchAtKill0: bestKill0 ? { cut: bestKill0.cut, caught: bestKill0.caught, catchRate: bestKill0.tpr, ciLow: tpr0CI?.[0], ciHigh: tpr0CI?.[1] } : null,
      bestCatchAtKill5: bestKill5 ? { cut: bestKill5.cut, catchRate: bestKill5.tpr, killRate: bestKill5.fpr } : null,
      bestCatchAtKill10: bestKill10 ? { cut: bestKill10.cut, catchRate: bestKill10.tpr, killRate: bestKill10.fpr } : null,
      rocPoints: points,
      gateWorthy,
    };
    const f = (x: number | null) => (x == null ? "n/a" : x.toFixed(2));
    console.log(`  [ROC] ${d.id.padEnd(17)} nB=${nB} nP=${nP}  AUC ${f(auc)}  best catch @ kill=0: ${bestKill0 ? `${(100 * bestKill0.tpr).toFixed(0)}% (${bestKill0.caught}/${nB})` : "n/a"}  @ kill<=5%: ${bestKill5 ? `${(100 * bestKill5.tpr).toFixed(0)}%` : "n/a"}  gateWorthy=${gateWorthy}`);
  }

  const aucs = Object.values(results).map((r: any) => r.auc).filter((x: any) => x != null) as number[];
  const maxAuc = aucs.length ? Math.max(...aucs) : null;
  const bestTest = aucs.length ? Object.entries(results).sort(([, a]: any, [, b]: any) => b.auc - a.auc)[0][0] : null;

  const verdict = anyGateable
    ? "SOME-DISCRIMINATOR-GATEABLE: at least one continuous tool has a cut catching blends with zero known-planet kills -- a candidate gate, still requiring a larger labelled re-run before wiring."
    : maxAuc != null && maxAuc >= 0.75
      ? `WEAK-NO-SAFE-GATE (best AUC ${maxAuc.toFixed(2)} on ${bestTest} separates blends from planets but every cut that catches blends also kills known planets; advisory score only, not a gate).`
      : `NO-GATE-CONFIRMED: no continuous discriminator clears the blends-from-planets corner (best AUC ${(maxAuc ?? 0).toFixed(2)} on ${bestTest}); at every threshold that catches blends above chance it false-kills known planets -- the light-curve/pixel tools CANNOT self-validate candidates, only rank them.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log("  measure-before-gate: positive/negative classes are both ground-truth TOI dispositions; nothing gated, anchored or claimed. discoveryClaim false, safeToGate false.");

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p68-discriminator-roc.ts", nPos, nNeg, source: "reports/p61-llm-hypothesis.json per-target continuous metrics (offline re-derivation, no new data, no re-analysis)",
      positiveClass: "known planets (false-kill = flagging one)", blendClass: "labelled FP/EB (catch-rate = flagging one)", aucConvention: "blend is the positive class; score oriented so higher = more blend-like; Mann-Whitney AUC",
      note: "maps the full threshold trade-off P61 collapsed to a single binary cut; answers whether ANY operating point rejects blends without killing known planets.",
      ...buildStamp(["reports/p61-llm-hypothesis.json", "src/sim/completenessGrid.ts", "scripts/p68-discriminator-roc.ts"]),
    },
    discriminators: results,
    bestTest, bestAuc: maxAuc,
    anyGateable,
    verdict,
    safeToGate: false,
    discoveryClaim: false,
  };
  writeFileSync("reports/p68-discriminator-roc.json", JSON.stringify(json, null, 2) + "\n");

  const pct = (x: number | null | undefined) => (x == null ? "n/a" : `${(100 * x).toFixed(0)}%`);
  const md = [
    "# P68 discriminator ROC: does ANY threshold reject blends without killing known planets?",
    "",
    "P61 collapsed each vetting tool to a binary at one hard-coded cut. This study sweeps the FULL continuous",
    "threshold for every discriminator on the committed P61 per-target metrics",
    `(${nPos} known planets + ${nNeg} labelled FP/EB blends, run --deep), giving a Mann-Whitney AUC and the best`,
    "blend catch-rate subject to a zero / 5% / 10% known-planet false-kill budget. A tool is gate-worthy only",
    "if some cut catches blends above chance while killing ZERO known planets.",
    "",
    "| discriminator | blends | planets | AUC | best catch @ 0% kill | best catch @ <=5% kill | gate-worthy |",
    "|---|---|---|---|---|---|---|",
    ...DISCRIMINATORS.map((d) => { const r = results[d.id]; const k0 = r.bestCatchAtKill0 ? `${pct(r.bestCatchAtKill0.catchRate)} (${r.bestCatchAtKill0.caught}/${r.nBlendUsable})` : "n/a"; return `| ${d.id} | ${r.nBlendUsable} | ${r.nPlanetUsable} | ${r.auc == null ? "n/a" : r.auc.toFixed(2)} | ${k0} | ${r.bestCatchAtKill5 ? pct(r.bestCatchAtKill5.catchRate) : "n/a"} | ${r.gateWorthy} |`; }),
    "",
    `Best separator: ${bestTest} (AUC ${(maxAuc ?? 0).toFixed(2)}). Gateable via any threshold: ${anyGateable ? "SOME" : "NONE"}.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Offline re-derivation of already-published continuous metrics; discovery claims stay structurally false;",
    "nothing here is gated, anchored, or deployed.",
    "",
  ].join("\n");
  writeFileSync("reports/p68-discriminator-roc.md", md);
  console.log("\nwrote reports/p68-discriminator-roc.md and reports/p68-discriminator-roc.json");
}

main();
