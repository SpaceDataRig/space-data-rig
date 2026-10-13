// P38 RESEARCH BUNDLE: distill the committed research reports into ONE compact JSON the live dashboard can
// render as a static asset. The reports under reports/ are NOT reachable from the Cloudflare edge (only web/ is
// served as static assets), so this script reads them at build time and writes web/research.json, which the edge
// asset pipeline serves to the browser. It performs NO new analysis -- it only re-derives the numbers the reports
// already publish (completeness from the per-star recovery rows, purity from the TP/FP counts, the fitted compute
// exponent), so the dashboard can never drift from the committed record.
//
// Sources (all committed):
//   reports/p33-catalog.json              TypeScript iterative detector: completeness + blind purity on real stars
//   reports/p35-pdm-crosscheck.json       PDM (independent period finder): agreement + its own completeness
//   reports/crosscheck/cross-pipeline.json separate Python stack (wotan + astropy BLS): purity + completeness
//   reports/p34-cost-model.json           measured compute scaling (power law) + survey CPU-hour extrapolation
//
// Research-only: reads committed files, writes a static asset. No network, no worker import, no verdict/bundle
// hash/money path, nothing anchored or claimed. discoveryClaim stays structurally false everywhere downstream.
//
// Usage: npm run p38:research-bundle   (writes web/research.json)

import { readFileSync, writeFileSync } from "node:fs";

