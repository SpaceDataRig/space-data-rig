// P78 MULTI-SECTOR BLIND TEST on real photometry -- fixes the exact weakness the audit named.
//
// P49 planted planets and scored recall/precision, but it STITCHED every sector into ONE baseline and hard-set
// corroboratedSectors = 1, so the 2-sector corroboration bar accepted NOTHING (0/0) -- it could not show that
// corroboration WORKS, only that a single sector is refused. This study runs the detector SECTOR BY SECTOR on
// real TESS-SPOC curves, plants one phase-coherent ephemeris across the sectors (or leaves a real null), groups
// detections by period across sectors, and counts corroboration as the number of INDEPENDENT sectors that found
// the same period. Then we score raw (no bar) and under the real 2-sector bar, so falseAccepts and accepted-recall
// are MEASURED on genuine multi-sector data, not capped to zero by construction.
//
// PROTOCOL (sealed key hidden from the detector): for each host with >=2 usable real sectors, a seeded coin either
// plants one planet (period/depth from a documented prior, same t0 across sectors) on EVERY sector curve, or leaves
// all sectors null. iterativeBls under the production gate runs on each sector separately; per-sector signals are
// clustered by period (rel tol 0.05, one signal per sector per cluster); the cluster's corroboratedSectors is the
// number of distinct sectors contributing. Score vs the key with src/sim/blindTest.ts at minCorroboration 1 and 2.
//
// HONEST FRAMING. Precision is a LOWER bound: a detection that is the host's own real, uncatalogued planet counts
// FP (hosts here are planet-bearing). The decisive numbers are (a) do injected planets clear the 2-sector bar
// (accepted recall) and (b) do null curves stay at 0 false accepts under it -- i.e. does multi-sector corroboration
// actually suppress real noise. Measure only. Research-only: no worker import, no verdict, no bundle hash, no money
// path; nothing gated, anchored, or claimed. discoveryClaim false, safeToGate false.
//
// Run:  npm run p78:blind-multisector  [-- --stars 40 --sectors 5 --tmag 11 --inject-frac 0.5 --seed 11]

import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantStars = Math.max(4, parseInt(arg("stars", "40"), 10));
const sectorCap = Math.max(2, parseInt(arg("sectors", "5"), 10));
const tmagCap = Number(arg("tmag", "11"));
const injectFrac = Math.min(1, Math.max(0, Number(arg("inject-frac", "0.5"))));
const seed = Math.max(1, parseInt(arg("seed", "11"), 10));
const PERIOD_PRIOR: [number, number] = [2, 8];
const DEPTH_PRIOR = [1200, 2500, 4500];
const minPeriod = 1;
const maxPeriod = 13;
const CLUSTER_TOL = 0.05;

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fetch up to `want` SEPARATE real SPOC sector light curves (not stitched) for a host. */
async function collectSectors(tic: number, name: string, want: number, sectorMax = 60): Promise<LightCurve[]> {
  const out: LightCurve[] = [];
  for (let s = 1; s <= sectorMax && out.length < want; s++) {
    let bytes: Uint8Array | null = null;
    try { bytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 }); } catch { /* skip */ }
    if (!bytes) continue;
    try { const lc = fitsToLightCurve(bytes, name); if (lc.points.length >= 120) out.push(lc); } catch { /* skip */ }
  }
  return out;
}

/** Production-gated signals on one curve, strongest first. */
function detectSignals(lc: LightCurve, maxSignals: number): { periodDays: number; depthPpm: number }[] {
  try {
    const it = iterativeBls(lc, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals });
    return it.signals.filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible).map((s) => ({ periodDays: s.periodDays, depthPpm: s.depthPpm }));
  } catch { return []; }
}

interface SectorHit { sector: number; periodDays: number; depthPpm: number; }
interface Cluster { periods: number[]; depths: number[]; sectors: Set<number>; }

/** Group per-sector hits into period clusters; a cluster's corroboration is the number of DISTINCT sectors. */
function clusterBySector(hits: SectorHit[], tol: number): Cluster[] {
  const sorted = [...hits].sort((a, b) => a.periodDays - b.periodDays);
  const clusters: Cluster[] = [];
  for (const h of sorted) {
    let target: Cluster | undefined;
    for (const c of clusters) {
      if (c.sectors.has(h.sector)) continue;
      const med = c.periods[Math.floor(c.periods.length / 2)];
      if (Math.abs(med - h.periodDays) / med <= tol) { target = c; break; }
    }
    if (!target) { target = { periods: [], depths: [], sectors: new Set() }; clusters.push(target); }
    target.periods.push(h.periodDays); target.depths.push(h.depthPpm); target.sectors.add(h.sector);
  }
  for (const c of clusters) { c.periods.sort((a, b) => a - b); c.depths.sort((a, b) => a - b); }
  return clusters;
}

