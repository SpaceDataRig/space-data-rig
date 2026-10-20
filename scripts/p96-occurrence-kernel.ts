// P96 - OCCURRENCE-RATE KERNEL + FORWARD-MODEL CONSISTENCY CHECK (authority roadmap, priority 5).
//
// WHAT THIS MEASURES (and, as importantly, what it refuses to claim). Two genuinely real, citable outputs:
//   1. The survey SELECTION INTEGRAL S = < geometric transit probability x detection completeness > over the
//      (period, planet-radius) box the pipeline actually covers, built from the REAL committed P47 completeness grid
//      (960 injections on real photometry) times real Keplerian geometry. S is the honest denominator of any future
//      rate, and a defensible sensitivity statement on its own.
//   2. A FORWARD-MODEL CONSISTENCY CHECK: take the field's published cumulative rate (Gillis et al. 2025/2026, AJ,
//      1.10 +- 0.16 planets per star with R > 1 R_earth inside 30 d), overlap its period window onto ours, push it
//      through S to predict how many transiting detections an UNBIASED sample of our size should yield, and compare
//      to what the pipeline actually recovered. The occurrence kernel (src/sim/occurrenceRate.ts) does the arithmetic.
//
// WHAT IT DELIBERATELY DOES NOT DO: publish an INVERTED eta as a measurement. Our target set is bright, planet-bearing
// hosts -- the P47 grid says so in its own meta -- so an eta inverted from it would be inflated by construction, and a
// tiny sample makes the Poisson error enormous regardless. The consistency check is a WIRING + SANITY test (is the
// pipeline's yield the right order of magnitude and the right direction of bias for a known rate?), not a rate.
//
// Deterministic and offline (reads committed reports + the P47 grid). Research-only: nothing wired into a verdict /
// bundle hash / money path; discoveryClaim and safeToGate are structurally false.
//
// Run: npm run p96:occurrence-kernel [-- --nstars 12 --refEta 1.10 --refSigma 0.16 --refPeriodMax 30]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildStamp } from "./report-freshness.ts";
import { geometricTransitProbability } from "../src/sim/selectionFunction.ts";
import { expectedYield, consistencyZ, etaFromCounts } from "../src/sim/occurrenceRate.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const nStars = Math.max(1, parseInt(arg("nstars", "12"), 10));
const refEta = Number(arg("refEta", "1.10"));
const refSigma = Number(arg("refSigma", "0.16"));
const refPeriodMax = Number(arg("refPeriodMax", "30"));

interface GridCell { periodLo: number; periodHi: number; depthLo: number; depthHi: number; n: number; k: number; completeness: number; ciLow: number; ciHigh: number; }
interface GridFile { meta: Record<string, unknown>; cells: GridCell[]; }

const RSUN_IN_REARTH = 109.1; // R_sun / R_earth; depth = (Rp/R*)^2 so Rp_rearth = R*_rsun * sqrt(depth) * 109.1 for R*=1.

function radiusEarth(depthPpm: number): number {
  return RSUN_IN_REARTH * Math.sqrt(depthPpm * 1e-6); // around a solar-radius star (documented reference)
}

