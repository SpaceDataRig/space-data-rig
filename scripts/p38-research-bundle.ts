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
const p44 = load("reports/p44-diff-imaging.json");
const p53 = load("reports/p53-psf-diff-imaging.json");
const p45 = load("reports/p45-fp-probability.json");
const p46 = load("reports/p46-coherence.json");
const p47 = load("reports/p47-completeness-grid.json");
const p49 = load("reports/p49-blind-test.json");
const p50 = load("reports/p50-replay.json");
const p51 = load("reports/p51-crowding-stratified.json");
const p52 = load("reports/p52-negative-class.json");

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
  pixelVetting: {
    label: "difference-imaging localization vs the full-aperture centroid shift (P44)",
    confirmedPlanets: p44.n,
    diffImageOffsetMedianArcsec: p44.offsetArcsec.p50,
    diffImageOffsetMaxArcsec: p44.offsetArcsec.max,
    diffImageSnrMedian: p44.dropSnr.p50,
    falseKillsAt2Arcsec: (p44.thresholdSweep.find((s: any) => s.thresholdArcsec === 2.0) || { falseKills: null }).falseKills,
    centroidShiftMaxArcsec: p44.legacyShiftMaxArcsec,
    safeToGate: p44.safeToGate,
  },
  psfDoubleDifference: {
    label: "PSF-model double-difference imaging vs the naive centroid (P53, roadmap priority 2)",
    confirmedPlanets: p53.n,
    psfFalseKillsAt2Arcsec: (p53.psfSweep.find((s: any) => s.thresholdArcsec === 2.0) || { falseKills: null }).falseKills,
    naiveFalseKillsAt2Arcsec: p53.naiveFalseKillsAt2Arcsec,
    psfOffsetMedianArcsec: p53.psfOffsetArcsec.p50,
    onTargetCalls: p53.psfVerdictCounts.onTarget,
    offTargetCalls: p53.psfVerdictCounts.offTarget,
    inconclusiveCalls: p53.psfVerdictCounts.inconclusive,
    centroidShiftMaxArcsec: p53.legacyShiftMaxArcsec,
    powerUnproven: p53.powerUnproven,
    safeToGate: p53.safeToGate,
    discoveryClaim: false,
  },
  blendProbability: {
    label: "measured-Gaia blended-EB false-positive probability (P45)",
    confirmedPlanets: p45.n,
    pfpMedian: p45.pFalsePositive.p50,
    pfpMax: p45.pFalsePositive.max,
    realPlanetsAboveHalf: p45.highFpCount,
    withViableBlend: p45.withViableBlend,
    safeToGate: p45.safeToGate,
  },
  coherenceSelector: {
    label: "multi-year O-C coherence as a period selector (P46)",
    hosts: p46.n,
    trueCoherenceMedian: p46.trueCoherenceMedian,
    trueCoherenceHighCount: p46.trueCoherenceHighCount,
    rawMatchCount: p46.rawMatchCount,
    coherenceRankMatchCount: p46.coherenceRankMatchCount,
    safeToGate: p46.safeToGate,
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
  replayDeterminism: {
    label: "end-to-end deterministic replay from raw public S3 bytes (P50)",
    target: p50.target.name,
    byteLength: p50.target.byteLength,
    replayHash: p50.replayHash,
    inProcessStable: p50.inProcessStable,
    reDownloadMatch: p50.reDownloadReplayHashMatch,
    independentRecomputeOk: p50.independentRecomputeOk,
    allDeterministic: p50.allDeterministic,
    discoveryClaim: false,
  },
  blendVetoAcceptance: {
    label: "crowding-stratified blend-veto acceptance re-check (P51, reviewer follow-up)",
    nTotal: p51.nRows,
    nCrowded: (p51.crowdingOfSample.find((x: any) => x.bin === "crowded") || { n: 0 }).n,
    pfpMedianCrowded: (p51.stratified.find((x: any) => x.bin === "crowded") || { pfpMedian: null }).pfpMedian,
    localized: p51.totalLocalized,
    falseKills: p51.totalFalseKills,
    negativeClassExoFop: p51.negativeClass.exofop.reachable,
    negativeClassVizieR: p51.negativeClass.vizierEb.reachable,
    safeToGate: false,
    discoveryClaim: false,
  },
  negativeClassFeasibility: {
    label: "labelled-negative-class feasibility from public data (P52)",
    usableNegatives: p52.usableNegatives,
    gcvsEclipsingBinaries: p52.gcvsList.eclipsingBines,
    exofopReachable: p52.exofopReachable,
    constructible: p52.constructible,
    safeToGate: false,
    discoveryClaim: false,
  },
  detectionEfficiency: {
    label: "2-D period x depth completeness map on real light curves (P47)",
    nHosts: p47.meta.nHosts,
    totalInjections: p47.totalInjections,
    periodBinsReaching50: p47.periodBinsReaching50,
    thresholdDepth50: p47.thresholdDepth50,
    selectionFunction: p47.meta.selectionFunction,
    discoveryClaim: false,
  },
  blindTest: {
    label: "sealed-key blind test of the detector on real curves (P49)",
    curves: p49.curves,
    injected: p49.injected,
    nullCurves: p49.null,
    detections: p49.detections,
    recall: p49.raw.recall,
    recallCI: p49.raw.recallCI,
    precision: p49.raw.precision,
    precisionCI: p49.raw.precisionCI,
    fpPerNullCurve: p49.raw.fpPerNullCurve,
    acceptedUnderBar: p49.capped.accepted,
    falseAcceptsUnderBar: p49.capped.falseAccepts,
    discoveryClaim: false,
  },
  compute,
};