async function main(): Promise<void> {
  console.log(`P78 multi-sector blind test on real photometry: up to ${wantStars} hosts with >=2 sectors, sector cap ${sectorCap}, inject-frac ${injectFrac}, period prior [${PERIOD_PRIOR}]d, depth prior [${DEPTH_PRIOR}]ppm, seed ${seed}. Per-sector iterativeBls under the production gate; corroboration = distinct sectors at the same period.`);

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 8000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) { const a = byHost.get(p.tic!) ?? []; a.push(p); byHost.set(p.tic!, a); }
  const hosts = [...byHost.entries()].slice(0, wantStars * 3); // over-fetch: many hosts have <2 sectors

  const rng = mulberry32(seed);
  const truth: Truth[] = [];
  const detections: Detection[] = [];
  let made = 0;
  let hostsWith2 = 0;
  for (const [tic, hostPlanets] of hosts) {
    if (made >= wantStars) break;
    const name = hostPlanets[0].hostname ?? `TIC ${tic}`;
    const sectors = await collectSectors(tic, name, sectorCap);
    if (sectors.length < 2) continue; // genuine multi-sector requirement
    hostsWith2++;
    made++;
    const id = `${tic}`;
    const doInject = rng() < injectFrac;
    const hits: SectorHit[] = [];
    let injectedPeriod = 0;
    let injectedDepth = 0;
    if (doInject) {
      const periodDays = PERIOD_PRIOR[0] + rng() * (PERIOD_PRIOR[1] - PERIOD_PRIOR[0]);
      const depthPpm = DEPTH_PRIOR[Math.floor(rng() * DEPTH_PRIOR.length)];
      const t0Bjd = sectors[0].points[0].time + periodDays * rng(); // one ephemeris, shared across sectors
      injectedPeriod = periodDays; injectedDepth = depthPpm;
      truth.push({ id, injected: true, periodDays, depthPpm });
      sectors.forEach((lc, k) => {
        const inj = injectTransitInto(lc, { seed: seed + made * 100 + k, periodDays, depthFrac: depthPpm / 1e6, t0Bjd });
        for (const s of detectSignals(inj, 3)) hits.push({ sector: k, periodDays: s.periodDays, depthPpm: s.depthPpm });
      });
    } else {
      truth.push({ id, injected: false });
      sectors.forEach((lc, k) => { for (const s of detectSignals(lc, 3)) hits.push({ sector: k, periodDays: s.periodDays, depthPpm: s.depthPpm }); });
    }
    void injectedPeriod; void injectedDepth;
    const clusters = clusterBySector(hits, CLUSTER_TOL);
    for (const c of clusters) {
      detections.push({ id, periodDays: c.periods[Math.floor(c.periods.length / 2)], depthPpm: c.depths[Math.floor(c.depths.length / 2)], corroboratedSectors: c.sectors.size });
    }
    const tag = doInject ? "INJ " : "NULL";
    console.log(`  [${tag}] TIC ${tic} sectors ${sectors.length} clusters ${clusters.length} maxCorr ${Math.max(0, ...clusters.map((c) => c.sectors.size))}`);
  }

  if (!truth.length) { console.log(`\nNo hosts with >=2 real sectors (network/coverage). Re-run shortly.`); console.log(`\nVERDICT: NO-USEFUL-DATA`); return; }

  const raw = scoreBlindTest(truth, detections, { minCorroboration: 1 });
  const capped = scoreBlindTest(truth, detections, { minCorroboration: 2 });
  const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "n/a");
  const ci = (r: [number, number]) => `[${pct(r[0])}, ${pct(r[1])}]`;

  console.log(`\n=== P78 SUMMARY: ${truth.length} hosts (all >=2 real sectors), ${raw.nInjected} injected, ${raw.nNull} null, ${raw.nDetections} period-clusters ===`);
  console.log(`  raw confusion: TP ${raw.tp} FP ${raw.fp} FN ${raw.fn} TN ${raw.tn}`);
  console.log(`  RECALL (planted recovered, any) : ${pct(raw.recall)} ${ci(raw.recallCI)}`);
  console.log(`  PRECISION (detections real)     : ${pct(raw.precision)} ${ci(raw.precisionCI)} (lower bound)`);
  console.log(`  FP rate per null host           : ${Number.isFinite(raw.fpPerNullCurve) ? raw.fpPerNullCurve.toFixed(2) : "n/a"}`);
  console.log(`  -- under the REAL 2-sector corroboration bar --`);
  console.log(`  accepted ${capped.accepted} | ACCEPTED RECALL ${pct(capped.acceptedTp / Math.max(1, raw.nInjected))} (${capped.acceptedTp}/${raw.nInjected}) | needs-more-data ${capped.needsMoreData}`);
  console.log(`  FALSE-ACCEPTS ${capped.falseAccepts} | accepted precision ${pct(capped.acceptedPrecision)}`);

  const corrHist = [1, 2, 3, 4, 5].map((k) => detections.filter((d) => d.corroboratedSectors === k).length);
  const json = {
    meta: {
      generatedBy: "scripts/p78-blind-multisector.ts", protocol: "sealed-key PER-SECTOR injection-recovery; corroboration = distinct sectors at same period",
      detector: "iterativeBls under production gate (depth-regime screen), maxSignals=3/sector, cluster tol " + CLUSTER_TOL,
      wantStars, sectorCap, hostsWith2, injectFrac, periodPrior: PERIOD_PRIOR, depthPrior: DEPTH_PRIOR, seed,
      note: "hosts are planet-bearing, so precision is a lower bound. Unlike P49 (stitched, corroboratedSectors forced to 1), this measures the 2-sector bar on genuine multi-sector real data.",
    },
    hosts: truth.length, injected: raw.nInjected, null: raw.nNull, clusters: raw.nDetections, corroborationHistogram: corrHist,
    raw, capped, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p78-blind-multisector.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P78 multi-sector blind test on real photometry",
    "",
    `Reproduce: \`npm run p78:blind-multisector -- --stars ${wantStars} --sectors ${sectorCap} --inject-frac ${injectFrac} --seed ${seed}\``,
    "",
    "Where P49 stitched sectors into one baseline and forced corroboratedSectors=1 (so the 2-sector bar accepted",
    "nothing by construction), P78 runs the detector SECTOR BY SECTOR on real TESS-SPOC curves, plants one",
    "phase-coherent ephemeris across the sectors (or leaves real nulls), and counts corroboration as the number of",
    "independent sectors that found the same period. The 2-sector bar is then MEASURED, not assumed.",
    "",
    `**${truth.length} hosts, all with >=2 real sectors** (${raw.nInjected} injected, ${raw.nNull} null), ${raw.nDetections} period-clusters`,
    "",
    "| metric | value |",
    "|---|---|",
    `| recall (any sectors) | ${pct(raw.recall)} ${ci(raw.recallCI)} |`,
    `| precision (lower bound) | ${pct(raw.precision)} ${ci(raw.precisionCI)} |`,
    `| FP rate per null host | ${Number.isFinite(raw.fpPerNullCurve) ? raw.fpPerNullCurve.toFixed(2) : "n/a"} |`,
    `| corroboration histogram (1..5 sectors) | ${corrHist.join(" / ")} |`,
    `| accepted under 2-sector bar | ${capped.accepted} |`,
    `| ACCEPTED recall under 2-sector bar | ${pct(capped.acceptedTp / Math.max(1, raw.nInjected))} (${capped.acceptedTp}/${raw.nInjected}) |`,
    `| FALSE-ACCEPTS under 2-sector bar | ${capped.falseAccepts} |`,
    `| accepted precision | ${pct(capped.acceptedPrecision)} |`,
    "",
    "Honest reading: precision is a LOWER bound (a detection that is the host's own real planet counts FP). The",
    "decisive results are whether injected planets clear the 2-sector bar (accepted recall) and whether null hosts",
    "stay at zero false accepts under it -- i.e. whether real multi-sector corroboration suppresses real noise.",
    "Measure only; nothing gated, anchored, claimed, or deployed. `discoveryClaim: false`, `safeToGate: false`.",
    "",
  ];
  writeFileSync("reports/p78-blind-multisector.md", md.join("\n"));
  console.log("\nwrote reports/p78-blind-multisector.{md,json}");
  console.log(`\nVERDICT: ${capped.falseAccepts === 0 ? "P78-MULTISECTOR-BLIND-ZERO-FALSE-ACCEPTS" : `P78-MULTISECTOR-BLIND-FA-${capped.falseAccepts}`}`);
}

main().catch((e) => {
  console.error("p78 failed:", e instanceof Error ? e.message : e);
  console.log("\nVERDICT: INCONCLUSIVE-NETWORK");
  process.exitCode = 1;
});
