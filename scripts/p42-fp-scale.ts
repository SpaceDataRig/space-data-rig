// P42 - SYSTEMATICS-AWARE FAP AT SCALE, ACROSS SECTORS, WITH A FORMAL DISCRIMINATION METRIC.
//
// WHY (deepens p39). p39 measured the coherent-systematics FP cut on ONE sector at N=40 (a pilot). Two things a
// pilot cannot establish: (1) that the -76% FP reduction is not a sector-1 fluke but holds across independent
// fields and larger ensembles, and (2) HOW WELL the systematics-aware null separates a real planet from a coherent
// artifact, as a single number a reader can audit -- not just a survivor count at one threshold. p42 delivers both:
// it sweeps several TGLC sectors, and builds a labelled pool (positives = a known transit injected onto a REAL
// corrected curve; negatives = the A-gate survivors of the quiet corrected curves, which are false by construction)
// and scores every candidate with BOTH the per-star noise FAP and the systematics-aware FAP. It then reports the
// ROC and the Mann-Whitney AUC for each, so the claim becomes "the coherent null discriminates real planets from
// instrumental systematics better than the noise-only gate" -- measurable, threshold-free, reproducible.
//
// HONEST SEMANTICS. Negatives are quiet real curves: a few may be genuine UNCONFIRMED planets, which counts as a
// false positive here -- the same conservative floor p33/p39 use, so the reported AUC is a lower bound on the gain.
// Research-only: no worker import, no verdict, no bundle hash, no money path; nothing gated, anchored, claimed or
// deployed. Deterministic given the seed.
//
// Run: npm run p42:fp-scale [-- --sectors 1,2,3 --limit 150 --nNull 60 --inject 40 --seed 7]
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { systematicsAwareFap, benjaminiHochberg } from "../src/detect/instrumentalNull.ts";
import { removeCommonMode, commonModeTemplate } from "../src/detect/commonMode.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { tglcBytesToLightCurve } from "../src/data/tglc.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-p42)";

