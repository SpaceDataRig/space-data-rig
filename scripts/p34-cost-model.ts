// P34 - MEASURED COMPUTE / COST MODEL FOR SCALING THE SURVEY (grounded in p33, reproducible).
//
// WHY. Problem-3 of the roadmap asks for a compute spec and cost plan to reach a thousands-star public
// candidate catalog, and the operator has earmarked compute budget. p33 MEASURED per-curve detector
// wall-clock on 33 real curves; p34 turns those measurements into a defensible scaling model instead of a
// guess. The headline empirical finding is that detector cost scales as a POWER LAW in the number of
// photometric points, perCurveMs ~= k * nPoints^p with p ~= 2.94 (near-cubic): BLS over a fine period grid
// on a stitched baseline is superlinear, the iterative mask-and-refind runs it several times, and the
// completeness calibration adds a depth grid of injections on top. The practical consequence for Track C is
// concrete: the lever that improves completeness (deeper baselines => more sectors => more points) costs
// ~nPoints^2.94, so doubling the baseline multiplies per-star cost ~2^2.94 ~= 7.7x. That trade-off is what
// the compute budget has to buy, and this file prices it.
//
// METHOD (reproducible; re-fits from the committed p33 catalog every run, nothing hardcoded):
//   1. Read reports/p33-catalog.json (per-star nPoints + perCurveMs, where perCurveMs covers the null arm
//      plus one injection per depth = 1 + nDepths detector runs).
//   2. Fit log(perCurveMs) = log(k) + p*log(nPoints) by least squares; report p, k, R^2 honestly.
//   3. Single-star SURVEY detection cost (null arm only, what a real catalog run pays) is perCurveMs /
//      (1 + nDepths) averaged over the sample; this uses the MEASURED mean, not a plug-in of mean nPoints
//      into the convex power law (which would understate it by Jensen's inequality).
//   4. Extrapolate to survey sizes x baseline depths: a deeper baseline multiplies every star's points by a
//      factor f, and cost scales by f^p, so surveyCPU(N, f) = N * meanSingleDetSeconds * f^p.
//   5. Convert CPU-hours to wall-clock at a given parallelism (cores / CI matrix shards).
// Download + FITS-parse I/O is NOT metered by p33 (its timer starts after the curve is in memory) and at
// scale is the OTHER bottleneck; it is flagged explicitly, never folded silently into the detection number.
//
// OUTPUT: reports/p34-cost-model.md (model, fit quality, extrapolation tables, recommendation) and
// reports/p34-cost-model.json (machine-readable). Research probe: no worker import, no verdict, no bundle
// hash, no money path, nothing gated/anchored/claimed/deployed.
//
// Run:  npm run p34:cost-model  [-- --sectors 1,2,4 --stars 1000,5000,20000 --parallel 1,8,64]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
// ROUND-26: this report was one of the rows the freshness gate could never check -- it declared no stamp, so the site
// published it as `unattested` and a reader had no way to learn that its input catalog had grown 6x since the numbers
// were frozen. buildStamp records generatedAt + gitSha + a sha256 per input; p86 then re-hashes them on every library
// build. The inputs listed here are the ones this script actually reads (the P33 catalog) plus the script itself, so a
// change in the model code is visible as staleness too.
import { buildStamp } from "./report-freshness.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const CATALOG = "reports/p33-catalog.json";
const sectorScenarios = arg("sectors", "1,2,4").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
const starScenarios = arg("stars", "1000,5000,20000").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
const parallelScenarios = arg("parallel", "1,8,64").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);

interface CatRow { host: string; nPoints: number; perCurveMs: number; }

function fitPowerLaw(xs: number[], ys: number[]): { p: number; k: number; r2: number; n: number } {
  const lx = xs.map(Math.log);
  const ly = ys.map(Math.log);
  const n = lx.length;
  const sx = lx.reduce((a, b) => a + b, 0);
  const sy = ly.reduce((a, b) => a + b, 0);
  const sxx = lx.reduce((a, b) => a + b * b, 0);
  const sxy = lx.reduce((a, b, i) => a + b * ly[i], 0);
  const p = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const k = Math.exp((sy - p * sx) / n);
  const yhat = lx.map((x) => (sy - p * sx) / n + p * x);
  const ssRes = ly.reduce((s, y, i) => s + (y - yhat[i]) ** 2, 0);
  const ssTot = ly.reduce((s, y) => s + (y - sy / n) ** 2, 0);
  return { p, k, r2: 1 - ssRes / ssTot, n };
}

