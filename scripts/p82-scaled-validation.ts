// P82 -- SCALED VALIDATION HARNESS (audit follow-up: "the sample is far too small; scale it up ~100-1000x").
//
// Runs the three audit-9 probes over a MUCH larger real target pool from ONE shared, resumable, concurrent,
// byte-cached engine, so wall-clock and external rate limits -- not our old hand-picked ~20 targets -- set N:
//   PROBE blind    : scale P78 -- inject a synthetic transit on each host's REAL multi-sector SPOC curves, detect
//                    BLIND sector-by-sector, corroborate by period across independent sectors, score recall /
//                    precision / false-accepts under a >=2-sector bar (scoreBlindTest + Wilson CI).
//   PROBE external : scale P80+P81 -- BLIND per-sector detection (the catalogued ephemeris is never fed), then
//                    independently match each ExoFOP claim (KP controls / CP uncertain candidates) + a real Gaia
//                    2' blend census -> dilution + blend EB FPP + harmonic-alias accounting.
//   PROBE centroid : the @dysmemic per-contaminant F-test (P77 point 4, previously target-only) -- capture
//                    per-sector centroid offsets from real pixel cubes, then run the faithful centroid F-test
//                    against the target AND every Gaia neighbour within 2' bright enough to cause the dip; report
//                    the known-planet FALSE-REJECT rate and the labelled-blend CATCH rate vs their 0/565 / 73%.
//
// RESUMABLE + APPEND-ONLY: each probe writes one JSONL line per processed target to out/scaled/<probe>.jsonl;
// re-running skips already-done TICs. A 500-target run can therefore span interruptions. All numbers are
// MEASURED on real public data; nothing is fabricated and a null/partial result is reported as such.
//
// Red lines: research only. No worker import, no verdict, no bundle hash, no money path. discoveryClaim false,
// safeToGate false everywhere. measure-before-gate.
//
// Usage: npm run p82:scaled -- --probe all --limit 500 --concurrency 6 --sectors 4 --tmag 13 --min-depth 1500
//        [--centroid-limit 200 --gaia-ms 300 --seed 7 --resume 1]

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";
import { fetchToiTable, isPlaceable, type ToiRecord } from "../src/data/toiDispositions.ts";
import { createSpocSectorFetcher, resolveSpocKey, fetchSpocBytes } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { localizeTransitSource, PIXEL_SCALE_ARCSEC } from "../src/detect/diffImaging.ts";
import { targetCentroidP, centroidFtest, neighbourCanCauseDip, type Offset } from "../src/detect/centroidFtest.ts";
import { fetchGaiaNeighborhood, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { daveBlendedFpp } from "../src/detect/benchmark.ts";
import { independentlyConfirmed } from "../src/candidate/independentValidation.ts";
import { countHarmonicSiblings } from "../src/candidate/triceratopsLite.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const num = (n: string, d: number) => { const v = Number(arg(n, String(d))); return Number.isFinite(v) ? v : d; };

const PROBE = arg("probe", "all").toLowerCase();
const LIMIT = Math.max(1, Math.round(num("limit", 500)));
const CENTROID_LIMIT = Math.max(1, Math.round(num("centroid-limit", LIMIT)));
const CONC = Math.max(1, Math.round(num("concurrency", 6)));
const sectorCap = Math.max(2, Math.round(num("sectors", 4)));
const tmagCap = num("tmag", 13);
const minDepth = num("min-depth", 1500);
const TOL = num("tol", 0.02);
const MIN_CORR = Math.round(num("min-corr", 2));
const GAIA_MS = num("gaia-ms", 300);
const ALPHA = num("alpha", 0.001);
const CENSUS_ARCSEC = num("census-arcmin", 2) * 60;
const SEED = Math.round(num("seed", 7));
const RESUME = num("resume", 1) >= 1;
const OUT = "out/scaled";
const minPeriod = 1, maxPeriod = 15;

function mulberry32(a: number) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
async function mapBounded<T, R>(items: T[], width: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length || 1)) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i); }));
  return out;
}
function makeThrottle(minMs: number) { let last = 0; let chain: Promise<unknown> = Promise.resolve(); return <T>(fn: () => Promise<T>): Promise<T> => { const run = async (): Promise<T> => { const wait = Math.max(0, last + minMs - Date.now()); if (wait) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); return fn(); }; const p = chain.then(run, run); chain = p.then(() => undefined, () => undefined); return p as Promise<T>; }; }