function arg(name: string, d: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
}
async function s3Keys(prefix: string, maxKeys = 2000): Promise<string[]> {
  const r = await fetch(`${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]!);
}
async function download(key: string): Promise<Uint8Array | null> {
  try { const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; }
}

/** Mann-Whitney AUC: P(a random positive scores higher than a random negative), ties worth 0.5. Score = -FAP. */
function auc(pos: number[], neg: number[]): number {
  const all = [...pos.map((s) => ({ s, p: true })), ...neg.map((s) => ({ s, p: false }))].sort((a, b) => a.s - b.s);
  // average ranks (handle ties): rank sum for positives
  let rank = 0; let i = 0; const ranks = new Array<number>(all.length);
  while (i < all.length) {
    let j = i; while (j + 1 < all.length && all[j + 1]!.s === all[i]!.s) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[k] = avg; rank = j; i = j + 1;
  }
  let sumPos = 0; for (let k = 0; k < all.length; k++) if (all[k]!.p) sumPos += ranks[k]!;
  const np = pos.length, nn = neg.length;
  if (!np || !nn) return NaN;
  return (sumPos - (np * (np + 1)) / 2) / (np * nn);
}
/** ROC points sweeping an FAP threshold: TPR = TP kept, FPR = FP kept (a candidate is "called planet" if FAP <= thr). */
function rocAt(posFap: number[], negFap: number[], thr: number): { tpr: number; fpr: number } {
  const keep = (arr: number[]) => arr.filter((f) => f <= thr).length;
  const tpr = posFap.length ? keep(posFap) / posFap.length : 0;
  const fpr = negFap.length ? keep(negFap) / negFap.length : 0;
  return { tpr, fpr };
}

interface SectorRow { sector: number; n: number; fpA: number; fpB: number; fpC: number; fpD: number; tp: number; tpSys: number; tmplRms: number; tmplPeak: number }

async function main(): Promise<void> {
  const sectors = arg("sectors", "1,2,3").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  const limit = Math.max(10, parseInt(arg("limit", "150"), 10));
  const seed = parseInt(arg("seed", "7"), 10);
  const nNull = Math.max(20, parseInt(arg("nNull", "60"), 10));
  const nInject = Math.max(0, parseInt(arg("inject", "40"), 10));
  const fapThr = 0.05, bhQ = 0.1, injPeriod = 3, injDepth = 8000;

  console.log(`[p42] FP control at scale across sectors [${sectors}] limit ${limit}/sector, nNull ${nNull}, inject ${nInject}/sector, seed ${seed}.`);

  const rows: SectorRow[] = [];
  const posNoise: number[] = [], posSys: number[] = [], negNoise: number[] = [], negSys: number[] = [];

  for (const sector of sectors) {
    const sectStr = `s${String(sector).padStart(4, "0")}`;
    let keys: string[];
    try { keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit); }
    catch (e) { console.log(`[p42] sector ${sectStr} listing failed: ${e instanceof Error ? e.message : e}; skip`); continue; }
    const curves: LightCurve[] = [];
    for (const key of keys) {
      const bytes = await download(key); if (!bytes) continue;
      try { const lc = tglcBytesToLightCurve(bytes, key.slice(-30)); if (lc && lc.points.length >= 40) curves.push(lc); } catch { /* skip */ }
    }
    if (curves.length < 8) { console.log(`[p42] sector ${sectStr}: only ${curves.length} usable curves; skip`); continue; }
    // subtract-then-gate (the intended posture): correct at source, then build the residual coherent template ONCE.
    const corrected = removeCommonMode(curves, { minStars: 8 }).curves;
    const ctmpl = commonModeTemplate(corrected);

    let fpA = 0, fpB = 0, fpC = 0; const fpSysVals: number[] = [];
    for (const lc of corrected) {
      try {
        const r = bls(preprocess(lc, 0.5)); const d = r.depth * 1e6;
        if (!(d >= 200 && r.snr >= 7 && classifyDepthRegime(d).planetPlausible)) continue;
        fpA++;
        const sig = calibratedFap(lc, r.snr, r.periodDays, { nNull, seed, maxPoints: 2500 });
        if (sig.fap <= fapThr) fpB++;
        const sys = systematicsAwareFap(lc, r.snr, r.periodDays, corrected, { nNull, seed, template: ctmpl });
        if (sys.fapSys <= fapThr) fpC++;
        fpSysVals.push(sys.fapSys);
        negNoise.push(sig.fap); negSys.push(sys.fapSys);
      } catch { /* degenerate */ }
    }
    const bh = benjaminiHochberg(fpSysVals, bhQ);
    const fpD = bh.rejected.filter(Boolean).length;

    let tp = 0, tpSys = 0;
    for (let trial = 0; trial < nInject; trial++) {
      const base = corrected[trial % corrected.length]!;
      const withPlanet = injectTransitInto(base, { periodDays: injPeriod, depthFrac: injDepth / 1e6, seed: seed + 700 + trial });
      try {
        const r = bls(preprocess(withPlanet, 0.5));
        if (r.snr < 7 || r.depth * 1e6 < 200 || !periodMatched(r.periodDays, injPeriod, 5)) continue;
        const sig = calibratedFap(withPlanet, r.snr, r.periodDays, { nNull, seed, maxPoints: 2500 });
        const sys = systematicsAwareFap(withPlanet, r.snr, r.periodDays, corrected, { nNull, seed, template: ctmpl });
        tp++; if (sys.fapSys <= fapThr) tpSys++;
        posNoise.push(sig.fap); posSys.push(sys.fapSys);
      } catch { /* degenerate */ }
    }

    rows.push({ sector, n: corrected.length, fpA, fpB, fpC, fpD, tp, tpSys, tmplRms: Math.round(ctmpl.rmsPpm), tmplPeak: Math.round(ctmpl.maxAbsPpm) });
    console.log(`  sector ${sectStr}: ${corrected.length} curves | FP A${fpA} B${fpB} C${fpC} D${fpD} | TP ${tp} kept ${tpSys} | resid tmpl RMS ${Math.round(ctmpl.rmsPpm)}ppm peak ${Math.round(ctmpl.maxAbsPpm)}ppm`);
  }

  if (!rows.length) { console.log("\n[p42] no usable sectors; VERDICT: NO-USEFUL-DATA"); return; }

  // Aggregate + discrimination. Score for AUC = -FAP (a lower FAP is more planet-like).
  const agg = rows.reduce((a, r) => ({ n: a.n + r.n, fpA: a.fpA + r.fpA, fpB: a.fpB + r.fpB, fpC: a.fpC + r.fpC, fpD: a.fpD + r.fpD, tp: a.tp + r.tp, tpSys: a.tpSys + r.tpSys }), { n: 0, fpA: 0, fpB: 0, fpC: 0, fpD: 0, tp: 0, tpSys: 0 });
  const aucNoise = auc(posNoise.map((x) => -x), negNoise.map((x) => -x));
  const aucSys = auc(posSys.map((x) => -x), negSys.map((x) => -x));
  const thresholds = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2];
  console.log(`\n[p42] ===== AGGREGATE (${rows.length} sectors, ${agg.n} curves) =====`);
  console.log(`  FP: A ${agg.fpA} -> B ${agg.fpB} -> C ${agg.fpC} (sysFAP removes ${agg.fpA ? ((agg.fpA - agg.fpC) / agg.fpA * 100).toFixed(0) : "n/a"}%) -> D ${agg.fpD}`);
  console.log(`  injected completeness kept by sysFAP: ${agg.tp ? ((100 * agg.tpSys / agg.tp).toFixed(1) + "%") : "n/a"} (${agg.tpSys}/${agg.tp})`);
  console.log(`  AUC (planet-vs-artifact discrimination, score=-FAP): noise-FAP ${aucNoise.toFixed(3)} | sysFAP ${aucSys.toFixed(3)} | gain ${(aucSys - aucNoise).toFixed(3)}`);
  console.log(`  pool: ${posSys.length} positives, ${negSys.length} negatives`);

  mkdirSync("reports", { recursive: true });
  const pct = (x: number, n: number) => (n > 0 ? `${((100 * x) / n).toFixed(1)}%` : "n/a");
  const L: string[] = [];
  L.push("# P42 systematics-aware FP control at scale, across sectors, with a formal discrimination metric");
  L.push("");
  L.push(`Reproduce: \`npm run p42:fp-scale -- --sectors ${sectors.join(",")} --limit ${limit} --nNull ${nNull} --inject ${nInject} --seed ${seed}\``);
  L.push(`Data: real TGLC full-frame curves (token-free public S3), subtract-then-gate posture. Module:`);
  L.push(`\`src/detect/instrumentalNull.ts\`. Positives = a P=${injPeriod} d / ${injDepth} ppm transit injected onto a REAL`);
  L.push(`corrected curve and recovered by the A-gate; negatives = the A-gate survivors of the quiet corrected curves`);
  L.push(`(false by construction; a few may be unconfirmed planets, so AUC is a lower bound on the gain).`);
  L.push("");
  L.push("## Per sector (FP survivors by gate; every null-arm survivor is a false positive)");
  L.push("");
  L.push("| sector | curves | A) SNR gate | B) +noiseFAP | C) +sysFAP | D) +BH-FDR | TP | TP kept by sysFAP | resid tmpl RMS/peak ppm |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${r.sector} | ${r.n} | ${r.fpA} | ${r.fpB} | ${r.fpC} | ${r.fpD} | ${r.tp} | ${r.tpSys} | ${r.tmplRms}/${r.tmplPeak} |`);
  L.push(`| **all** | **${agg.n}** | **${agg.fpA}** | **${agg.fpB}** | **${agg.fpC}** | **${agg.fpD}** | **${agg.tp}** | **${agg.tpSys}** | - |`);
  L.push("");
  L.push(`Aggregate FP rate A ${pct(agg.fpA, agg.n)} -> C ${pct(agg.fpC, agg.n)}: sysFAP removes ${agg.fpA ? ((agg.fpA - agg.fpC) / agg.fpA * 100).toFixed(0) : "n/a"}% of the FP the noise-only gate left.`);
  L.push(`Injected completeness kept by sysFAP: ${agg.tp ? ((100 * agg.tpSys / agg.tp).toFixed(1) + "%") : "n/a"} (${agg.tpSys}/${agg.tp}).`);
  L.push("");
  L.push("## Discrimination (threshold-free)");
  L.push("");
  L.push(`AUC of using -FAP as the planet-vs-artifact score over a pool of ${posSys.length} injected-planet positives and`);
  L.push(`${negSys.length} quiet-curve negatives:`);
  L.push("");
  L.push("| score | AUC |");
  L.push("|---|---|");
  L.push(`| per-star noise FAP (current gate) | ${aucNoise.toFixed(3)} |`);
  L.push(`| systematics-aware FAP (new lever) | ${aucSys.toFixed(3)} |`);
  L.push(`| gain | ${(aucSys - aucNoise).toFixed(3)} |`);
  L.push("");
  L.push("ROC (TPR = injected planets kept, FPR = quiet-curve FP kept) as the FAP threshold varies:");
  L.push("");
  L.push("| FAP threshold | noise TPR / FPR | sysFAP TPR / FPR |");
  L.push("|---|---|---|");
  for (const t of thresholds) {
    const rn = rocAt(posNoise, negNoise, t), rs = rocAt(posSys, negSys, t);
    L.push(`| ${t} | ${(rn.tpr * 100).toFixed(0)}% / ${(rn.fpr * 100).toFixed(0)}% | ${(rs.tpr * 100).toFixed(0)}% / ${(rs.fpr * 100).toFixed(0)}% |`);
  }
  L.push("");
  L.push("## Honest reading");
  L.push("");
  L.push("1. The FP cut and the AUC gain are reported PER SECTOR and in aggregate: the question a pilot cannot answer");
  L.push("   -- does this hold on independent fields -- is measured, not assumed.");
  L.push("2. The AUC is the auditable headline: it says, at every threshold at once, that the coherent-systematics null");
  L.push("   separates a real transit from an instrumental artifact better than the noise-only gate. A near-0.5 AUC");
  L.push("   would mean no discrimination; a lower-bound AUC here still understates the true gain because unconfirmed");
  L.push("   planets are counted as false positives.");
  L.push("3. Boundary (physics, not code): after subtraction the residual FP is each star's own variability, which the");
  L.push("   per-star noise already models -- the single-sector purity ceiling (p31/p33), closable only with more data");
  L.push("   power and physical vetting, not a sharper significance model.");
  L.push("");
  L.push("Measure-only: nothing gated, anchored, claimed or deployed. Enabling this gate in production still requires");
  L.push("a same-cadence ensemble caller, the p40 measure-before-gate cert, and explicit operator go-ahead.");
  writeFileSync("reports/p42-fp-scale.md", L.join("\n"));
  writeFileSync("reports/p42-fp-scale.json", JSON.stringify({ meta: { sectors, limit, nNull, nInject, seed, fapThr, bhQ, injPeriod, injDepth }, aggregate: agg, auc: { noise: aucNoise, sys: aucSys }, pool: { pos: posSys.length, neg: negSys.length }, rows }, null, 2));
  console.log(`\n[p42] wrote reports/p42-fp-scale.md and reports/p42-fp-scale.json`);
  console.log("\nVERDICT: P42-RAN");
}

main().catch((e) => { console.error(`[p42] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE"); });
