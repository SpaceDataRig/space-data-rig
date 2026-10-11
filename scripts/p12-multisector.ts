// P12 - multi-sector baseline vs the single-sector long-period cliff (real TESS-SPOC data).
//
// A single TESS sector is only ~27 days, so a longer-period planet shows too few transits. The
// naive fix is to stitch every available sector into one long curve and fold it all at once. This
// probe tests three estimators of the transit DEPTH on confirmed planets with P >= --minperiod and
// scores each against the published catalog value (post-hoc reference only, never shown to a fit):
//   1. single    -- the best single sector (most points), the status-quo baseline.
//   2. longfold  -- all sectors stitched and folded together at the catalog ephemeris.
//   3. persector -- each sector folded+fit on its own, then the depths combined by median.
//
// The scientific point: more data does NOT automatically mean a better depth. If folding a ~1500-day
// baseline at a slightly-off catalog period drifts each transit's phase, the long fold smears the
// dip and can be WORSE than one clean sector, while per-sector fitting sidesteps the drift. We
// report whichever wins -- including the honest possibility that the cliff is a phase-coherence
// problem, not a data-volume problem.
//
// Research probe only: uses the additive stitchLightCurves helper, does NOT touch the production
// detection path, does NOT gate anything, and does NOT claim any discovery.
//
// Run:  npx tsx scripts/p12-multisector.ts --targets 18 --minperiod 10 --maxsectors 6
import { preprocess } from "../src/detect/detrend.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";
import { aOverRsFromKepler } from "../src/sim/transitModel.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(x: number): string {
  return Number.isFinite(x) ? `${x.toFixed(1)}%` : "n/a";
}
function spanDays(lc: LightCurve): number {
  const p = lc.points;
  return p.length ? p[p.length - 1].time - p[0].time : 0;
}

const want = Number(arg("targets", "18"));
const minPeriod = Number(arg("minperiod", "10"));
const maxSectors = Number(arg("maxsectors", "6"));
const tmag = Number(arg("tmag", "10.5"));
const U1 = Number(arg("u1", "0.4"));
const U2 = Number(arg("u2", "0.1"));

// Fit the exact model to one light curve and return its depth, error vs catalog, and diagnostics.
function measure(lc: LightCurve, period: number, epoch: number, aRs: number, catDepth: number) {
  const clean = preprocess(lc, 0.5);
  const times = clean.points.map((pt) => pt.time);
  const flux = clean.points.map((pt) => pt.flux);
  if (flux.length < 40) return null;
  const folded = foldAtPhase(times, flux, period, epoch);
  const fit = fitExactTransit(folded, { aOverRs: aRs, u1: U1, u2: U2, t0Window: 0.02 });
  if (!Number.isFinite(fit.depthFrac)) return null;
  const depthPpm = fit.depthFrac * 1e6;
  return {
    depthPpm,
    errPct: (Math.abs(depthPpm - catDepth) / catDepth) * 100,
    nPts: flux.length,
    nTransit: fit.nTransit,
    span: spanDays(lc),
  };
}

console.log(
  `P12 three depth estimators (confirmed planets P >= ${minPeriod} d): exact-model fit ` +
    `(u1=${U1}, u2=${U2}), up to ${maxSectors} sectors\n` +
    `  want ${want} measurable planets (Tmag <= ${tmag}); REAL photometry; research probe, no gating, no discovery claim.`,
);

const planets = (await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true, limit: 6000 })).planets
  .filter((p) => p.pl_orbper != null && Number.isFinite(p.pl_orbper) && p.pl_orbper >= minPeriod && p.pl_orbper <= 200)
  .filter((p) => p.tic != null && p.ra != null && p.dec != null && p.pl_tranmid != null && Number.isFinite(p.pl_tranmid) && (p.pl_trandep ?? 0) > 0 && (p.st_rad ?? 0) > 0)
  .slice(0, want * 3);