writeFileSync("web/research.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`wrote web/research.json`);
console.log(`  survey: ${N33} stars, purity ${tsDets ? (100 * tsTP / tsDets).toFixed(1) : "?"}% (${tsTP}TP/${tsFP}FP)`);
console.log(`  completeness TS: ${completenessTS.map((c) => (c.rate * 100).toFixed(0) + "%").join(" ")}`);
console.log(`  PDM agreement: ${pdmAgreement.agree}/${pdmAgreement.comparable}; Python purity ${pythonValidation.purity}`);
console.log(`  FP control: raw FP ${(falsePositiveControl.coherentNull.rawFpRateByGate.snr * 100).toFixed(0)}% -> ${(falsePositiveControl.coherentNull.rawFpRateByGate.sysFap * 100).toFixed(0)}% (sysFAP); AUC ${falsePositiveControl.scaleMultiSector.aucNoise.toFixed(3)} noise vs ${falsePositiveControl.scaleMultiSector.aucSys.toFixed(3)} sys; safety ${falsePositiveControl.safetyCert.declined}/${falsePositiveControl.safetyCert.detected} declined; window median ${falsePositiveControl.windowAlias.dailyWindowMedian}`);
console.log(`  pixel vetting (P44): diff-image offset median ${falsePositiveControl.pixelVetting.diffImageOffsetMedianArcsec}" on ${falsePositiveControl.pixelVetting.confirmedPlanets} confirmed planets, safeToGate=${falsePositiveControl.pixelVetting.safeToGate}`);
console.log(`  PSF double-difference (P53): false-kills ${falsePositiveControl.psfDoubleDifference.psfFalseKillsAt2Arcsec}/${falsePositiveControl.psfDoubleDifference.confirmedPlanets} vs naive ${falsePositiveControl.psfDoubleDifference.naiveFalseKillsAt2Arcsec}, safeToGate=${falsePositiveControl.psfDoubleDifference.safeToGate}, powerUnproven=${falsePositiveControl.psfDoubleDifference.powerUnproven}`);
console.log(`  compute exponent p=${compute.exponentP.toFixed(2)} (R^2=${compute.r2.toFixed(2)})`);
if (/[^\x00-\x7F]/.test(JSON.stringify(payload))) { console.log("WARNING: non-ASCII in research.json"); process.exitCode = 1; }