interface Cluster { periodDays: number; corroboratedSectors: number; depthPpm: number }
function detectClusters(sectors: LightCurve[]): Cluster[] {
  const hits: { sector: number; periodDays: number; depthPpm: number }[] = [];
  sectors.forEach((lc, si) => {
    try { const it = iterativeBls(lc, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod, maxSignals: 3 }); for (const s of it.signals) if (classifyDepthRegime(s.depthPpm).planetPlausible) hits.push({ sector: si, periodDays: s.periodDays, depthPpm: s.depthPpm }); } catch { /* skip */ }
  });
  const sorted = [...hits].sort((a, b) => a.periodDays - b.periodDays);
  const cs: { periods: number[]; depths: number[]; sectors: Set<number> }[] = [];
  for (const h of sorted) { let t: (typeof cs)[number] | undefined; for (const c of cs) { if (c.sectors.has(h.sector)) continue; const m = c.periods[Math.floor(c.periods.length / 2)]; if (Math.abs(m - h.periodDays) / m <= 0.05) { t = c; break; } } if (!t) { t = { periods: [], depths: [], sectors: new Set() }; cs.push(t); } t.periods.push(h.periodDays); t.depths.push(h.depthPpm); t.sectors.add(h.sector); }
  return cs.map((c) => ({ periodDays: c.periods[Math.floor(c.periods.length / 2)], depthPpm: c.depths[Math.floor(c.depths.length / 2)], corroboratedSectors: c.sectors.size }));
}

const done = (file: string): Set<number> => { const s = new Set<number>(); if (!RESUME || !existsSync(file)) return s; for (const line of readFileSync(file, "utf8").split("\n")) { if (!line.trim()) continue; try { const o = JSON.parse(line); if (Number.isFinite(o.tic)) s.add(o.tic); } catch { /* skip */ } } return s; };

