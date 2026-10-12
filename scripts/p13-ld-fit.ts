// P13 - can we LOWER the limb-darkening floor by fitting u1 to the data? (real TESS-SPOC, bright planets)
//
// p9 established that the depth-accuracy floor (~12%) is set by the UNKNOWN limb darkening of each
// star, not photon noise, and it deliberately carried a single fixed solar-like law (u1=0.4, u2=0.1),
// CLAIMING that fitting u1,u2 per host would "just trade one uncertainty for a worse degeneracy on
// one-sector cadences." This probe TESTS that claim instead of asserting it: for the brightest, most
// high-SNR confirmed planets (deep, short-period, well-sampled -- the regime where limb darkening is
// most fittable), it profiles the exact-model fit over u1 (with u2 tied to u1) and asks whether the
// data-chosen limb darkening recovers the catalog DEPTH better than the fixed law, or whether the
// extra freedom just overfits (rms down, but catalog error NOT down).
//
// Whichever way it lands is the honest result: a win means we can beat the LD floor on bright stars;
// a wash/regression CONFIRMS the fixed-law choice and the degeneracy argument. Research probe only --
// it does NOT touch transitFit, the production path, or any gate, and claims no discovery.
//
// Run:  npx tsx scripts/p13-ld-fit.ts --targets 15 --tmag 9.5
import { preprocess } from "../src/detect/detrend.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import type { ArchivePlanet, LightCurve } from "../src/core/types.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return def;
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

const want = Math.round(arg("targets", 15));
const tmag = arg("tmag", 9.5);
const minDepth = arg("mindepth", 3000); // ppm -- deep enough that the shape (and so LD) is measurable
const FIXED_U1 = 0.4;
const FIXED_U2 = 0.1;
// u1 grid with u2 tied by a fixed quadratic-law relation, so we add ONE free parameter, not two.
const U1_GRID: number[] = [];
for (let u = 0; u <= 0.8001; u += 0.05) U1_GRID.push(Number(u.toFixed(2)));
const tieU2 = (u1: number): number => 0.35 * u1;

function usable(p: ArchivePlanet): boolean {
  return p.tic != null && p.ra != null && p.dec != null
    && p.pl_orbper != null && Number.isFinite(p.pl_orbper) && p.pl_orbper > 0 && p.pl_orbper < 13
    && p.pl_tranmid != null && Number.isFinite(p.pl_tranmid)
    && (p.pl_trandep ?? 0) >= minDepth
    && p.st_rad != null && p.st_rad > 0;
}

async function lcFor(p: ArchivePlanet): Promise<LightCurve | null> {
  try {
    const sectors = await sectorsForCoord(p.ra!, p.dec!);
    for (const s of sectors.slice(0, 3)) {
      const lc = await fetchSpocLightCurve(p.tic!, [s], p.pl_name ?? `TIC ${p.tic}`);
      if (lc) return lc;
    }
  } catch { /* leave null */ }
  return null;
}

console.log(
  `P13 fit-u1 vs fixed limb darkening on the brightest high-SNR confirmed planets (deep >= ${minDepth} ppm, P < 13 d).\n` +
    `  u1 profiled over [0,0.8] with u2 = 0.35*u1 (one extra parameter); fixed law u1=${FIXED_U1}, u2=${FIXED_U2}.` +
    `  want ${want} planets (Tmag <= ${tmag}). REAL photometry; research probe, no gating, no discovery claim.\n`,
);

const result = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true, limit: Math.max(200, want * 12) });
if (result.source !== "nasa-tap") {
  console.log(`WARNING: catalog source=${result.source} (live TAP unavailable) -- labeled fallback, NOT a real test.`);
}
// Brightest first (lowest TESS magnitude) so we test the regime where LD is most fittable.
const picked = result.planets
  .filter(usable)
  .sort((a, b) => (a.sy_tmag ?? 99) - (b.sy_tmag ?? 99))
  .slice(0, want * 3);

