// P33 - LARGE-SCALE REPRODUCIBLE COMPLETENESS / PURITY ROC ON REAL PHOTOMETRY (+ compute metering).
//
// WHY. p26-p32 converged on an honest bottleneck: on public few-sector TESS-SPOC curves the detector is
// DATA-POWER limited, and every prior completeness number was measured on a handful of stars (p1-real-
// completeness: 12 stars) or on synthetic noise (p1:roc). Problem-3 of the roadmap asks for a LARGE, publicly
// reproducible completeness-purity measurement instead of an anecdote. p33 scales the two-arm injection-
// recovery design to a seeded sample of real host stars and meters wall-clock per star so the compute cost
// of going bigger is MEASURED, not guessed.
//
// DESIGN (two arms per real curve, measure-before-gate, fully seeded => reproducible):
//   * NULL arm  : run the production detector (iterativeBls, maxSignals=3, SNR>=7 & depth>=200 ppm &
//                 depth-regime screen) on the REAL curve as-is and keep EVERY gated signal. A gated
//                 detection that matches a known catalog planet of that host (period within tol,
//                 aliases/harmonics allowed) is a TRUE positive; a gated detection matching nothing
//                 known is a FALSE positive. Over many null curves this yields the blind FP rate and
//                 the detection PURITY = TP/(TP+FP).
//   * INJECT arm: multiplicatively inject one transit at a fixed period across a depth grid into the SAME
//                 real curve (real noise / cadence / gaps preserved) and ask whether the gated detector
//                 recovers the injected period. Completeness(depth) = recovered / trials on REAL noise.
// Coverage is reported honestly: a sampled host with no public SPOC product is a coverage miss, never a
// silent drop. Per-star wall-clock is recorded so the compute cost of a thousands-star survey is measured.
//
// OUTPUT: reports/p33-scale-roc.md (completeness vs depth, purity, FP rate, coverage, compute extrapolation)
// and reports/p33-catalog.json (per-star rows: the public recovery catalog). Research probe: no worker
// import, no verdict, no bundle hash, no money path, nothing anchored/claimed/deployed.
//
// Run:  npm run p33:scale-roc  [-- --stars 40 --maxsectors 2 --depths 300,500,1000,2000,4000,8000 --period 3 --tmag 12 --matchtol 2 --seed 7]

import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes, stitchLightCurves } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { mkdirSync, writeFileSync } from "node:fs";
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
const minPeriod = 1;
const maxPeriod = 13;

// TESScut's sector-lookup is unreachable from some networks; SPOC S3 keys are deterministic given
// (TIC, sector) and a missing product is a fast 404, so probe the public bucket directly.
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

/** The production detector's gated signal periods, strongest first. */
function detectSignals(lc: LightCurve, maxSignals: number): number[] {
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
  nullDets: number;
  nullTP: number;
  nullFP: number;
  recByDepth: Record<number, boolean>;
  perCurveMs: number;
}

