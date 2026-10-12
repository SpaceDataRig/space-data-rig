// P14 - does per-transit ephemeris refinement make the LONG fold work? (real TESS-SPOC, long-period)
//
// p12 found the long-period depth limit is PHASE COHERENCE, not data volume: stitching sectors and
// folding 1000-1800 days at the CATALOG ephemeris is fragile because a slightly-off catalog period
// drifts each transit out of phase. The proposed fix (src/detect/ephemeris.ts) times every transit,
// refits period+epoch by an O-C line, and folds at the REFINED ephemeris. This probe tests it on real
// confirmed planets with P >= --minperiod and compares three depth estimators, each scored against the
// catalog value post-hoc:
//   1. longfold  -- all sectors stitched, folded at the CATALOG ephemeris (p12's fragile naive fold).
//   2. persector -- each sector fit alone, depths combined by median (p12's robust winner).
//   3. refined   -- all sectors stitched, folded at the O-C REFINED ephemeris (the new fix).
// If "refined" matches or beats "persector" while using the whole baseline coherently, the cliff is
// genuinely addressed -- which is what would let the validated depth/size measurement extend to longer
// periods. Research probe only: no production path, no gating, no discovery claim.
//
// Run:  npx tsx scripts/p14-longperiod-coherence.ts --targets 18 --minperiod 10 --maxsectors 6
import { preprocess } from "../src/detect/detrend.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";
import { timeTransitEvents, refitEphemeris } from "../src/detect/ephemeris.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { ArchivePlanet, LightCurve } from "../src/core/types.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return def;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(x: number): string { return Number.isFinite(x) ? `${x.toFixed(1)}%` : "n/a"; }

const want = Math.round(arg("targets", 18));
const minPeriod = arg("minperiod", 10);
const maxSectors = Math.round(arg("maxsectors", 6));
const tmag = arg("tmag", 10.5);
const U1 = arg("u1", 0.4);
const U2 = arg("u2", 0.1);

function fitDepth(lc: LightCurve, period: number, epoch: number, aRs: number, cat: number) {
  const clean = preprocess(lc, 0.5);
  const times = clean.points.map((pt) => pt.time);
  const flux = clean.points.map((pt) => pt.flux);
  if (flux.length < 40) return null;
  const folded = foldAtPhase(times, flux, period, epoch);
  const fit = fitExactTransit(folded, { aOverRs: aRs, u1: U1, u2: U2, t0Window: 0.02 });
  if (!Number.isFinite(fit.depthFrac)) return null;
  return { depthPpm: fit.depthFrac * 1e6, errPct: (Math.abs(fit.depthFrac * 1e6 - cat) / cat) * 100, times, flux, nTransit: fit.nTransit };
}

function usable(p: ArchivePlanet): boolean {
  return p.tic != null && p.ra != null && p.dec != null
    && p.pl_orbper != null && Number.isFinite(p.pl_orbper) && p.pl_orbper >= minPeriod && p.pl_orbper <= 200
    && p.pl_tranmid != null && Number.isFinite(p.pl_tranmid)
    && (p.pl_trandep ?? 0) > 0 && (p.st_rad ?? 0) > 0;
}

console.log(
  `P14 ephemeris-refinement vs naive long fold vs per-sector (confirmed planets P >= ${minPeriod} d).\n` +
    `  exact-model fit u1=${U1}, u2=${U2}; up to ${maxSectors} sectors; want ${want} planets (Tmag <= ${tmag}). REAL photometry; no gating, no discovery claim.\n`,
);

const result = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true, limit: 6000 });
if (result.source !== "nasa-tap") console.log(`WARNING: catalog source=${result.source} (live TAP unavailable) -- labeled fallback, NOT a real test.`);
const planets = result.planets.filter(usable).slice(0, want * 3);

