// P99 (research axis 3) - PROSPECTIVE HELD-OUT BLIND VALIDATION + INDEPENDENT CORROBORATION.
//
// The rig's accepted-call metrics (README, P82/P83) are RETROSPECTIVE: the operating point (depth floor +
// multi-sector corroboration bar) was chosen while looking at the whole sample, so the published precision
// is optimistically biased by that tuning. This study upgrades the protocol to a PROSPECTIVE blind split
// using the committed, sealed-truth pool tests/fixtures/scaled/blind.jsonl -- 500 real SPOC host curves, 181
// with a hidden injected planet and 319 left null, the answer key the detector never reads. We:
//
//   (1) SPLIT deterministically by a hash of each host's TIC into TRAIN (~80%) and HELD-OUT (>=20%). The
//       held-out truth is sealed: it does not touch any tuning decision.
//   (2) TUNE the operating point on TRAIN ONLY: sweep the detection depth floor Dcut and the corroboration
//       bar minCorr, score each combo with the SAME scorer the production audit uses (src/sim/blindTest.ts
//       scoreBlindTest + Wilson), and freeze the combo that maximizes accepted-set F1.
//   (3) APPLY the frozen operating point to the HELD-OUT split with ZERO re-tuning, and record the verdict
//       distribution (accepted / needs-more-data / rejected) plus held-out recall/precision/false-accepts.
//   (4) CORROBORATE the surviving accepted candidates with two INDEPENDENT committed channels: an external
//       literature cross-match (tests/fixtures/scaled/external.jsonl: the host is an ExoFOP-validated planet)
//       and a Gaia-neighbour centroid clearance (tests/fixtures/scaled/centroid.jsonl: testable and labelled
//       planet, i.e. NOT flagged as a blend). Report the corroboration success rate per channel.
//   (5) QUANTIFY the retrospective->prospective deviation: held-out vs train recall/precision.
//
// OFFLINE + DETERMINISTIC + NO NETWORK: every input is a committed, byte-exact tracked fixture; the same
// bytes always yield the same split, tuning, verdicts and rates. The report re-hashes the three fixtures it
// consumed, so it is machine-verified with zero drift. This is a VALIDATION-METHODOLOGY measurement, NOT a
// new production gate and NOT a discovery. discoveryClaim false, safeToGate false.
//
// Usage: npm run p99:heldout-blind   [-- --holdout 20 --depth 0,300,500,800,1200 --mincorr 2,3]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";

// FORWARD-SLASH paths: readFileSync accepts them on every OS, and buildStamp must emit them so the
// freshness gate's `git ls-files` provenance check matches the tracked blobs (backslashes read fine but
// are not recognized by git on the tracked-path comparison -> false "untracked").
const BLIND = "tests/fixtures/scaled/blind.jsonl";
const EXTERNAL = "tests/fixtures/scaled/external.jsonl";
const CENTROID = "tests/fixtures/scaled/centroid.jsonl";

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit && Number.isFinite(Number(hit.split("=")[1]))) return Number(hit.split("=")[1]);
  return dflt;
}
function argList(name: string, dflt: number[]): number[] {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1].split(",").map(Number).filter(Number.isFinite);
  return dflt;
}
// stable, order-independent FNV-1a over the TIC digits -> [0,100) bucket; identical on every machine/run.
function bucket(tic: number): number {
  let h = 2166136261;
  const s = String(tic);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100;
}

