// P41 - LONGER BASELINE (MULTI-SECTOR) vs SINGLE SECTOR: how much of the shallow-signal COMPLETENESS
// ceiling is the single-sector baseline, measured on real TESS-SPOC photometry.
//
// WHY. The roadmap's completeness limit (p33: ~36% at 300 ppm, ~18% of curves unrecoverable even deep) and
// the single-sector physical bound (period resolution ~ P^2 / (oversample x baseline); a 27-day sector smears
// long periods and buries shallow dips under the red-noise tail) are repeatedly flagged as data/method
// boundaries. This MEASURES the one lever that genuinely moves that boundary -- observing the SAME star for
// longer by stitching its multiple sectors -- rather than asserting it. For each seeded confirmed host we pull
// every available sector, then run an identical injection-recovery depth grid on (a) its single longest sector
// and (b) the stitched multi-sector baseline, and report completeness(depth) for both. The gap is the honest,
// quantified price of the single-sector baseline -- and the promise of extended baselines.
//
// HONEST POSTURE. We compare like with like: the same injected period/depth/seed on the same underlying real
// noise; only the baseline (1 sector vs stitched) differs. This does NOT make any discovery claim, gate,
// anchor or deploy -- it is a completeness measurement on real light curves (research-only, no worker import).
//
// Run: npm run p41:longbaseline [-- --stars 40 --maxsectors 4 --period 3 --depths 300,500,800,1500,3000 --seed 7]
import { bls } from "../src/detect/bls.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes, stitchLightCurves } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, d: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
}

const wantStars = Math.max(1, parseInt(arg("stars", "40"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "4"), 10));
const injPeriod = Number(arg("period", "3"));
const depthsPpm = arg("depths", "300,500,800,1500,3000").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const seed = Math.max(1, parseInt(arg("seed", "7"), 10));
const minPeriod = 1, maxPeriod = 13;
const matchTol = 5;

async function collectSectors(tic: number, name: string, cap: number): Promise<LightCurve[]> {
  const out: LightCurve[] = [];
  for (let s = 1; s <= 59 && out.length < cap; s++) {
    let bytes: Uint8Array | null = null;
    try { bytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 }); } catch { /* transient */ }
    if (!bytes) continue;
    try { const lc = fitsToLightCurve(bytes, name); if (lc.points.length >= 60) { lc.source = `TESS-SPOC sector ${s} (REAL)`; out.push(lc); } } catch { /* unparseable */ }
  }
  return out;
}

function detectRecovered(lc: LightCurve | null, depthPpm: number, baseSeed: number): boolean {
  if (!lc) return false;
  try {
    const inj = injectTransitInto(lc, { periodDays: injPeriod, depthFrac: depthPpm / 1e6, seed: baseSeed });
    const r = bls(preprocess(inj, 0.5), { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2 });
    const d = r.depth * 1e6;
    return r.snr >= 7 && d >= 200 && classifyDepthRegime(d).planetPlausible && periodMatched(r.periodDays, injPeriod, matchTol);
  } catch { return false; }
}