interface Row { name: string; period: number; tmag: number; errFixed: number; errLdFit: number; u1star: number; rmsFixed: number; rmsLdFit: number; nIn: number; }
const rows: Row[] = [];
for (const p of picked) {
  if (rows.length >= want) break;
  const lc = await lcFor(p);
  if (!lc) continue;
  const clean = preprocess(lc, 0.5);
  const times = clean.points.map((pt) => pt.time);
  const flux = clean.points.map((pt) => pt.flux);
  if (flux.length < 60) continue;
  const period = p.pl_orbper!;
  const mass = Number.isFinite(p.st_mass!) ? p.st_mass! : mainSequenceMassFromRadius(p.st_rad!);
  const aOverRs = aOverRsFromKepler(period, mass, p.st_rad!);
  if (!Number.isFinite(aOverRs) || aOverRs <= 1) continue;
  const folded = foldAtPhase(times, flux, period, p.pl_tranmid!);
  const cat = p.pl_trandep!;

  const fixed = fitExactTransit(folded, { aOverRs, t0Window: 0.02, u1: FIXED_U1, u2: FIXED_U2 });
  if (!Number.isFinite(fixed.depthFrac)) continue;

  // Profile over u1: keep the fit with the lowest rms (the data's preferred limb darkening).
  let best: { u1: number; depth: number; rms: number } | null = null;
  for (const u1 of U1_GRID) {
    const f = fitExactTransit(folded, { aOverRs, t0Window: 0.02, u1, u2: tieU2(u1) });
    if (!Number.isFinite(f.depthFrac) || !Number.isFinite(f.rms)) continue;
    if (!best || f.rms < best.rms) best = { u1, depth: f.depthFrac * 1e6, rms: f.rms };
  }
  if (!best) continue;

  const errFixed = (Math.abs(fixed.depthFrac * 1e6 - cat) / cat) * 100;
  const errLdFit = (Math.abs(best.depth - cat) / cat) * 100;
  rows.push({
    name: p.pl_name ?? `TIC ${p.tic}`, period, tmag: p.sy_tmag ?? NaN,
    errFixed, errLdFit, u1star: best.u1, rmsFixed: fixed.rms, rmsLdFit: best.rms, nIn: fixed.nInWindow,
  });
  console.log(
    `  ${(p.pl_name ?? `TIC ${p.tic}`).padEnd(16)} P=${period.toFixed(2)}d T=${(p.sy_tmag ?? NaN).toFixed(1)} nin=${fixed.nInWindow}  ` +
      `cat=${cat.toFixed(0)}  fixed ${fixed.depthFrac * 1e6 | 0}ppm(${pct(errFixed)})  ` +
      `u1fit=${best.u1.toFixed(2)} ${best.depth | 0}ppm(${pct(errLdFit)})  rms ${(fixed.rms * 1e3).toFixed(2)}->${(best.rms * 1e3).toFixed(2)}e-3`,
  );
}

if (rows.length < 4) {
  console.log(`\nOnly ${rows.length} measurable bright planets (TAP fallback or too few bright). Retry or raise --tmag.`);
  process.exit(0);
}

const errF = rows.map((r) => r.errFixed);
const errL = rows.map((r) => r.errLdFit);
const improved = rows.filter((r) => r.errLdFit < r.errFixed).length;
const rmsDropped = rows.filter((r) => r.rmsLdFit <= r.rmsFixed).length;
const u1s = rows.map((r) => r.u1star);

console.log(`\n=== P13 SUMMARY (${rows.length} bright, high-SNR confirmed planets) ===`);
console.log(`  median depth |err|, FIXED solar LD : ${pct(median(errF))}`);
console.log(`  median depth |err|, u1 FIT to data : ${pct(median(errL))}`);
console.log(`  u1-fit beats fixed on ${improved}/${rows.length} planets; fitted rms dropped on ${rmsDropped}/${rows.length} (extra freedom always fits scatter better)`);
console.log(`  fitted u1* distribution: median ${median(u1s).toFixed(2)}, range ${Math.min(...u1s).toFixed(2)}-${Math.max(...u1s).toFixed(2)} (solar assumed ${FIXED_U1})`);
const delta = median(errF) - median(errL);
if (delta > 1.5 && improved >= rows.length * 0.6) {
  console.log(`  => FINDING: on bright, well-sampled transits, letting the DATA choose u1 LOWERS the depth error vs the fixed law -- the LD floor p9 measured is at least partly beatable in the high-SNR regime.`);
} else if (Math.abs(delta) <= 1.5) {
  console.log(`  => FINDING: fitting u1 does NOT meaningfully change the depth error (rms drops but catalog error is flat) -- the added freedom is absorbed by the p-b-LD degeneracy. This CONFIRMS the fixed-law choice in p9 rather than contradicting it.`);
} else {
  console.log(`  => FINDING: fitting u1 makes the depth error WORSE than the fixed law -- the degeneracy on one-sector cadences is real and fitting per-host LD is counterproductive. Fixed solar law retained.`);
}
console.log(`\nREMINDER: this tests a METHOD choice on already-confirmed planets. Nothing is anchored or claimed as a discovery.`);