async function main(): Promise<void> {
  console.log(
    `P33 large-scale reproducible completeness/purity ROC on REAL photometry: ${wantStars} seeded host stars, ` +
    `up to ${maxSectors} sectors, inject period ${injPeriod} d, depths [${depthsPpm.join(",")}] ppm, T<=${tmagCap}, ` +
    `match tol ${matchTolPct}%, seed ${seed}. Two arms per curve (null + inject); compute metered.`,
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
  const hosts = [...byHost.entries()].slice(0, wantStars); // deterministic catalog order => reproducible sample
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

    // NULL arm: detector on the real curve as-is; every gated signal is a detection, classified
    // TP (matches a known catalog planet of this host) or FP (matches nothing known).
    const nullPs = detectSignals(stitched, 3);
    const nullTP = nullPs.filter((p) => hostPlanets.some((h) => h.pl_orbper != null && periodMatched(p, h.pl_orbper, matchTolPct))).length;
    const nullFP = nullPs.length - nullTP;

    // INJECT arm: one transit per depth on the same real curve; recovered if ANY gated signal
    // matches the injected period (a host's own real planet may outrank it in power).
    const recByDepth: Record<number, boolean> = {};
    for (const d of depthsPpm) {
      const inj = injectTransitInto(stitched, { periodDays: injPeriod, depthFrac: d / 1e6, seed });
      recByDepth[d] = detectSignals(inj, 3).some((p) => periodMatched(p, injPeriod, matchTolPct));
    }

    const perCurveMs = Date.now() - t0;
    rows.push({ host: name, nPoints: stitched.points.length, nullDets: nullPs.length, nullTP, nullFP, recByDepth, perCurveMs });
    const recStr = depthsPpm.map((d) => (recByDepth[d] ? "1" : "0")).join("");
    const nullStr = nullPs.length ? `${nullTP}TP/${nullFP}FP` : "--";
    console.log(
      `  [${idx}/${hosts.length}] ${name.padEnd(16)} (${sectorLcs.length} sec, ${stitched.points.length} pts, ${(perCurveMs / 1000).toFixed(1)}s)  ` +
      `null ${nullStr}  inject[${recStr}]`,
    );
  }

  if (!rows.length) {
    console.log(`\nNo sampled host had a usable public SPOC curve. Re-run when network/coverage permits.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const N = rows.length;
  const nullDetections = rows.reduce((a, r) => a + r.nullDets, 0);
  const nullTP = rows.reduce((a, r) => a + r.nullTP, 0);
  const nullFP = rows.reduce((a, r) => a + r.nullFP, 0);
  const purity = nullDetections ? (100 * nullTP / nullDetections) : NaN;
  const fpRate = 100 * nullFP / N;
  const meanMs = rows.reduce((a, r) => a + r.perCurveMs, 0) / N;

  console.log(`\n=== P33 SUMMARY (${N} real host curves; ${coverageMiss} coverage misses of ${hosts.length} sampled) ===`);
  console.log(`  NULL arm: gated detections ${nullDetections}/${N}; true-pos ${nullTP}; false-pos ${nullFP}`);
  console.log(`  blind false-positive rate : ${fpRate.toFixed(1)}% of null curves`);
  console.log(`  detection purity TP/(TP+FP): ${Number.isFinite(purity) ? purity.toFixed(1) + "%" : "n/a"}`);
  for (const d of depthsPpm) {
    const rec = rows.filter((r) => r.recByDepth[d]).length;
    console.log(`  completeness @ ${String(d).padStart(5)} ppm : ${rec}/${N}  (${(100 * rec / N).toFixed(1)}%)`);
  }
  console.log(`  mean detector wall-clock per curve (null+${depthsPpm.length} injects): ${(meanMs / 1000).toFixed(2)} s`);
  const perStarSingle = meanMs / (1 + depthsPpm.length);
  console.log(`  => ~${(perStarSingle / 1000).toFixed(2)} s per single-star detection; 1000 stars ~ ${(perStarSingle * 1000 / 3600 / 1000).toFixed(2)} CPU-h (detection only, excl. download)`);

  // Public, reproducible artifacts.
  mkdirSync("reports", { recursive: true });
  const lines: string[] = [];
  lines.push(`# P33 large-scale completeness / purity ROC (real photometry)`);
  lines.push(``);
  lines.push(`Sample: first ${hosts.length} TIC-bearing hosts (T<=${tmagCap}, P in [${minPeriod},${maxPeriod}] d) in deterministic`);
  lines.push(`catalog order; ${N} had usable public TESS-SPOC curves (<=${maxSectors} sectors stitched), ${coverageMiss} coverage misses.`);
  lines.push(`Inject period ${injPeriod} d; depths [${depthsPpm.join(", ")}] ppm; seed ${seed}; match tol ${matchTolPct}%.`);
  lines.push(`Detector: iterativeBls maxSignals=3 with production gate (SNR>=7, depth>=200 ppm, depth-regime screen).`);
  lines.push(``);
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| null curves | ${N} |`);
  lines.push(`| gated null detections | ${nullDetections} |`);
  lines.push(`| true-pos (match known catalog planet) | ${nullTP} |`);
  lines.push(`| false-pos | ${nullFP} |`);
  lines.push(`| blind FP rate | ${fpRate.toFixed(1)}% |`);
  lines.push(`| purity TP/(TP+FP) | ${Number.isFinite(purity) ? purity.toFixed(1) + "%" : "n/a"} |`);
  for (const d of depthsPpm) {
    const rec = rows.filter((r) => r.recByDepth[d]).length;
    lines.push(`| completeness @ ${d} ppm | ${rec}/${N} (${(100 * rec / N).toFixed(1)}%) |`);
  }
  lines.push(`| mean wall-clock per curve (null+${depthsPpm.length} injects) | ${(meanMs / 1000).toFixed(2)} s |`);
  lines.push(``);
  lines.push(`Reproduce: \`npm run p33:scale-roc -- --stars ${wantStars} --maxsectors ${maxSectors} --period ${injPeriod} --seed ${seed}\``);
  lines.push(``);
  writeFileSync("reports/p33-scale-roc.md", lines.join("\n"));
  writeFileSync("reports/p33-catalog.json", JSON.stringify({ meta: { stars: N, coverageMiss, depthsPpm, injPeriod, seed, matchTolPct, generatedBy: "p33-scale-roc" }, rows }, null, 2));
  console.log(`\nWrote reports/p33-scale-roc.md and reports/p33-catalog.json`);
  console.log(`\nVERDICT: P33-RAN`);
}

main().catch((e) => {
  console.error(`[p33] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
