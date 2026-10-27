// P35 - INDEPENDENT CROSS-CHECK: PHASE DISPERSION MINIMIZATION (PDM) vs THE BOX-FIT DETECTOR, ON REAL PHOTOMETRY.
//
// WHY. Problem-3 of the roadmap names "independent third-party validation almost nonexistent" as a gap. The
// cheapest real independence is a DIFFERENT ALGORITHM on the SAME data. Every detector shipped so far (bls.ts,
// iterative.ts) is in the box-fit family; src/detect/pdm.ts is Phase Dispersion Minimization (Stellingwerf 1978),
// a non-parametric period finder that shares no machinery with BLS (it never fits a box or a transit model -- it
// minimizes the within-bin variance of the phase fold). p35 runs BOTH on the same real TESS-SPOC curves and asks
// two honest questions:
//   (1) AGREEMENT: when our gated BLS detects a period on a real curve, does independent PDM's global theta
//       minimum land on the same period (or a low-order harmonic)? Agreement is corroboration; disagreement
//       localizes where the box-fit family may be locking a systematics/alias peak PDM does not share.
//   (2) INDEPENDENT COMPLETENESS: inject a known transit at a fixed period across a depth grid and ask whether PDM
//       alone recovers it -- a completeness curve from an estimator that is not BLS. Where reports/p33-catalog.json
//       is present (same seeded sample, same depths), p35 prints PDM completeness SIDE BY SIDE with the published
//       BLS completeness on the same stars.
//
// HONEST EXPECTATION, stated up front: PDM is a GENERAL period finder, so on a real variable star its global theta
// minimum is often the dominant stellar rotation / activity period, not a shallow transit. PDM completeness on real
// noise is therefore expected to be LOWER than a detrended box-fit search -- that contrast is the point (it is why
// transit pipelines use BLS + detrending), not a defect. Numbers are measured, never asserted.
//
// OUTPUT: reports/p35-pdm-crosscheck.md + reports/p35-pdm-crosscheck.json. Research probe: no worker import, no
// verdict, no bundle hash, no money path, nothing gated/anchored/claimed/deployed.
//
// Run:  npm run p35:pdm-crosscheck  [-- --stars 40 --maxsectors 2 --depths 300,500,1000,2000,4000,8000 --period 3 --tmag 12 --matchtol 2 --seed 7 --bins 12 --oversample 10]

import { iterativeBls, isAliasOf } from "../src/detect/iterative.ts";
import { pdmOnLightCurve } from "../src/detect/pdm.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes, stitchLightCurves } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { buildStamp } from "./report-freshness.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantStars = Math.max(1, parseInt(arg("stars", "40"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "2"), 10));
const depthsPpm = arg("depths", "300,500,1000,2000,4000,8000").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
const injPeriod = Number(arg("period", "3"));
const tmagCap = Number(arg("tmag", "12"));
const matchTolPct = Number(arg("matchtol", "2"));
const seed = Math.max(1, parseInt(arg("seed", "7"), 10));
const pdmBins = Math.max(2, parseInt(arg("bins", "12"), 10));
const pdmOversample = Math.max(1, parseInt(arg("oversample", "10"), 10));
const minPeriod = 1;
const maxPeriod = 13;

// Same TESScut-unreachable workaround as p32/p33: SPOC S3 keys are deterministic given (TIC, sector) and a
// missing product is a fast 404, so probe the public bucket directly.
async function collectSpocCurves(tic: number, name: string, maxCurves: number, sectorMax = 40): Promise<LightCurve[]> {
  const out: LightCurve[] = [];
  for (let s = 1; s <= sectorMax && out.length < maxCurves; s++) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 });
    } catch { /* transient; skip this sector */ }
    if (!bytes) continue;
    try {
      const lc = fitsToLightCurve(bytes, name);
      if (lc.points.length < 60) continue;
      lc.source = `TESS-SPOC PDCSAP product sector ${s} from public S3 (REAL photometry); CC BY 4.0, cite Caldwell et al. 2020`;
      out.push(lc);
    } catch { /* unparseable; skip */ }
  }
  return out;
}

/** Our box-fit detector's gated signal periods, strongest first (iterativeBls under the same production gate as p33). */
function blsGatedPeriods(lc: LightCurve, maxSignals = 3): number[] {
  try {
    const it = iterativeBls(lc, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals });
    return it.signals.filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible).map((s) => s.periodDays);
  } catch {
    return [];
  }
}

interface Row {
  host: string;
  nPoints: number;
  blsPeriods: number[];
  pdmPeriod: number | null;
  pdmTheta: number | null;
  agree: boolean | null; // null when there is nothing to compare (no gated BLS period or PDM undefined)
  pdmRecByDepth: Record<number, boolean>;
  perCurveMs: number;
}