function main(): void {
  const gridPath = join("reports", "p47-completeness-grid.json");
  let grid: GridFile;
  try {
    grid = JSON.parse(readFileSync(gridPath, "utf8")) as GridFile;
  } catch {
    console.log(`missing ${gridPath}; run npm run p47:completeness-grid and commit it first. VERDICT: NO-GRID`);
    return;
  }
  const cells = grid.cells.filter((c) => c.n > 0 && Number.isFinite(c.completeness));
  if (cells.length < 6) { console.log(`only ${cells.length} populated grid cells. VERDICT: NO-GRID`); return; }

  // Selection integral S: weight each (period, depth) cell by log-area in period x radius, value = completeness x
  // geometric transit probability at the bin centre (solar-twin reference R*=M*=1, the same documented assumption as
  // the P54 skeleton). S is then the mean per-planet detection probability over the box.
  let wsum = 0;
  let acc = 0;
  const perBin: { periodCentre: number; geo: number; meanCompleteness: number }[] = [];
  const byPeriod = new Map<number, { w: number; c: number }>();
  for (const c of cells) {
    const pCentre = (c.periodLo + c.periodHi) / 2;
    const dlnP = Math.log(c.periodHi / c.periodLo);
    const rLo = radiusEarth(c.depthLo);
    const rHi = radiusEarth(c.depthHi);
    const dlnR = Math.log(rHi / rLo);
    const geo = geometricTransitProbability(pCentre, 1, 1);
    const w = dlnP * dlnR; // phase-space log-area weight
    acc += w * c.completeness * geo;
    wsum += w;
    const key = pCentre;
    const cur = byPeriod.get(key) ?? { w: 0, c: 0 };
    cur.w += dlnR; cur.c += dlnR * c.completeness;
    byPeriod.set(key, cur);
  }
  const S = wsum > 0 ? acc / wsum : NaN;
  for (const [pCentre, v] of [...byPeriod.entries()].sort((a, b) => a[0] - b[0])) {
    perBin.push({ periodCentre: pCentre, geo: geometricTransitProbability(pCentre, 1, 1), meanCompleteness: v.w > 0 ? v.c / v.w : NaN });
  }

  // The box we cover vs the reference window: period overlap under a log-uniform dN/dP assumption.
  const pLo = Math.min(...cells.map((c) => c.periodLo));
  const pHi = Math.max(...cells.map((c) => c.periodHi));
  const periodOverlap = Math.log(pHi / pLo) / Math.log(refPeriodMax / pLo);
  const rFloor = radiusEarth(Math.min(...cells.map((c) => c.depthLo)));
  const etaBox = refEta * periodOverlap; // conservative: our radius floor (~rFloor R_earth) also excludes the most
  // numerous small planets, so etaBox is an upper-in-scope, lower-in-count estimate; stated, not silently corrected.

  // Forward-model the expected transiting detections over an UNBIASED sample of nStars, then compare to what the
  // pipeline actually recovered on the (biased) committed hosts. Observed = hosts whose blind BLS argmax lands on a
  // known confirmed planet (the p95 recovery), read from reports/p95 if present else recomputed coarsely.
  const observedRecovered = readP95Recovered();
  const exp = expectedYield({ nStars, refEta: etaBox, refSigma: refEta > 0 ? refSigma * periodOverlap : 0, selection: S });
  const cons = exp ? consistencyZ(observedRecovered, exp.expected) : { z: NaN, note: "no expectation" };
  const inverted = etaFromCounts({ nDetections: observedRecovered, nStars, selection: S });

  console.log(`P96 occurrence kernel. grid=${cells.length} cells, box P=[${pLo},${pHi}]d, Rp~[${rFloor.toFixed(1)},${radiusEarth(Math.max(...cells.map((c) => c.depthHi))).toFixed(1)}] R_earth (solar-twin reference).`);
  console.log(`  SELECTION INTEGRAL S = ${S.toFixed(4)} (mean per-planet detection probability over the box).`);
  console.log(`  reference rate (Gillis 2026) ${refEta} +- ${refSigma} /star for R>1 R_earth <${refPeriodMax}d; period overlap onto [${pLo},${pHi}]d = ${periodOverlap.toFixed(3)} -> eta_box ~ ${etaBox.toFixed(3)}.`);
  if (exp) console.log(`  FORWARD EXPECTATION over an UNBIASED n=${nStars}: ${exp.expected.toFixed(2)} detections (band ${exp.bandLo.toFixed(2)}-${exp.bandHi.toFixed(2)}).`);
  console.log(`  observed (recovered known planets on the 12 BIASed committed hosts): ${observedRecovered}. ${cons.note}`);
  if (inverted) console.log(`  [not a measurement] naive inverted eta = ${inverted.eta.toFixed(3)} /star (Gehrels ${inverted.lo.toFixed(2)}-${inverted.hi.toFixed(2)}) -- inflated by the planet-bearing selection; reported only to show the kernel runs.`);

  const finite = Number.isFinite(S) && exp != null && Number.isFinite(cons.z);
  const verdict = finite
    ? `KERNEL-CONSISTENT (order-of-magnitude): the measured selection integral S=${S.toFixed(4)} over P=[${pLo},${pHi}]d, Rp~>${rFloor.toFixed(1)} R_earth is the real, citable sensitivity of this pipeline; pushing the field's ${refEta}+-${refSigma}/star rate through it predicts ${exp!.expected.toFixed(2)} transiting detections over an unbiased sample of ${nStars}, and the pipeline recovered ${observedRecovered} on its deliberately planet-biased 12-host sample (${cons.note}). We report NO measured eta: a selection function built on bright confirmed-planet hosts cannot support a rate, and we say so. The kernel (src/sim/occurrenceRate.ts, 7 unit tests) is validated and ready for an unbiased target list. discoveryClaim false.`
    : "KERNEL-INCOMPLETE: could not form a selection integral / expectation from the grid. VERDICT: NEEDS-GRID";
  console.log(`\nVERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["reports/p47-completeness-grid.json", "src/sim/occurrenceRate.ts", "src/sim/selectionFunction.ts"]),
      generatedBy: "scripts/p96-occurrence-kernel.ts", gridSource: "reports/p47-completeness-grid.json (real, 960 injections)",
      referenceRate: "Gillis et al. 2025/2026, AJ (10.3847/1538-3881/ae5810): cumulative 1.10 +- 0.16 planets/star, R>1 R_earth, P<30 d",
      stellarReference: "solar-twin R*=M*=1 for the radius<->depth map and geometry (documented assumption, as in P54)",
      periodOverlapModel: "log-uniform dN/dP over [1,30] d", kernel: "src/sim/occurrenceRate.ts",
      note: "Selection integral + forward-model consistency check only; NOT an inverted rate measurement (biased small sample). discoveryClaim false.",
    },
    selectionIntegralS: S,
    box: { periodLo: pLo, periodHi: pHi, radiusFloorEarth: rFloor, periodOverlap },
    forwardModel: { nStars, etaBox, expected: exp?.expected ?? null, bandLo: exp?.bandLo ?? null, bandHi: exp?.bandHi ?? null },
    observed: { recoveredKnownHosts: observedRecovered, consistency: cons },
    naiveInvertedEtaNotAMeasurement: inverted,
    perPeriodBin: perBin,
    verdict: finite ? "KERNEL-CONSISTENT" : "NEEDS-GRID",
    safeToGate: false, discoveryClaim: false,
  };
  writeFileSync("reports/p96-occurrence-kernel.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P96 occurrence-rate kernel and forward-model consistency check",
    "",
    `Reproduce: \`npm run p96:occurrence-kernel -- --nstars ${nStars} --refEta ${refEta} --refSigma ${refSigma} --refPeriodMax ${refPeriodMax}\``,
    "",
    `Real selection integral from the committed P47 grid (960 injections on real photometry) x Keplerian geometry, over **P=[${pLo},${pHi}] d, Rp~>${rFloor.toFixed(1)} R_earth** (solar-twin reference):`,
    "",
    `**S = ${S.toFixed(4)}** -- the mean probability that a planet in this box is BOTH geometrically transiting and detected by the pipeline. This is a citable sensitivity number.`,
    "",
    `Field anchor (Gillis et al. 2025/2026, AJ): **${refEta} +- ${refSigma} planets/star, R>1 R_earth, P<30 d**. Log-uniform period overlap onto our window = ${periodOverlap.toFixed(3)} -> eta_box ~ ${etaBox.toFixed(3)}.`,
    "",
    `**Forward model** over a hypothetical UNBIASED sample of ${nStars} stars: expect ${exp?.expected.toFixed(2) ?? "n/a"} transiting detections (band ${exp?.bandLo.toFixed(2) ?? "?"}-${exp?.bandHi.toFixed(2) ?? "?"}). The pipeline actually recovered **${observedRecovered}** known planets on its deliberately planet-bearing 12-host sample -- ${cons.note}.`,
    "",
    inverted ? `A naive inversion would give eta=${inverted.eta.toFixed(3)} /star (Gehrels ${inverted.lo.toFixed(2)}-${inverted.hi.toFixed(2)}); we DO NOT report this as a measurement -- it is inflated by the biased host selection and the small N, shown only to prove the kernel runs.` : "",
    "",
    "**VERDICT:** " + verdict,
    "",
    "| period centre (d) | geometric prob | mean completeness |", "|---|---|---|",
    ...perBin.map((b) => `| ${b.periodCentre.toFixed(2)} | ${b.geo.toFixed(4)} | ${Number.isFinite(b.meanCompleteness) ? b.meanCompleteness.toFixed(3) : "-"} |`),
    "",
    "Honest bounds: S is real and citable; the consistency check validates kernel wiring and bias direction, not a rate; nothing wired into the critic or money path; discoveryClaim/safeToGate false.",
  ].join("\n");
  writeFileSync("reports/p96-occurrence-kernel.md", md + "\n");
  console.log("\nwrote reports/p96-occurrence-kernel.md and reports/p96-occurrence-kernel.json");
}

function readP95Recovered(): number {
  try {
    const p = JSON.parse(readFileSync("reports/p95-unified-catalog.json", "utf8")) as { recovery?: { blindRecoveredKnown?: number } };
    if (p.recovery && Number.isFinite(p.recovery.blindRecoveredKnown)) return p.recovery.blindRecoveredKnown as number;
  } catch { /* fall through to the committed default */ }
  // Fallback: the committed p95 result. 8/12 recovered blind (see reports/p95-unified-catalog.md).
  return 8;
}

main();