const gaiaThrottle = makeThrottle(GAIA_MS);
async function gaiaCensus(ra: number, dec: number) {
  return gaiaThrottle(async () => { try { return await fetchGaiaNeighborhood(ra, dec, { radiusDeg: (CENSUS_ARCSEC + 6) / 3600 }); } catch { return []; } });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  console.log(`P82 scaled harness. probe=${PROBE} limit=${LIMIT} centroidLimit=${CENTROID_LIMIT} concurrency=${CONC} sectors<=${sectorCap} tmag<=${tmagCap} minDepth=${minDepth}ppm resume=${RESUME}.`);
  const records = await fetchToiTable();
  if (!records.length) { console.log("ExoFOP TOI table unavailable (network). Aborting."); process.exitCode = 1; return; }
  console.log(`ExoFOP pool: ${records.length} rows.`);
  const fetcher = createSpocSectorFetcher({ concurrency: CONC, timeoutMs: 25000 });

  const isKP = (r: ToiRecord) => (r.tfopwgDisposition || "").toUpperCase() === "KP" || (r.tessDisposition || "").toUpperCase() === "KP";
  const isCP = (r: ToiRecord) => (r.tfopwgDisposition || "").toUpperCase() === "CP" || (r.tessDisposition || "").toUpperCase() === "CP";
  const isBlend = (r: ToiRecord) => (r.label === "blend-or-fp");
  const uniqBright = (rows: ToiRecord[]) => { const seen = new Set<number>(); const out: ToiRecord[] = []; for (const r of [...rows].sort((a, b) => a.tessMag - b.tessMag)) { if (seen.has(r.tic) || !Number.isFinite(r.tessMag) || r.tessMag > tmagCap) continue; seen.add(r.tic); out.push(r); } return out; };
  const multiSector = (r: ToiRecord) => isPlaceable(r) && r.sectors.length >= 2;

  // ---- PROBE: blind (scale P78) ----
  if (PROBE === "all" || PROBE === "blind") {
    const file = `${OUT}/blind.jsonl`;
    const pool = uniqBright(records.filter((r) => multiSector(r) && r.tessMag <= tmagCap)).slice(0, LIMIT);
    const skip = done(file); const todo = pool.filter((r) => !skip.has(r.tic));
    console.log(`[blind] pool ${pool.length}, already done ${skip.size}, to run ${todo.length}`);
    let n = 0;
    await mapBounded(todo, CONC, async (rec) => {
      const sectors = (await fetcher.fetchSectors(rec.tic, rec.sectors.slice(0, sectorCap), `TIC ${rec.tic}`)).filter((l) => l && l.points.length >= 120);
      if (sectors.length < 2) { appendFileSync(file, JSON.stringify({ tic: rec.tic, skip: "lt2 sectors" }) + "\n"); return; }
      const rng = mulberry32((rec.tic ^ SEED) >>> 0);
      const coin = rng() < 0.42;
      let truth: Truth; const dets: Detection[] = [];
      if (coin) {
        const periodDays = 2 + rng() * 6, depthPpm = 2000 + rng() * 4000, t0Bjd = sectors[0].points[0].time + periodDays * rng();
        const inj = sectors.map((lc) => injectTransitInto(lc, { seed: (rec.tic + Math.round(periodDays * 100)) >>> 0, periodDays, depthFrac: depthPpm / 1e6, t0Bjd }));
        for (const c of detectClusters(inj)) dets.push({ id: String(rec.tic), periodDays: c.periodDays, depthPpm: c.depthPpm, corroboratedSectors: c.corroboratedSectors });
        truth = { id: String(rec.tic), injected: true, periodDays, depthPpm };
      } else {
        for (const c of detectClusters(sectors)) dets.push({ id: String(rec.tic), periodDays: c.periodDays, depthPpm: c.depthPpm, corroboratedSectors: c.corroboratedSectors });
        truth = { id: String(rec.tic), injected: false };
      }
      appendFileSync(file, JSON.stringify({ tic: rec.tic, tessMag: rec.tessMag, nSectors: sectors.length, truth, dets }) + "\n");
      if ((++n) % 25 === 0) console.log(`  [blind] ${n}/${todo.length} processed (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    });
    console.log(`[blind] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // ---- PROBE: external (scale P80+P81) ----
  if (PROBE === "all" || PROBE === "external") {
    const file = `${OUT}/external.jsonl`;
    const pool = uniqBright(records.filter((r) => multiSector(r) && isPlaceable(r) && Number.isFinite(r.depthPpm) && r.depthPpm >= minDepth && r.periodDays >= 2 && r.periodDays <= 8 && (isKP(r) || isCP(r)))).slice(0, LIMIT);
    const skip = done(file); const todo = pool.filter((r) => !skip.has(r.tic));
    console.log(`[external] pool ${pool.length}, already done ${skip.size}, to run ${todo.length}`);
    let n = 0;
    await mapBounded(todo, CONC, async (rec) => {
      const sectors = (await fetcher.fetchSectors(rec.tic, rec.sectors.slice(0, sectorCap), `TIC ${rec.tic} ${rec.toi}`)).filter((l) => l && l.points.length >= 120);
      const clusters = detectClusters(sectors);
      const corr = clusters.filter((c) => c.corroboratedSectors >= MIN_CORR);
      const disp = (rec.tfopwgDisposition || rec.tessDisposition || "?").toUpperCase();
      let validated = false, rel = NaN, matched = NaN;
      for (const c of corr) { const r = independentlyConfirmed({ periodDays: c.periodDays, corroboratedSectors: c.corroboratedSectors }, { id: rec.toi, periodDays: rec.periodDays, disposition: disp }, { periodTolFrac: TOL, minCorroboration: MIN_CORR }); if (r.validated && (Number.isNaN(rel) || r.relPeriodDiff < rel)) { validated = true; rel = r.relPeriodDiff; matched = c.periodDays; } }
      const nb = (await gaiaCensus(rec.ra, rec.dec)).filter((g) => angularSepArcsec(rec.ra, rec.dec, g.ra, g.dec) <= CENSUS_ARCSEC);
      let host = nb[0], hostSep = Infinity; for (const g of nb) { const s = angularSepArcsec(rec.ra, rec.dec, g.ra, g.dec); if (s < hostSep) { hostSep = s; host = g; } }
      let blendFpp = NaN, dilution = NaN, nNb = 0;
      if (host) {
        const contrasts: number[] = []; let flux = 0;
        for (const g of nb) { if (g.sourceId === host.sourceId) continue; const c = Math.pow(10, -0.4 * (g.gmag - host.gmag)); if (c > 0) { contrasts.push(c); flux += c; nNb++; } }
        dilution = 1 / (1 + flux);
        blendFpp = daveBlendedFpp({ obsDepthFrac: rec.depthPpm / 1e6, periodDays: rec.periodDays, neighbors: contrasts.map((contrast) => ({ contrast })), ebPriorShortPeriod: 0.015 });
      }
      const harmonicSiblings = validated ? countHarmonicSiblings(matched, corr.map((c) => c.periodDays)) : 0;
      appendFileSync(file, JSON.stringify({ tic: rec.tic, toi: rec.toi, disp, claimPeriod: rec.periodDays, depthPpm: rec.depthPpm, tessMag: rec.tessMag, nSectors: sectors.length, maxCorr: Math.max(0, ...clusters.map((c) => c.corroboratedSectors)), validated, relPct: validated ? Number((rel * 100).toFixed(3)) : null, matchedPeriod: validated ? Number(matched.toFixed(5)) : null, blendFpp: Number.isFinite(blendFpp) ? blendFpp : null, dilution: Number.isFinite(dilution) ? Number(dilution.toFixed(4)) : null, nNb, harmonicSiblings }) + "\n");
      if ((++n) % 25 === 0) console.log(`  [external] ${n}/${todo.length} processed (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    });
    console.log(`[external] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // ---- PROBE: centroid per-contaminant F-test (scale P77 point 4) ----
  if (PROBE === "all" || PROBE === "centroid") {
    const file = `${OUT}/centroid.jsonl`;
    const pool = uniqBright(records.filter((r) => multiSector(r) && isPlaceable(r) && (isKP(r) || isBlend(r)) && Number.isFinite(r.depthPpm))).slice(0, CENTROID_LIMIT);
    const skip = done(file); const todo = pool.filter((r) => !skip.has(r.tic));
    console.log(`[centroid] pool ${pool.length}, already done ${skip.size}, to run ${todo.length} (pixel cubes -- the slow stage)`);
    let n = 0;
    await mapBounded(todo, Math.max(1, Math.floor(CONC / 2)), async (rec) => {
      const offsets: Offset[] = [];
      for (const s of rec.sectors.slice(0, sectorCap)) {
        try {
          const lcBytes = await fetchSpocBytes(resolveSpocKey(rec.tic, s, "lc"), { timeoutMs: 25000 });
          const lc = lcBytes ? fitsToLightCurve(lcBytes, `TIC ${rec.tic}`) : null;
          if (!lc) continue;
          const cube = await fetchSpocTargetPixels(rec.tic, s, lc.targetId);
          if (!cube) continue;
          const loc = localizeTransitSource(cube, rec.epochBjd, rec.periodDays, 2, { bootstraps: 120, seed: 4242 });
          if (!loc || !loc.determined || loc.dropSnr < 5) continue;
          offsets.push({ east: (loc.sourceCentroid.x - loc.targetCentroid.x) * PIXEL_SCALE_ARCSEC, north: (loc.sourceCentroid.y - loc.targetCentroid.y) * PIXEL_SCALE_ARCSEC });
        } catch { /* skip sector */ }
      }
      const tr = targetCentroidP(offsets);
      const nb = (await gaiaCensus(rec.ra, rec.dec)).filter((g) => angularSepArcsec(rec.ra, rec.dec, g.ra, g.dec) <= CENSUS_ARCSEC);
      let host = nb[0], hostSep = Infinity; for (const g of nb) { const s = angularSepArcsec(rec.ra, rec.dec, g.ra, g.dec); if (s < hostSep) { hostSep = s; host = g; } }
      let bestNeighbourP = 0, viableNeighbours = 0;
      if (host && tr.testable) {
        for (const g of nb) {
          if (g.sourceId === host.sourceId) continue;
          const sep = angularSepArcsec(rec.ra, dec0(rec), g.ra, g.dec);
          if (!neighbourCanCauseDip(rec.depthPpm / 1e6, g.gmag, host.gmag)) continue;
          viableNeighbours++;
          const d2r = Math.PI / 180;
          const sOff: Offset = { east: (g.ra - host.ra) * Math.cos(host.dec * d2r) * 3600, north: (g.dec - host.dec) * 3600 };
          const fr = centroidFtest(offsets, sOff);
          if (fr.testable && fr.p > bestNeighbourP) bestNeighbourP = fr.p;
        }
      }
      const label = isBlend(rec) ? "blend" : "planet";
      const falseReject = label === "planet" && tr.testable && tr.p < ALPHA;
      const caught = label === "blend" && tr.testable && tr.p < ALPHA && bestNeighbourP >= ALPHA;
      appendFileSync(file, JSON.stringify({ tic: rec.tic, toi: rec.toi, label, nUsed: tr.nUsed, testable: tr.testable, pTarget: Number(tr.p.toExponential(2)), viableNeighbours, bestNeighbourP: Number(bestNeighbourP.toExponential(2)), falseReject, caught }) + "\n");
      if ((++n) % 10 === 0) console.log(`  [centroid] ${n}/${todo.length} processed (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    });
    console.log(`[centroid] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  console.log(`\nAll requested probes finished in ${((Date.now() - t0) / 1000).toFixed(0)}s. Checkpoints in ${OUT}/. Aggregate with: npm run p82:scaled -- --probe report`);
}
function dec0(rec: ToiRecord): number { return rec.dec; }

// ---- AGGREGATE mode: read the JSONL checkpoints -> reports/p82-scaled.{md,json} ----
async function aggregate(): Promise<void> {
  const readJsonl = (f: string) => { if (!existsSync(f)) return []; return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); };
  const blindRows = readJsonl(`${OUT}/blind.jsonl`).filter((r) => r.truth);
  const truth: Truth[] = blindRows.map((r) => r.truth);
  const dets: Detection[] = blindRows.flatMap((r) => r.dets as Detection[]);
  const bt = truth.length ? scoreBlindTest(truth, dets, { minCorroboration: MIN_CORR }) : null;

  const ext = readJsonl(`${OUT}/external.jsonl`).filter((r) => r.disp);
  const kp = ext.filter((r) => r.disp === "KP"), cp = ext.filter((r) => r.disp === "CP");
  const rate = (rows: { validated?: boolean; blendFpp?: number | null; harmonicSiblings?: number; nNb?: number }[]) => {
    const tested = rows.length, validated = rows.filter((r) => r.validated).length;
    const grade = rows.filter((r) => r.validated && (r.blendFpp ?? 1) < 1e-3 && (r.harmonicSiblings ?? 0) === 0).length;
    return { tested, validated, grade };
  };
  const kpR = rate(kp), cpR = rate(cp);

  const cen = readJsonl(`${OUT}/centroid.jsonl`).filter((r) => r.testable);
  const planets = cen.filter((r) => r.label === "planet"), blends = cen.filter((r) => r.label === "blend");
  const pFalseReject = planets.filter((r) => r.falseReject).length, bCaught = blends.filter((r) => r.caught).length;
  const ci = (k: number, n: number) => (n ? wilsonInterval(k, n).map((x) => Number((100 * x).toFixed(1))) : [0, 0]);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { ...buildStamp([`${OUT}/blind.jsonl`, `${OUT}/external.jsonl`, `${OUT}/centroid.jsonl`]), generatedBy: "scripts/p82-scaled-validation.ts --probe report", limit: LIMIT, centroidLimit: CENTROID_LIMIT, concurrency: CONC, sectorCap, tmagCap, minDepth, tol: TOL, minCorroboration: MIN_CORR, censusArcsec: CENSUS_ARCSEC, alpha: ALPHA, seed: SEED, note: "scaled from the hand-picked ~20-target P77-P81 probes to N up to hundreds; all measured on real public data; first-order, not full TRICERATOPS/eumemic; discoveryClaim false, safeToGate false." },
    blind: bt ? { curves: bt.nCurves, injected: bt.nInjected, nullCurves: bt.nNull, recall: bt.recall, recallCI: bt.recallCI, precision: bt.precision, precisionCI: bt.precisionCI, acceptedUnderBar: bt.accepted, acceptedTp: bt.acceptedTp, falseAccepts: bt.falseAccepts, acceptedPrecision: bt.acceptedPrecision } : null,
    external: { kp: { ...kpR, kpCI: ci(kpR.validated, kpR.tested) }, cp: { ...cpR, cpCI: ci(cpR.validated, cpR.tested) } },
    centroid: { planetsTestable: planets.length, planetFalseReject: pFalseReject, planetFalseRejectCI: ci(pFalseReject, planets.length), blendsTestable: blends.length, blendCaught: bCaught, blendCaughtCI: ci(bCaught, blends.length), eumemicReference: { planetFalseReject: "0/565 at p<0.001", blendCatch: "127/175 (73%); 38% within 15 arcsec" } },
    discoveryClaim: false, safeToGate: false,
  };
  writeFileSync("reports/p82-scaled.json", JSON.stringify(json, null, 2) + "\n");
  const pct = (x: number | undefined) => (typeof x === "number" ? (100 * x).toFixed(1) + "%" : "n/a");
  const md = [
    "# P82 scaled validation (audit follow-up: grow the sample ~100-1000x)",
    "",
    `Reproduce: \`npm run p82:scaled -- --probe all --limit ${LIMIT} --concurrency ${CONC}\` then \`npm run p82:scaled -- --probe report\``,
    "",
    "Same three audit-9 probes, run over a MUCH larger real target pool via one resumable, concurrent, byte-cached",
    "engine (out/scaled/*.jsonl checkpoints). Every number is measured on real public TESS-SPOC / Gaia / ExoFOP data.",
    "",
    "## Blind test (scaled P78)",
    bt ? `- curves ${bt.nCurves} (${bt.nInjected} injected / ${bt.nNull} null); recall ${pct(bt.recall)} CI [${bt.recallCI.map((x) => (100 * x).toFixed(0)).join(",")}]; precision ${pct(bt.precision)} CI [${bt.precisionCI.map((x) => (100 * x).toFixed(0)).join(",")}]` : "- no blind rows yet",
    bt ? `- >=${MIN_CORR}-sector bar: accepted ${bt.accepted}, accepted-recall ${bt.acceptedTp}/${bt.nInjected}, FALSE-ACCEPTS ${bt.falseAccepts}, accepted precision ${pct(bt.acceptedPrecision)}` : "",
    "",
    "## External independent validation (scaled P80+P81)",
    `- KP controls: validated ${kpR.validated}/${kpR.tested}; blendFPP<1e-3 & no harmonic alias ${kpR.grade}/${kpR.tested}`,
    `- CP uncertain candidates: validated ${cpR.validated}/${cpR.tested}; strict grade ${cpR.grade}/${cpR.tested}`,
    "",
    "## Centroid per-contaminant F-test (scaled P77 point 4)",
    `- known planets testable ${planets.length}: FALSE-REJECT ${pFalseReject} (${pct(planets.length ? pFalseReject / planets.length : NaN)}) -- eumemic reference 0/565`,
    `- labelled blends testable ${blends.length}: CAUGHT ${bCaught} (${pct(blends.length ? bCaught / blends.length : NaN)}) -- eumemic reference 73% (38% within 15")`,
    "",
    "First-order checks and positive controls on real data; not discoveries, not full TRICERATOPS/eumemic-grade",
    "validation. discoveryClaim false, safeToGate false.",
    "",
  ].filter(Boolean);
  writeFileSync("reports/p82-scaled.md", md.join("\n"));
  console.log("wrote reports/p82-scaled.{md,json}");
  console.log(JSON.stringify(json.blind && json.external && json.centroid ? { blind: { recall: json.blind.recall, acceptedPrecision: json.blind.acceptedPrecision, falseAccepts: json.blind.falseAccepts }, external: json.external, centroid: json.centroid } : json, null, 2));
}

if (PROBE === "report") { aggregate().catch((e) => { console.error("aggregate failed:", e); process.exitCode = 1; }); }
else main().catch((e) => { console.error("p82 failed:", e instanceof Error ? e.message : e); process.exitCode = 1; });