function main(): void {
  if (!existsSync(CATALOG)) {
    console.log(`[p34] missing ${CATALOG}; run \`npm run p33:scale-roc\` first to produce the measured catalog.`);
    console.log(`\nVERDICT: NO-INPUT`);
    return;
  }
  const cat = JSON.parse(readFileSync(CATALOG, "utf8")) as { meta: { depthsPpm: number[]; stars: number }; rows: CatRow[] };
  const rows = cat.rows.filter((r) => r.nPoints > 0 && r.perCurveMs > 0);
  const nDepths = cat.meta.depthsPpm.length;
  const runsPerCurve = 1 + nDepths; // null arm + one inject per depth
  const N = rows.length;
  const fit = fitPowerLaw(rows.map((r) => r.nPoints), rows.map((r) => r.perCurveMs));

  // Measured single-star SURVEY detection cost (null arm only) = mean(perCurveMs) / runsPerCurve.
  const meanPerCurveMs = rows.reduce((a, r) => a + r.perCurveMs, 0) / N;
  const meanSingleDetS = meanPerCurveMs / runsPerCurve / 1000;
  const meanPoints = rows.reduce((a, r) => a + r.nPoints, 0) / N;
  // p33 stitched <=2 sectors; treat that as the f=1 reference baseline for the depth scaling.
  const refSectors = 2;

  console.log(`P34 measured compute/cost model, re-fit from ${CATALOG} (${N} real curves).`);
  console.log(`  power-law perCurveMs = k * nPoints^p :  p = ${fit.p.toFixed(3)},  k = ${fit.k.toExponential(3)} ms,  R2(log-log) = ${fit.r2.toFixed(3)}  (N=${fit.n})`);
  console.log(`  reference baseline: <=${refSectors} sectors, mean ${meanPoints.toFixed(0)} pts/star`);
  console.log(`  measured single-star survey detection (null arm only): ${meanSingleDetS.toFixed(2)} s  [perCurveMs ${meanPerCurveMs.toFixed(0)} / ${runsPerCurve} runs]`);
  console.log(`  depth scaling: cost ~ f^p, so doubling baseline (f=2) costs ~${Math.pow(2, fit.p).toFixed(2)}x\n`);

  // Survey CPU-hours per (stars, sectors): N * meanSingleDetS * f^p, f = sectors/refSectors.
  const cpuHours = (stars: number, sectors: number): number => {
    const f = sectors / refSectors;
    return (stars * meanSingleDetS * Math.pow(f, fit.p)) / 3600;
  };

  const lines: string[] = [];
  lines.push(`# P34 measured compute / cost model (scaling the survey)`);
  lines.push(``);
  lines.push(`Grounded in reports/p33-catalog.json (${N} real TESS-SPOC curves). Re-fit every run; nothing hardcoded.`);
  lines.push(``);
  lines.push(`## Detector cost scaling (measured)`);
  lines.push(``);
  lines.push(`Least-squares power-law fit of perCurveMs vs nPoints (log-log):`);
  lines.push(``);
  lines.push(`| quantity | value |`);
  lines.push(`|---|---|`);
  lines.push(`| exponent p (perCurveMs ~ nPoints^p) | ${fit.p.toFixed(3)} |`);
  lines.push(`| coefficient k (ms) | ${fit.k.toExponential(3)} |`);
  lines.push(`| R^2 (log-log) | ${fit.r2.toFixed(3)} |`);
  lines.push(`| sample N | ${fit.n} |`);
  lines.push(`| reference baseline | <=${refSectors} sectors, mean ${meanPoints.toFixed(0)} pts/star |`);
  lines.push(`| measured single-star survey detection (null arm) | ${meanSingleDetS.toFixed(2)} s |`);
  lines.push(`| cost of doubling the baseline (f=2) | ~${Math.pow(2, fit.p).toFixed(2)}x |`);
  lines.push(``);
  lines.push(`The near-cubic exponent (p ~= ${fit.p.toFixed(2)}) is the central engineering fact: BLS over a fine period`);
  lines.push(`grid is superlinear in the point count, the iterative mask-and-refind re-runs it per signal, so the lever`);
  lines.push(`that raises completeness (deeper baselines => more sectors => more points) is priced ~nPoints^p. R^2 =`);
  lines.push(`${fit.r2.toFixed(2)} on N=${fit.n} is an empirical scaling for THIS detector + period grid, not a universal law;`);
  lines.push(`treat extrapolations as order-of-magnitude planning figures, and re-fit after any detector/grid change.`);
  lines.push(``);
  lines.push(`## Survey CPU-hours (detection only; download/parse excluded)`);
  lines.push(``);
  lines.push(`Rows = survey size, columns = stitched sectors per star. surveyCPU = N * ${meanSingleDetS.toFixed(2)} s * (sectors/${refSectors})^${fit.p.toFixed(2)}.`);
  lines.push(``);
  lines.push(`| stars | ${sectorScenarios.map((s) => `${s} sec`).join(" | ")} |`);
  lines.push(`|---|${sectorScenarios.map(() => "---").join("|")}|`);
  for (const stars of starScenarios) {
    lines.push(`| ${stars} | ${sectorScenarios.map((s) => `${cpuHours(stars, s).toFixed(1)} CPU-h`).join(" | ")} |`);
  }
  lines.push(``);
  lines.push(`## Wall-clock at parallelism (CPU-hours / P)`);
  lines.push(``);
  lines.push(`Detection is embarrassingly parallel across stars (no cross-star state), so wall-clock ~= CPU-h / P for P`);
  lines.push(`independent workers (cores, or CI matrix shards).`);
  lines.push(``);
  lines.push(`| stars x sectors | ${parallelScenarios.map((p) => `P=${p}`).join(" | ")} |`);
  lines.push(`|---|${parallelScenarios.map(() => "---").join("|")}|`);
  for (const stars of starScenarios) {
    for (const s of sectorScenarios) {
      const cpu = cpuHours(stars, s);
      lines.push(`| ${stars} x ${s} sec (${cpu.toFixed(1)} CPU-h) | ${parallelScenarios.map((p) => `${(cpu / p).toFixed(2)} h`).join(" | ")} |`);
    }
  }
  lines.push(``);
  lines.push(`## Recommendation (compute is the funded lever)`);
  lines.push(``);
  lines.push(`- A ${starScenarios[starScenarios.length - 1]}-star, ${refSectors}-sector public catalog costs ~${cpuHours(starScenarios[starScenarios.length - 1], refSectors).toFixed(0)} CPU-h for detection; on a`);
  lines.push(`  ${parallelScenarios[parallelScenarios.length - 1]}-way CI matrix that is ~${(cpuHours(starScenarios[starScenarios.length - 1], refSectors) / parallelScenarios[parallelScenarios.length - 1]).toFixed(1)} h wall-clock, and shards restart independently.`);
  lines.push(`- Deeper baselines are where completeness is won but cost ~nPoints^${fit.p.toFixed(1)}: a ${sectorScenarios[sectorScenarios.length - 1]}-sector run of the same`);
  lines.push(`  sample is ~${(cpuHours(starScenarios[starScenarios.length - 1], sectorScenarios[sectorScenarios.length - 1]) / Math.max(cpuHours(starScenarios[starScenarios.length - 1], refSectors), 1e-9)).toFixed(1)}x the CPU. Buy depth selectively (bright/shallow hosts first), not uniformly.`);
  lines.push(`- Dollar cost maps directly from any provider's vCPU-h price: cost ~= CPU-h x price_per_vCPU_h. This file`);
  lines.push(`  quotes CPU-h only and does not invent a provider price.`);
  lines.push(`- Download + FITS-parse I/O is NOT in these numbers (p33's timer starts after the curve is in memory) and at`);
  lines.push(`  ${starScenarios[starScenarios.length - 1]}-star scale is the other real bottleneck; meter it separately in the scale-out and cache/prefetch products.`);
  lines.push(``);
  lines.push(`Reproduce: \`npm run p34:cost-model -- --sectors ${sectorScenarios.join(",")} --stars ${starScenarios.join(",")} --parallel ${parallelScenarios.join(",")}\``);
  lines.push(``);

  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p34-cost-model.md", lines.join("\n"));
  const json = {
    meta: { generatedBy: "p34-cost-model", source: CATALOG, sampleN: N, refSectors, runsPerCurve, ...buildStamp([CATALOG, "scripts/p34-cost-model.ts"]) },
    fit: { p: fit.p, k: fit.k, r2: fit.r2, n: fit.n },
    measured: { meanPerCurveMs, meanSingleDetSeconds: meanSingleDetS, meanPoints },
    doublingCostFactor: Math.pow(2, fit.p),
    cpuHours: starScenarios.map((stars) => ({ stars, bySectors: sectorScenarios.map((s) => ({ sectors: s, cpuHours: cpuHours(stars, s) })) })),
  };
  writeFileSync("reports/p34-cost-model.json", JSON.stringify(json, null, 2));

  console.log(`=== P34 SURVEY CPU-HOURS (detection only) ===`);
  for (const stars of starScenarios) {
    console.log(`  ${String(stars).padStart(6)} stars : ${sectorScenarios.map((s) => `${s}sec=${cpuHours(stars, s).toFixed(1)}h`).join("  ")}`);
  }
  console.log(`\nWrote reports/p34-cost-model.md and reports/p34-cost-model.json`);
  console.log(`\nVERDICT: P34-RAN`);
}

try {
  main();
} catch (e) {
  console.error(`[p34] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: ERROR`);
}