async function main(): Promise<void> {
  console.log(
    `P35 independent cross-check (PDM vs box-fit BLS) on REAL photometry: ${wantStars} seeded hosts, up to ${maxSectors} sectors, ` +
    `inject period ${injPeriod} d, depths [${depthsPpm.join(",")}] ppm, PDM bins ${pdmBins} oversample ${pdmOversample}, match tol ${matchTolPct}%, seed ${seed}.`,
  );

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) {
    const a = byHost.get(p.tic!) ?? [];
    a.push(p);
    byHost.set(p.tic!, a);
  }
  const hosts = [...byHost.entries()].slice(0, wantStars); // deterministic catalog order => same sample as p33
  console.log(`  catalog: ${planets.length} in-range planets on ${byHost.size} hosts; sampling first ${hosts.length} hosts\n`);

  const rows: Row[] = [];
  let coverageMiss = 0;
  let idx = 0;
  for (const [tic, hostPlanets] of hosts) {
    idx++;
    const name = hostPlanets[0].hostname ?? hostPlanets[0].pl_name ?? `TIC ${tic}`;
    const sectorLcs = await collectSpocCurves(tic, name, maxSectors);
    if (sectorLcs.length < 1) {
      coverageMiss++;
      console.log(`  [${idx}/${hosts.length}] ${name}: no public SPOC curve (probed sectors 1-40); coverage miss`);
      continue;
    }
    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) {
      coverageMiss++;
      continue;
    }
    const t0 = Date.now();

    // (1) NULL cross-check: independent PDM vs the gated box-fit detector on the SAME real curve.
    const blsPeriods = blsGatedPeriods(stitched);
    const pdmNull = pdmOnLightCurve(stitched, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod, bins: pdmBins, oversample: pdmOversample });
    const pdmPeriod = Number.isFinite(pdmNull.periodDays) ? pdmNull.periodDays : null;
    const pdmTheta = Number.isFinite(pdmNull.theta) ? pdmNull.theta : null;
    const agree = blsPeriods.length && pdmPeriod != null ? blsPeriods.some((p) => isAliasOf(pdmPeriod, p, matchTolPct)) : null;

    // (2) INDEPENDENT completeness: PDM alone on a known injected transit across the depth grid.
    const pdmRecByDepth: Record<number, boolean> = {};
    for (const d of depthsPpm) {
      const inj = injectTransitInto(stitched, { periodDays: injPeriod, depthFrac: d / 1e6, seed });
      const r = pdmOnLightCurve(inj, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod, bins: pdmBins, oversample: pdmOversample });
      pdmRecByDepth[d] = Number.isFinite(r.periodDays) && isAliasOf(r.periodDays, injPeriod, matchTolPct);
    }

    const perCurveMs = Date.now() - t0;
    rows.push({ host: name, nPoints: stitched.points.length, blsPeriods, pdmPeriod, pdmTheta, agree, pdmRecByDepth, perCurveMs });
    const recStr = depthsPpm.map((d) => (pdmRecByDepth[d] ? "1" : "0")).join("");
    const agreeStr = agree == null ? "n/a" : agree ? "AGREE" : "differ";
    console.log(
      `  [${idx}/${hosts.length}] ${name.padEnd(16)} (${sectorLcs.length} sec, ${stitched.points.length} pts, ${(perCurveMs / 1000).toFixed(1)}s)  ` +
      `bls[${blsPeriods.map((p) => p.toFixed(2)).join(",") || "-"}] pdm ${pdmPeriod != null ? pdmPeriod.toFixed(2) + "d" : "-"} th=${pdmTheta != null ? pdmTheta.toFixed(3) : "-"} ${agreeStr}  pdmInject[${recStr}]`,
    );
  }

  if (!rows.length) {
    console.log(`\nNo sampled host had a usable public SPOC curve. Re-run when network/coverage permits.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const N = rows.length;
  const comparable = rows.filter((r) => r.agree != null);
  const agreeCount = comparable.filter((r) => r.agree === true).length;
  const agreeRate = comparable.length ? (100 * agreeCount / comparable.length) : NaN;

  // Side-by-side with the PUBLISHED BLS completeness on the same stars, when p33's catalog is present.
  let blsByHost: Map<string, Record<number, boolean>> | null = null;
  if (existsSync("reports/p33-catalog.json")) {
    try {
      const p33 = JSON.parse(readFileSync("reports/p33-catalog.json", "utf8")) as { rows: { host: string; recByDepth: Record<string, boolean> }[] };
      blsByHost = new Map(p33.rows.map((r) => [r.host, r.recByDepth as unknown as Record<number, boolean>]));
    } catch { blsByHost = null; }
  }
  const overlap = blsByHost ? rows.filter((r) => blsByHost!.has(r.host)) : [];

  console.log(`\n=== P35 SUMMARY (${N} real host curves; ${coverageMiss} coverage misses of ${hosts.length} sampled) ===`);
  console.log(`  NULL cross-check: ${comparable.length} curves had BOTH a gated BLS period and a finite PDM minimum`);
  console.log(`  PDM-vs-BLS period agreement (same period or harmonic, tol ${matchTolPct}%): ${agreeCount}/${comparable.length}${Number.isFinite(agreeRate) ? ` (${agreeRate.toFixed(1)}%)` : ""}`);
  for (const d of depthsPpm) {
    const rec = rows.filter((r) => r.pdmRecByDepth[d]).length;
    let line = `  PDM completeness @ ${String(d).padStart(5)} ppm : ${rec}/${N}  (${(100 * rec / N).toFixed(1)}%)`;
    if (overlap.length) {
      const bRec = overlap.filter((r) => (blsByHost!.get(r.host) as Record<number, boolean>)[d]).length;
      line += `   | BLS(p33) ${bRec}/${overlap.length} (${(100 * bRec / overlap.length).toFixed(1)}%) on the ${overlap.length} shared stars`;
    }
    console.log(line);
  }

  mkdirSync("reports", { recursive: true });
  const lines: string[] = [];
  lines.push(`# P35 independent cross-check: PDM vs box-fit BLS (real photometry)`);
  lines.push(``);
  lines.push(`Sample: first ${hosts.length} TIC-bearing hosts (T<=${tmagCap}, P in [${minPeriod},${maxPeriod}] d) in deterministic catalog`);
  lines.push(`order (the SAME seeded sample as p33); ${N} had usable public TESS-SPOC curves (<=${maxSectors} sectors stitched), ${coverageMiss} coverage misses.`);
  lines.push(`PDM (Stellingwerf 1978, src/detect/pdm.ts) is a non-parametric period finder sharing NO machinery with the`);
  lines.push(`box-fit family (bls.ts / iterative.ts): it minimizes the within-bin variance of the phase fold, theta. Inject`);
  lines.push(`period ${injPeriod} d; depths [${depthsPpm.join(", ")}] ppm; bins ${pdmBins}; oversample ${pdmOversample}; match tol ${matchTolPct}%; seed ${seed}.`);
  lines.push(``);
  lines.push(`## (1) Independent period agreement on real curves (NULL arm)`);
  lines.push(``);
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| curves with BOTH a gated BLS period and a finite PDM minimum | ${comparable.length}/${N} |`);
  lines.push(`| PDM-vs-BLS agreement (same period or harmonic) | ${agreeCount}/${comparable.length}${Number.isFinite(agreeRate) ? ` (${agreeRate.toFixed(1)}%)` : ""} |`);
  lines.push(``);
  lines.push(`Agreement is corroboration between two independent estimators; disagreement localizes where the box-fit family`);
  lines.push(`locks a peak PDM does not share (often a systematics or alias peak). PDM's global theta minimum on a real`);
  lines.push(`variable star is frequently the dominant rotation/activity period, so a low agreement rate is expected and is`);
  lines.push(`itself the honest finding (it is why transit pipelines use a detrended box-fit search, not raw PDM).`);
  lines.push(``);
  lines.push(`## (2) Independent completeness (PDM alone recovers a known injected transit)`);
  lines.push(``);
  if (overlap.length) {
    lines.push(`PDM completeness vs the PUBLISHED BLS completeness (reports/p33-catalog.json) on the ${overlap.length} shared stars:`);
    lines.push(``);
    lines.push(`| depth (ppm) | PDM recovered | BLS (p33) recovered |`);
    lines.push(`|---|---|---|`);
    for (const d of depthsPpm) {
      const pRec = overlap.filter((r) => r.pdmRecByDepth[d]).length;
      const bRec = overlap.filter((r) => (blsByHost!.get(r.host) as Record<number, boolean>)[d]).length;
      lines.push(`| ${d} | ${pRec}/${overlap.length} (${(100 * pRec / overlap.length).toFixed(1)}%) | ${bRec}/${overlap.length} (${(100 * bRec / overlap.length).toFixed(1)}%) |`);
    }
  } else {
    lines.push(`| depth (ppm) | PDM recovered (of ${N}) |`);
    lines.push(`|---|---|`);
    for (const d of depthsPpm) {
      const rec = rows.filter((r) => r.pdmRecByDepth[d]).length;
      lines.push(`| ${d} | ${rec}/${N} (${(100 * rec / N).toFixed(1)}%) |`);
    }
    lines.push(``);
    lines.push(`(reports/p33-catalog.json not present, so no side-by-side BLS column; run p33 first for the comparison.)`);
  }
  lines.push(``);
  lines.push(`Reproduce: \`npm run p35:pdm-crosscheck -- --stars ${wantStars} --maxsectors ${maxSectors} --period ${injPeriod} --seed ${seed}\``);
  lines.push(``);
  writeFileSync("reports/p35-pdm-crosscheck.md", lines.join("\n"));
  writeFileSync("reports/p35-pdm-crosscheck.json", JSON.stringify({ meta: { stars: N, coverageMiss, depthsPpm, injPeriod, seed, matchTolPct, pdmBins, pdmOversample, generatedBy: "p35-pdm-crosscheck", ...buildStamp(["reports/p33-catalog.json", "scripts/p35-pdm-crosscheck.ts"]) }, agreement: { comparable: comparable.length, agree: agreeCount }, rows }, null, 2));
  console.log(`\nWrote reports/p35-pdm-crosscheck.md and reports/p35-pdm-crosscheck.json`);
  console.log(`\nVERDICT: P35-RAN`);
}

main().catch((e) => {
  console.error(`[p35] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