interface Row { name: string; period: number; nSectors: number; nEvents: number; dPct: number; longfold: number; persector: number; refined: number; }
const rows: Row[] = [];
for (const p of planets) {
  if (rows.length >= want) break;
  const tic = p.tic!;
  const name = p.pl_name ?? p.hostname ?? `TIC ${tic}`;
  const period = p.pl_orbper!;
  const cat = p.pl_trandep!;
  const sectors = await sectorsForCoord(p.ra!, p.dec!);
  if (!sectors.length) continue;
  const sectorLcs: LightCurve[] = [];
  for (const s of sectors.slice(0, maxSectors)) {
    const one = await fetchSpocLightCurve(tic, [s], name);
    if (one) sectorLcs.push(one);
  }
  if (sectorLcs.length < 2) continue; // the long fold only matters with extra sectors
  const mass = Number.isFinite(p.st_mass!) ? p.st_mass! : mainSequenceMassFromRadius(p.st_rad!);
  const aRs = aOverRsFromKepler(period, mass, p.st_rad!);
  if (!Number.isFinite(aRs) || aRs <= 1) continue;
  const stitched = stitchLightCurves(sectorLcs);
  if (!stitched) continue;

  // (1) naive long fold at the catalog ephemeris
  const naive = fitDepth(stitched, period, p.pl_tranmid!, aRs, cat);
  // (2) per-sector median (p12's robust baseline)
  const perSectorDepths = sectorLcs
    .map((lc) => fitDepth(lc, period, p.pl_tranmid!, aRs, cat))
    .filter((m): m is NonNullable<typeof m> => m != null)
    .map((m) => m.depthPpm);
  if (perSectorDepths.length === 0 || !naive) continue;
  const perErr = (Math.abs(median(perSectorDepths) - cat) / cat) * 100;

  // (3) refine the ephemeris from per-transit timings, then fold the long baseline at the refined value
  const events = timeTransitEvents(naive.times, naive.flux, period, p.pl_tranmid!, { windowPhase: 0.05 });
  const refit = refitEphemeris(events);
  let refinedErr = NaN;
  let dPct = NaN;
  if (Number.isFinite(refit.periodDays) && refit.nEvents >= 3) {
    const ref = fitDepth(stitched, refit.periodDays, refit.t0Bjd, aRs, cat);
    if (ref) refinedErr = ref.errPct;
    dPct = ((refit.periodDays - period) / period) * 100;
  }

  rows.push({ name, period, nSectors: sectorLcs.length, nEvents: refit.nEvents, dPct, longfold: naive.errPct, persector: perErr, refined: refinedErr });
  console.log(
    `  ${name.padEnd(16)} P=${period.toFixed(1)}d nsec ${sectorLcs.length} nT${refit.nEvents} dP=${Number.isFinite(dPct) ? dPct.toFixed(3) : "n/a"}%  ` +
      `err  long ${pct(naive.errPct)}  persector ${pct(perErr)}  refined ${pct(refinedErr)}`,
  );
}

if (rows.length < 4) {
  console.log(`\nOnly ${rows.length} measurable multi-sector long-period planets (TAP fallback or few sectors). Retry or raise --tmag.`);
  process.exit(0);
}

const longErr = rows.map((r) => r.longfold).filter(Number.isFinite);
const perErr = rows.map((r) => r.persector).filter(Number.isFinite);
const refErr = rows.map((r) => r.refined).filter(Number.isFinite);
const refBeatsLong = rows.filter((r) => Number.isFinite(r.refined) && r.refined < r.longfold).length;
const refBeatsPer = rows.filter((r) => Number.isFinite(r.refined) && Number.isFinite(r.persector) && r.refined < r.persector).length;
const dPcts = rows.map((r) => Math.abs(r.dPct)).filter(Number.isFinite);

console.log(`\n=== P14 SUMMARY (${rows.length} multi-sector long-period planets) ===`);
console.log(`  median depth |err|  naive long fold    : ${pct(median(longErr))}`);
console.log(`  median depth |err|  per-sector median  : ${pct(median(perErr))}   (p12's robust baseline)`);
console.log(`  median depth |err|  refined-ephem fold  : ${pct(median(refErr))}   (O-C refit, whole baseline coherent)`);
console.log(`  refined beats naive-fold on ${refBeatsLong}/${rows.length}; beats per-sector on ${refBeatsPer}/${rows.length}`);
console.log(`  |refined - catalog| period shift: median ${median(dPcts).toFixed(3)}% (max ${Math.max(...dPcts).toFixed(3)}%)`);
const medRef = median(refErr);
const medPer = median(perErr);
const medLong = median(longErr);
if (Number.isFinite(medRef) && medRef <= medPer + 1 && medRef < medLong) {
  console.log(`  => FINDING: refining the ephemeris from per-transit timings repairs the long fold -- it now matches or beats the per-sector median while using the whole baseline coherently. The phase-coherence cliff is addressed; long-period depth/size becomes trustworthy.`);
} else if (Number.isFinite(medRef) && medRef < medLong) {
  console.log(`  => FINDING: refinement clearly helps the long fold (below the naive ${pct(medLong)}) but does not yet beat per-sector median (${pct(medPer)}); extra sectors help, but per-transit timing precision on faint long-period hosts is still the limit.`);
} else {
  console.log(`  => FINDING: refinement did NOT beat the naive long fold on this sample -- on these real, noisy long-period hosts the per-transit timings are too sparse/uncertain to recover a better ephemeris, so per-sector median remains the robust choice. Honest negative result.`);
}
console.log(`\nREMINDER: this tests a METHOD on already-confirmed planets. Nothing is anchored or claimed as a discovery.`);