interface Row {
  name: string; period: number; nSectors: number;
  single: number; longfold: number; persector: number;
  singleN: number; longN: number;
}
const rows: Row[] = [];
let scanned = 0;
for (const p of planets) {
  if (rows.length >= want) break;
  scanned++;
  const tic = p.tic!;
  const name = p.pl_name ?? p.hostname ?? `TIC ${tic}`;
  const period = p.pl_orbper!;
  const catDepth = p.pl_trandep!;
  const sectors = await sectorsForCoord(p.ra!, p.dec!);
  if (!sectors.length) continue;

  // Download each sector ONCE, then derive all three estimators from the same set.
  const sectorLcs: LightCurve[] = [];
  for (const s of sectors.slice(0, maxSectors)) {
    const one = await fetchSpocLightCurve(tic, [s], name);
    if (one) sectorLcs.push(one);
  }
  if (!sectorLcs.length) continue;

  const aRs = aOverRsFromKepler(period, 1.0, p.st_rad!);
  const perSector = sectorLcs
    .map((lc) => measure(lc, period, p.pl_tranmid!, aRs, catDepth))
    .filter((m): m is NonNullable<typeof m> => m != null);
  if (perSector.length === 0) continue;

  // single = the one sector with the most points (status quo's best shot).
  const best = perSector.reduce((a, b) => (b.nPts > a.nPts ? b : a));
  const stitched = stitchLightCurves(sectorLcs);
  const long = stitched ? measure(stitched, period, p.pl_tranmid!, aRs, catDepth) : null;
  const perSectorDepth = median(perSector.map((m) => m.depthPpm));
  const perSectorErr = (Math.abs(perSectorDepth - catDepth) / catDepth) * 100;

  rows.push({
    name, period, nSectors: sectorLcs.length,
    single: best.errPct,
    longfold: long ? long.errPct : NaN,
    persector: perSectorErr,
    singleN: best.nTransit,
    longN: long ? long.nTransit : 0,
  });
  console.log(
    `  ${name.padEnd(16)} P=${period.toFixed(1)}d  nsec ${sectorLcs.length}  ` +
      `err  single ${pct(best.errPct)}  longfold ${pct(long ? long.errPct : NaN)}  persector ${pct(perSectorErr)}`,
  );
}

if (!rows.length) {
  console.log(`\nNo measurable long-period planets (TAP fallback or none with data). scanned=${scanned}. Retry shortly.`);
  process.exit(0);
}

const singleErr = rows.map((r) => r.single).filter(Number.isFinite);
const longErr = rows.map((r) => r.longfold).filter(Number.isFinite);
const perErr = rows.map((r) => r.persector).filter(Number.isFinite);
const multi = rows.filter((r) => r.nSectors >= 2);
const perBeatsSingle = rows.filter((r) => r.persector < r.single).length;
const perBeatsLong = rows.filter((r) => Number.isFinite(r.longfold) && r.persector < r.longfold).length;

console.log(`\n=== P12 SUMMARY (${rows.length} long-period planets; ${multi.length} with >=2 sectors) ===`);
console.log(`  median depth err  single sector : ${pct(median(singleErr))}`);
console.log(`  median depth err  long fold      : ${pct(median(longErr))}   (stitched, folded at catalog ephemeris)`);
console.log(`  median depth err  per-sector med : ${pct(median(perErr))}   (each sector fit alone, depths combined)`);
console.log(`  per-sector beats single on ${perBeatsSingle}/${rows.length}; beats long-fold on ${perBeatsLong}/${rows.filter((r) => Number.isFinite(r.longfold)).length}`);
console.log(`  mean in-window points  single ${Math.round(rows.reduce((a, r) => a + r.singleN, 0) / rows.length)}` +
    ` -> long-fold ${Math.round(rows.reduce((a, r) => a + r.longN, 0) / rows.length)}`);
console.log(
  `\nInterpretation: multi-sector SPOC data is widely available and the long fold gathers many more ` +
    `transit points, yet if its depth error is NOT lower than a single clean sector, the long-period ` +
    `limit is a PHASE-COHERENCE problem (catalog period drifts transits across a ~1500-day baseline), ` +
    `not a data-volume one. Per-sector fitting sidesteps that drift; combining those is the ` +
    `principled way to use the extra sectors. This is a method self-test on real public data, not a ` +
    `claim of discovering any planet.`,
);