async function main(): Promise<void> {
  console.log(`[p41] long-baseline completeness: ${wantStars} seeded hosts, up to ${maxSectors} sectors, inject P=${injPeriod}d, depths [${depthsPpm}] ppm, seed ${seed}.`);
  const planets = (await fetchConfirmedPlanets({ maxTmag: 12, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) { const a = byHost.get(p.tic!) ?? []; a.push(p); byHost.set(p.tic!, a); }
  const hosts = [...byHost.entries()].slice(0, wantStars);
  console.log(`  catalog: ${byHost.size} hosts; sampling first ${hosts.length}.\n`);

  const single: Record<number, number> = {}; const multi: Record<number, number> = {};
  depthsPpm.forEach((d) => { single[d] = 0; multi[d] = 0; });
  let usable = 0, multiSector = 0, sectorCountSum = 0;
  // Per-host rows for the JSON artifact: a reader who wants to re-derive the table (or check that the arms really
  // share the same hosts) must be able to, without re-downloading anything. reports/p41-longbaseline.md quotes
  // twelve completeness figures; until this array existed, p41 was the ONLY published report with no machine-
  // readable counterpart behind its numbers.
  const rows: { tic: number; name: string; sectors: number; singlePoints: number; stitchedPoints: number | null; recovered: Record<string, { single: boolean; multi: boolean }> }[] = [];

  for (const [tic, hp] of hosts) {
    const name = hp[0].hostname ?? `TIC ${tic}`;
    const sectors = await collectSectors(tic, name, maxSectors);
    if (sectors.length < 1) { console.log(`  ${name.padEnd(16)}: no SPOC curve; skip`); continue; }
    usable++;
    // single = the longest (most-cadence) individual sector; multi = the stitched baseline across all sectors
    let longest = sectors[0]!;
    for (const s of sectors) if (s.points.length > longest.points.length) longest = s;
    const stitched = sectors.length >= 2 ? stitchLightCurves(sectors) : null;
    sectorCountSum += sectors.length;
    if (sectors.length >= 2 && stitched) multiSector++;
    console.log(`  ${name.padEnd(16)}: ${sectors.length} sectors (single ${longest.points.length} pts, stitched ${stitched ? stitched.points.length + " pts" : "n/a"})`);
    const recovered: Record<string, { single: boolean; multi: boolean }> = {};
    depthsPpm.forEach((d, di) => {
      const s = detectRecovered(longest, d, seed + di);
      const m = stitched ? detectRecovered(stitched, d, seed + di) : false;
      if (s) single[d]++;
      if (stitched && m) multi[d]++;
      recovered[String(d)] = { single: s, multi: m };
    });
    rows.push({ tic, name, sectors: sectors.length, singlePoints: longest.points.length, stitchedPoints: stitched ? stitched.points.length : null, recovered });
  }

  if (!usable) { console.log("\nNo usable hosts; VERDICT: NO-USEFUL-DATA"); return; }
  console.log(`\n[p41] ===== COMPLETENESS: single sector vs stitched multi-sector (${usable} hosts; ${multiSector} had >=2 sectors) =====`);
  for (const d of depthsPpm) {
    const sc = (100 * single[d] / usable).toFixed(1);
    const mc = (100 * multi[d] / usable).toFixed(1);
    console.log(`  @ ${String(d).padStart(5)} ppm : single ${sc}% (${single[d]}/${usable})  |  multi ${mc}% (${multi[d]}/${usable})  |  lift ${(100 * (multi[d] - single[d]) / usable).toFixed(1)} pp`);
  }
  console.log(`  mean sectors/host used: ${(sectorCountSum / usable).toFixed(2)}`);

  mkdirSync("reports", { recursive: true });
  const L: string[] = [];
  L.push("# P41 longer baseline (multi-sector) vs single sector -- completeness on real photometry");
  L.push("");
  L.push(`Reproduce: \`npm run p41:longbaseline -- --stars ${wantStars} --maxsectors ${maxSectors} --period ${injPeriod} --seed ${seed}\``);
  L.push(`Sample: first ${hosts.length} seeded hosts (T<=12, P in [${minPeriod},${maxPeriod}] d); ${usable} had a public SPOC curve, ${multiSector} had >=2 sectors stitched.`);
  L.push(`Identical injection-recovery depth grid on (a) each host's longest single sector and (b) its stitched`);
  L.push(`multi-sector baseline; only the baseline differs. Detector: bls + SNR>=7 / depth>=200ppm / plausibility,`);
  L.push(`period match tol ${matchTol}%, inject P=${injPeriod}d, seed ${seed}.`);
  L.push("");
  L.push("| depth ppm | single-sector completeness | multi-sector completeness | lift (pp) |");
  L.push("|---|---|---|---|");
  for (const d of depthsPpm) L.push(`| ${d} | ${(100 * single[d] / usable).toFixed(1)}% (${single[d]}/${usable}) | ${(100 * multi[d] / usable).toFixed(1)}% (${multi[d]}/${usable}) | ${(100 * (multi[d] - single[d]) / usable).toFixed(1)} |`);
  L.push("");
  L.push(`Mean sectors/host used: ${(sectorCountSum / usable).toFixed(2)}. Measure-only: nothing gated, anchored,`);
  L.push("claimed or deployed. Longer baselines (more sectors / full-frame surveys) are the honest lever against");
  L.push("the single-sector completeness ceiling; this quantifies its price on real data.");
  writeFileSync("reports/p41-longbaseline.md", L.join("\n"));
  // The machine-readable half of the same run, stamped against the tracked source the detector came from, so
  // p86 can RE-HASH it on any checkout (every input here is a committed file, not a gitignored checkpoint).
  const completeness: Record<string, { single: number; multi: number; usable: number }> = {};
  for (const d of depthsPpm) completeness[String(d)] = { single: single[d]!, multi: multi[d]!, usable };
  writeFileSync(
    "reports/p41-longbaseline.json",
    JSON.stringify({
      meta: {
        stars: wantStars, maxSectors, injPeriod, depthsPpm, seed, matchTolPct: matchTol, minPeriodDays: minPeriod, maxPeriodDays: maxPeriod,
        hostsSampled: hosts.length, usableHosts: usable, multiSectorHosts: multiSector,
        meanSectorsPerHost: +(sectorCountSum / usable).toFixed(3),
        generatedBy: "scripts/p41-longbaseline.ts",
        ...buildStamp([
          "scripts/p41-longbaseline.ts", "src/detect/bls.ts", "src/detect/detrend.ts",
          "src/sim/injectInto.ts", "src/data/mastS3.ts", "src/data/mast.ts", "src/candidate/falsePositive.ts",
        ]),
      },
      completeness,
      hosts: rows,
    }, null, 2) + "\n",
  );
  console.log(`\n[p41] wrote reports/p41-longbaseline.md and reports/p41-longbaseline.json`);
  console.log("\nVERDICT: P41-RAN");
}

main().catch((e) => { console.error(`[p41] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("VERDICT: INCONCLUSIVE-NETWORK"); });