interface Curve { tic: number; truth: Truth; dets: Detection[]; }
function loadPool(): Curve[] {
  const rows = readFileSync(BLIND, "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const out: Curve[] = [];
  for (const r of rows) {
    if (!r.truth) continue;
    const dets = (Array.isArray(r.dets) ? r.dets : []) as Detection[];
    out.push({ tic: r.tic, truth: r.truth as Truth, dets });
  }
  return out;
}
function loadTicSet(file: string, pred: (r: any) => boolean): Set<number> {
  if (!existsSync(file)) return new Set();
  const set = new Set<number>();
  for (const l of readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n").filter((x) => x.trim())) {
    try { const r = JSON.parse(l); if (pred(r)) set.add(r.tic); } catch { /* skip */ }
  }
  return set;
}

// apply a depth floor to the raw detections of one curve (the detector-side veto; the corroboration bar is
// applied by scoreBlindTest). Returns the curve's surviving detections at this floor.
function filterDets(dets: Detection[], depthFloor: number): Detection[] {
  return dets.filter((d) => (d.depthPpm ?? 0) >= depthFloor);
}

interface OpResult { depth: number; minCorr: number; accepted: number; acceptedTp: number; falseAccepts: number;
  needsMoreData: number; acceptedPrecision: number; acceptedRecall: number; f1: number; recall: number; precision: number; }
// Score a set of curves at one operating point with the PRODUCTION scorer. Truth is included so the
// confusion matrix is complete; only this split's curves contribute detections.
function scoreSplit(curves: Curve[], depthFloor: number, minCorr: number): OpResult {
  const truth: Truth[] = curves.map((c) => c.truth);
  const dets: Detection[] = curves.flatMap((c) => filterDets(c.dets, depthFloor));
  const s = scoreBlindTest(truth, dets, { minCorroboration: minCorr });
  const acceptedRecall = s.nInjected > 0 ? s.acceptedTp / s.nInjected : NaN;
  const f1 = s.acceptedPrecision > 0 && acceptedRecall > 0 ? (2 * s.acceptedPrecision * acceptedRecall) / (s.acceptedPrecision + acceptedRecall) : 0;
  return { depth: depthFloor, minCorr, accepted: s.accepted, acceptedTp: s.acceptedTp, falseAccepts: s.falseAccepts,
    needsMoreData: s.needsMoreData, acceptedPrecision: s.acceptedPrecision, acceptedRecall, f1, recall: s.recall, precision: s.precision };
}

// per-curve prospective verdict at the operating point (accepted / needs-more-data / rejected).
function verdictOf(c: Curve, depthFloor: number, minCorr: number): "accepted" | "needs-more-data" | "rejected" {
  const surv = filterDets(c.dets, depthFloor);
  if (surv.some((d) => (d.corroboratedSectors ?? 1) >= minCorr)) return "accepted";
  if (surv.length > 0) return "needs-more-data";
  return "rejected";
}

function main(): void {
  const holdoutPct = argNum("holdout", 25);
  const depthGrid = argList("depth", [0, 300, 500, 800, 1200]);
  const corrGrid = argList("mincorr", [2, 3]);
  const periodTol = 0.02;

  const pool = loadPool();
  if (pool.length < 50) { console.log(`P99: only ${pool.length} sealed curves. VERDICT: NO-POOL`); process.exitCode = 1; return; }

  // (1) deterministic split by TIC hash bucket
  const train: Curve[] = [], held: Curve[] = [];
  for (const c of pool) (bucket(c.tic) < holdoutPct ? held : train).push(c);
  const injTrain = train.filter((c) => c.truth.injected).length, injHeld = held.filter((c) => c.truth.injected).length;
  console.log(`P99 prospective held-out blind: pool ${pool.length} (sealed truth) -> train ${train.length} (${injTrain} injected) / held-out ${held.length} (${injHeld} injected, ${(100 * held.length / pool.length).toFixed(1)}%). Offline, deterministic, discoveryClaim false.`);

  // (2) TUNE on TRAIN only -- full transparent grid, freeze the argmax-F1 operating point
  const grid: OpResult[] = [];
  let best: OpResult | null = null;
  for (const depth of depthGrid) for (const minCorr of corrGrid) {
    const r = scoreSplit(train, depth, minCorr);
    grid.push(r);
    const better = !best || r.f1 > best.f1
      || (r.f1 === best.f1 && r.falseAccepts < best.falseAccepts)
      || (r.f1 === best.f1 && r.falseAccepts === best.falseAccepts && r.acceptedTp > best.acceptedTp);
    if (better && r.acceptedTp >= 1) best = r;
  }
  if (!best) { console.log("P99: no operating point recovered any accepted true planet on train. VERDICT: NO-TUNE-POINT"); process.exitCode = 1; return; }
  const D = best.depth, C = best.minCorr;
  console.log(`  TUNED on train: depth floor ${D} ppm, corroboration bar ${C} sectors -> train accepted-F1 ${(best.f1 * 100).toFixed(1)}% (accepted ${best.accepted}, acceptedTP ${best.acceptedTp}, false-accepts ${best.falseAccepts}).`);

  // (3) APPLY to HELD-OUT with ZERO re-tuning
  const heldScore = scoreSplit(held, D, C);
  const sHeld = (() => { const truth = held.map((c) => c.truth); const dets = held.flatMap((c) => filterDets(c.dets, D)); return scoreBlindTest(truth, dets, { minCorroboration: C }); })();
  const verdictDist = { accepted: 0, "needs-more-data": 0, rejected: 0 } as Record<string, number>;
  const survivors: Curve[] = [];
  for (const c of held) { const v = verdictOf(c, D, C); verdictDist[v]++; if (v !== "rejected") survivors.push(c); }

  // (4) INDEPENDENT corroboration of survivors (two committed external channels)
  const litSet = loadTicSet(EXTERNAL, (r) => r.disp === "KP" || r.disp === "CP");
  const litValidatedSet = loadTicSet(EXTERNAL, (r) => (r.disp === "KP" || r.disp === "CP") && r.validated === true);
  const gaiaPlanetSet = loadTicSet(CENTROID, (r) => r.testable === true && r.label === "planet");
  let litHit = 0, litValidatedHit = 0, gaiaHit = 0, anyHit = 0;
  const survivorRows = survivors.map((c) => {
    const lit = litSet.has(c.tic), litV = litValidatedSet.has(c.tic), gaia = gaiaPlanetSet.has(c.tic);
    if (lit) litHit++; if (litV) litValidatedHit++; if (gaia) gaiaHit++; if (lit || gaia) anyHit++;
    return { tic: c.tic, truth: c.truth, literatureMatch: lit, literatureValidated: litV, gaiaClearedPlanet: gaia, corroborated: lit || gaia };
  });
  const corrRate = survivors.length > 0 ? anyHit / survivors.length : NaN;
  const survivorTruePositiveRate = survivors.length > 0 ? survivors.filter((c) => c.truth.injected).length / survivors.length : NaN;

  // (5) retrospective -> prospective deviation
  const recallDev = heldScore.recall - best.recall;
  const precisionDev = heldScore.precision - best.precision;

  const heldPrecisionCI = wilsonInterval(sHeld.tp, sHeld.tp + sHeld.fp);
  const heldRecallCI = wilsonInterval(sHeld.tp, sHeld.nInjected);
  const prospectiveHolds = Math.abs(recallDev) < 0.15 && Math.abs(precisionDev) < 0.15 && sHeld.falseAccepts <= Math.max(1, Math.round(0.05 * survivors.length));
  const verdict = `P99-PROSPECTIVE-HELDOUT-${prospectiveHolds ? "CONSISTENT" : "DIVERGENT"}`
    + ` (tuned on train at ${D}ppm/${C}-sector; applied BLIND to ${held.length} held-out curves: recall ${(100 * heldScore.recall).toFixed(1)}% [dev ${(100 * recallDev).toFixed(1)}pp vs train], precision ${(100 * heldScore.precision).toFixed(1)}% [dev ${(100 * precisionDev).toFixed(1)}pp], ${sHeld.falseAccepts} false-accepts;`
    + ` ${survivors.length} survivors, ${anyHit} independently corroborated (${(100 * corrRate).toFixed(0)}%)`
    + ` via literature ${litHit} + Gaia-cleared ${gaiaHit}; ${prospectiveHolds ? "the held-out metrics track the tuning set -- the operating point is not over-fit" : "held-out diverges -- the tuned point was optimistic (retrospective bias quantified)"})`;

  const stamp = buildStamp(["scripts/p99-prospective-heldout-blind.ts", BLIND, EXTERNAL, CENTROID]);
  const json = {
    meta: {
      generatedBy: "scripts/p99-prospective-heldout-blind.ts (offline deterministic prospective split; sealed truth never read for tuning)",
      data: "committed byte-exact sealed-truth blind pool + external literature cross-match + Gaia-centroid neighbour clearance",
      module: "src/sim/blindTest.ts scoreBlindTest + src/sim/completenessGrid.ts wilsonInterval",
      params: { holdoutPct, depthGrid, corrGrid, periodTol, tunedDepth: D, tunedMinCorr: C },
      split: { pool: pool.length, train: train.length, trainInjected: injTrain, held: held.length, heldInjected: injHeld, heldFracPct: Number((100 * held.length / pool.length).toFixed(2)) },
      generatedAt: stamp.generatedAt, gitSha: stamp.gitSha, inputs: stamp.inputs,
    },
    tuningGridTrain: grid,
    trainBest: best,
    heldOut: {
      ...heldScore,
      verdictDistribution: verdictDist,
      recall: sHeld.recall, recallCI: heldRecallCI, precision: sHeld.precision, precisionCI: heldPrecisionCI,
      falseAccepts: sHeld.falseAccepts, needsMoreData: sHeld.needsMoreData, accepted: sHeld.accepted, acceptedTp: sHeld.acceptedTp,
      survivorCount: survivors.length, survivorTruePositiveRate,
      corroboration: { literatureMatch: litHit, literatureValidated: litValidatedHit, gaiaClearedPlanet: gaiaHit, anyChannel: anyHit, rate: corrRate, survivors: survivorRows },
    },
    deviation: { recallPp: Number((100 * recallDev).toFixed(2)), precisionPp: Number((100 * precisionDev).toFixed(2)) },
    verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p99-prospective-heldout-blind.json", JSON.stringify(json, null, 2) + "\n");

  const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "n/a");
  const ci = (a: [number, number]) => `[${(100 * a[0]).toFixed(0)},${(100 * a[1]).toFixed(0)}]`;
  const md = [
    "# P99 Prospective held-out blind validation + independent corroboration",
    "",
    "Reproduce: `npm run p99:heldout-blind` (offline, deterministic; every input is a committed byte-exact",
    "sealed-truth fixture). This upgrades the rig's RETROSPECTIVE operating point to a PROSPECTIVE blind split,",
    "the held-out truth is sealed and never touches tuning. A validation-METHODOLOGY measurement, NOT a new",
    "gate and NOT a discovery. discoveryClaim:false, safeToGate:false.",
    "",
    "## 1. Deterministic split (sealed-truth pool = committed blind.jsonl)",
    "",
    `Pool ${pool.length} real SPOC host curves (${injTrain + injHeld} injected / ${pool.length - injTrain - injHeld} null), split by a`,
    "stable FNV-1a hash of each TIC. Held-out truth is sealed from every tuning decision below.",
    "",
    `- TRAIN ${train.length} (${injTrain} injected)  |  HELD-OUT ${held.length} (${injHeld} injected) = ${(100 * held.length / pool.length).toFixed(1)}% (>= 20% required)`,
    "",
    "## 2. Operating point tuned on TRAIN only (full grid, frozen argmax accepted-F1)",
    "",
    "| depth floor | bar | accepted | accTP | false-acc | accepted-prec | accepted-rec | F1 |",
    "|---|---|---|---|---|---|---|---|",
    ...grid.map((r) => `| ${r.depth} ppm | ${r.minCorr} | ${r.accepted} | ${r.acceptedTp} | ${r.falseAccepts} | ${pct(r.acceptedPrecision)} | ${pct(r.acceptedRecall)} | ${pct(r.f1)}${r.depth === D && r.minCorr === C ? " <= FROZEN" : ""} |`),
    "",
    `Frozen point: depth floor ${D} ppm, corroboration bar ${C} sectors (train accepted-F1 ${pct(best.f1)}).`,
    "",
    "## 3. Held-out applied with ZERO re-tuning",
    "",
    `- verdict distribution: ${verdictDist.accepted} accepted / ${verdictDist["needs-more-data"]} needs-more-data / ${verdictDist.rejected} rejected`,
    `- held-out recall ${pct(sHeld.recall)} CI ${ci(heldRecallCI)}; precision ${pct(sHeld.precision)} CI ${ci(heldPrecisionCI)}; false-accepts ${sHeld.falseAccepts}`,
    `- accepted-under-bar ${sHeld.accepted} (of which acceptedTP ${sHeld.acceptedTp}); needs-more-data capped ${sHeld.needsMoreData}`,
    "",
    "## 4. Independent corroboration of survivors",
    "",
    `Survivors (held-out curves accepted OR needs-more-data at the frozen point): ${survivors.length}; of these ${survivorTruePositiveRate.toFixed(2)} fraction are truly injected`,
    "(the honest held-out precision of the SURVIVOR class). Two INDEPENDENT committed channels:",
    "",
    `- literature cross-match (ExoFOP-validated external.jsonl): ${litHit} survivors match a confirmed host (${litValidatedHit} validated).`,
    `- Gaia-neighbour centroid clearance (centroid.jsonl testable & labelled planet, i.e. not a blend): ${gaiaHit}.`,
    `- ANY independent channel corroborated: ${anyHit}/${survivors.length} = ${pct(corrRate)}.`,
    "",
    "## 5. Retrospective -> prospective deviation",
    "",
    `Held-out recall differs from the tuning set by ${(100 * recallDev).toFixed(1)} percentage points and precision by ${(100 * precisionDev).toFixed(1)}pp.`,
    "A small deviation says the tuned operating point generalizes; a large one exposes retrospective optimism",
    "(the metric the earlier single-sample reports could not, because they tuned and scored on the same curves).",
    "",
    "## Reading (honest)",
    "",
    "This is a prospective test of the METHOD on a committed sealed-truth fixture, so the answer key is real",
    "but the injected planets are synthetic transits on real host curves (the sanctioned P49/P82 protocol) -- it",
    "calibrates tuning-vs-generalization bias and the corroboration yield, it does not validate against a live",
    "unconfirmed candidate list. The corroboration channels only cover hosts already in the confirmed/Gaia",
    "fixtures, so a low survivor count caps the corroboration-rate precision; all ceilings are stated.",
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "A validation METHODOLOGY, not a deployed gate. discoveryClaim:false; safeToGate:false.",
    "",
  ].join("\n");
  writeFileSync("reports/p99-prospective-heldout-blind.md", md);
  console.log(`[P99] held-out recall ${pct(sHeld.recall)} (dev ${(100 * recallDev).toFixed(1)}pp), precision ${pct(sHeld.precision)} (dev ${(100 * precisionDev).toFixed(1)}pp), false-accepts ${sHeld.falseAccepts}; survivors ${survivors.length}, corroborated ${anyHit} (${pct(corrRate)}).`);
  console.log(`[P99] VERDICT: ${verdict}`);
  console.log("[P99] wrote reports/p99-prospective-heldout-blind.{json,md}");
}

main();