function load(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

const p33 = load("reports/p33-catalog.json");
const p35 = load("reports/p35-pdm-crosscheck.json");
const xc = load("reports/crosscheck/cross-pipeline.json");
const p34 = load("reports/p34-cost-model.json");
const p39 = load("reports/p39-candidates.json");
const p40 = load("reports/p40-fp-safety.json");
const p42 = load("reports/p42-fp-scale.json");
const p43 = load("reports/p43-window-alias.json");

const depths: number[] = p33.meta.depthsPpm;
const N33: number = p33.rows.length;

// completeness per depth for the TypeScript detector, re-derived from the per-star recovery flags
const completenessTS = depths.map((d) => {
  const recovered = p33.rows.filter((r: any) => r.recByDepth[String(d)] === true).length;
  return { depthPpm: d, recovered, rate: recovered / N33 };
});
const tsTP = p33.rows.reduce((a: number, r: any) => a + r.nullTP, 0);
const tsFP = p33.rows.reduce((a: number, r: any) => a + r.nullFP, 0);
const tsDets = tsTP + tsFP;

// PDM (independent period finder)
const N35: number = p35.rows.length;
const completenessPDM = depths.map((d) => {
  const recovered = p35.rows.filter((r: any) => r.pdmRecByDepth[String(d)] === true).length;
  return { depthPpm: d, recovered, rate: recovered / N35 };
});
const pdmAgreement = {
  comparable: p35.agreement.comparable,
  agree: p35.agreement.agree,
  rate: p35.agreement.comparable ? p35.agreement.agree / p35.agreement.comparable : null,
};

// separate Python stack
const xcN: number = xc.summary.curves;
const completenessPY = depths.map((d) => {
  const cell = xc.summary.blsCompletenessByDepth[String(d)];
  return { depthPpm: d, recovered: cell ? cell.recovered : 0, rate: cell ? cell.recovered / xcN : 0 };
});
const pythonValidation = {
  curves: xcN,
  nullTP: xc.summary.nullTP,
  nullFP: xc.summary.nullFP,
  purity: xc.summary.purityLowerBound,
  versions: xc.meta.versions,
  completeness: completenessPY,
};

// measured compute model
const compute = {
  exponentP: p34.fit.p,
  r2: p34.fit.r2,
  sampleN: p34.fit.n,
  singleStarDetectionSeconds: p34.measured.meanSingleDetSeconds,
  meanPointsPerStar: p34.measured.meanPoints,
  cpuHours: p34.cpuHours,
};

// false-positive control: the coherent-systematics null (P39), its scale + threshold-free AUC (P42), the
// measure-before-gate safety cert (P40), and the window-alias negative result (P43). All re-derived from the
// committed report JSON -- no new analysis, no hardcoded numbers.
const falsePositiveControl = {
  coherentNull: {
    curves: p39.raw.n,
    seed: p39.meta.seed,
    rawTemplatePeakPpm: p39.meta.rawTemplatePeakPpm,
    residualTemplateRmsPpm: p39.meta.residualTemplateRmsPpm,
    rawFpRateByGate: { snr: p39.raw.fpA / p39.raw.n, noiseFap: p39.raw.fpB / p39.raw.n, sysFap: p39.raw.fpC / p39.raw.n },
    correctedCompletenessKept: p39.corrected.tpA ? p39.corrected.tpC / p39.corrected.tpA : null,
  },
  scaleMultiSector: {
    curves: p42.aggregate.n,
    sectors: (p42.meta.sectors || []).length,
    aucNoise: p42.auc.noise,
    aucSys: p42.auc.sys,
    injectedKept: p42.aggregate.tp ? p42.aggregate.tpSys / p42.aggregate.tp : null,
    injectedKeptCount: `${p42.aggregate.tpSys}/${p42.aggregate.tp}`,
  },
  safetyCert: {
    detected: p40.detected,
    declined: p40.declined,
    safetyRatePct: p40.safetyRatePct,
    verdict: p40.verdict,
  },
  windowAlias: {
    curves: p43.meta.curvesUsed,
    dailyWindowMedian: p43.window.dailyMedian,
    dailyWindowMax: p43.window.dailyMax,
    fracCurvesWithOpenWindow: p43.window.fracDailyGt03,
    fpCount: p43.counts.fp,
    tpCount: p43.counts.tp,
  },
};

const payload = {
  schema: "sdr-research/1",
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/p38-research-bundle.ts (from committed reports/)",
  note: "Research characterization on real public TESS-SPOC photometry. These are measurements of the pipeline's " +
    "operating point and independent cross-checks -- NOT discoveries. Purity is a lower bound: a genuine but " +
    "unconfirmed planet is counted as a false positive.",
  survey: {
    label: "TypeScript iterative detector (box-fit BLS)",
    stars: N33,
    coverageMiss: p33.meta.coverageMiss,
    injPeriodDays: p33.meta.injPeriod,
    seed: p33.meta.seed,
    depthsPpm: depths,
    completeness: completenessTS,
    purity: tsDets ? tsTP / tsDets : null,
    nullTP: tsTP,
    nullFP: tsFP,
    blindDetections: tsDets,
  },
  crossValidation: {
    pdm: { label: "PDM period finder (independent algorithm)", stars: N35, agreement: pdmAgreement, completeness: completenessPDM },
    python: { label: "wotan + astropy BLS (independent stack)", ...pythonValidation },
  },
  falsePositiveControl,
  compute,
};

writeFileSync("web/research.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`wrote web/research.json`);
console.log(`  survey: ${N33} stars, purity ${tsDets ? (100 * tsTP / tsDets).toFixed(1) : "?"}% (${tsTP}TP/${tsFP}FP)`);
console.log(`  completeness TS: ${completenessTS.map((c) => (c.rate * 100).toFixed(0) + "%").join(" ")}`);
console.log(`  PDM agreement: ${pdmAgreement.agree}/${pdmAgreement.comparable}; Python purity ${pythonValidation.purity}`);
console.log(`  FP control: raw FP ${(falsePositiveControl.coherentNull.rawFpRateByGate.snr * 100).toFixed(0)}% -> ${(falsePositiveControl.coherentNull.rawFpRateByGate.sysFap * 100).toFixed(0)}% (sysFAP); AUC ${falsePositiveControl.scaleMultiSector.aucNoise.toFixed(3)} noise vs ${falsePositiveControl.scaleMultiSector.aucSys.toFixed(3)} sys; safety ${falsePositiveControl.safetyCert.declined}/${falsePositiveControl.safetyCert.detected} declined; window median ${falsePositiveControl.windowAlias.dailyWindowMedian}`);
console.log(`  compute exponent p=${compute.exponentP.toFixed(2)} (R^2=${compute.r2.toFixed(2)})`);
if (/[^\x00-\x7F]/.test(JSON.stringify(payload))) { console.log("WARNING: non-ASCII in research.json"); process.exitCode = 1; }
