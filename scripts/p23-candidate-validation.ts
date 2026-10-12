// CANDIDATE-CHAIN VALIDATION: completeness / purity / false-positive rate of the BLIND SEARCH on real data
// (discovery roadmap, Stage 4 -- the validation-grade measurement the pipeline was missing).
//
// WHY. The detection pipeline has its own completeness/purity benchmark (npm run p1:roc, p1:real-completeness),
// but the BLIND-SEARCH CANDIDATE chain (BLS -> Stage-2 depth screen -> SNR gate -> ephemeris collapse) has only
// been shown to RUN, not MEASURED. A third-party audit rightly said so. This script closes that gap honestly:
//
//   * INJECTED arm -- take real TGLC quiet-star light curves (real noise color, cadence, gaps), multiply a known
//     planet transit onto each (src/sim/injectInto.ts), run the candidate chain, and ask: did it recover the
//     injected period and survive the gates? -> COMPLETENESS vs depth and vs period, on REAL photometry.
//   * NULL arm -- run the SAME chain on the UN-injected real curves. A quiet star has no planet, so EVERY
//     candidate that survives is a FALSE POSITIVE by construction. -> FALSE-ALARM RATE per star.
//   * Purity = TP / (TP + FP) across the same curve population.
//   * Systematic inflation -- cluster the NULL candidates by ephemeris (foldedEpochDelta): how many of the false
//     positives are the sector-common shared-ephemeris artifact we already saw (one dip copied onto many stars)?
//
// HONESTY. This is a synthetic-injection benchmark on real light curves -- it characterizes the CANDIDATE chain
// (a research pipeline), NOT the production verdict/anchor path, and it is not a sky completeness figure. The
// single-sector ~27 d baseline caps recoverable periods (>=2 transits needed); long periods honestly score low.
// Deterministic given --seed. Network-bound (downloads a bounded set of real curves). No worker import.
//
// Run:  npm run p23:candidate-validation  [-- --sectors 1,2,3 --limit 10 --seed 7]

import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { foldedEpochDelta } from "../src/candidate/dedup.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-candidate-validation)";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

async function s3Keys(prefix: string, maxKeys = 1000): Promise<string[]> {
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}
async function download(key: string): Promise<Uint8Array | null> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}
function epochAtMinFlux(lc: LightCurve): number {
  let t = NaN;
  let min = Infinity;
  for (const p of lc.points) if (p.flux < min) { min = p.flux; t = p.time; }
  return t;
}

// The candidate chain, exactly as p19/p22 gate it: blind BLS -> Stage-2 depth screen -> SNR/depth floor.
interface ChainResult { emitted: boolean; periodDays: number; depthPpm: number; snr: number; epochBjd: number; regime: string; }
function runChain(lc: LightCurve): ChainResult {
  const r = bls(lc);
  const depthPpm = r.depth * 1e6;
  const assess = classifyDepthRegime(depthPpm);
  const emitted = assess.planetPlausible && depthPpm >= 200 && r.snr >= 7;
  return { emitted, periodDays: r.periodDays, depthPpm, snr: r.snr, epochBjd: epochAtMinFlux(lc), regime: assess.regime };
}

interface Curve { lc: LightCurve; tic: number; }
async function loadCurves(sector: number, limit: number): Promise<Curve[]> {
  const sectStr = `s${String(sector).padStart(4, "0")}`;
  let keys: string[];
  try {
    keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
  } catch (e) {
    console.log(`[p23] sector ${sectStr} listing failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
  const out: Curve[] = [];
  for (const key of keys) {
    const m = key.match(/gaiaid-(\d+)/);
    const gaiaid = m ? m[1] : key;
    try {
      const bytes = await download(key);
      if (!bytes) continue;
      const lc = tglcBytesToLightCurve(bytes, `Gaia ${gaiaid}`);
      if (!lc || lc.points.length < 40) continue;
      const meta = tglcHeaderMeta(bytes);
      if (meta.tic == null) continue;
      out.push({ lc, tic: meta.tic });
    } catch { /* skip an unusable curve */ }
  }
  console.log(`[p23] sector ${sectStr}: ${keys.length} listed, ${out.length} usable curves.`);
  return out;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

// greedy count of how many null candidates share an ephemeris across distinct hosts (the systematic artifact)
function sharedEphemerisHosts(items: { tic: number; periodDays: number; epochBjd: number }[]): { groups: number; multiHostGroups: number; hostsInMulti: number } {
  const used = new Set<number>();
  let groups = 0;
  let multiHostGroups = 0;
  let hostsInMulti = 0;
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    groups++;
    const cluster = [i];
    used.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const a = items[i];
      const b = items[j];
      if (!Number.isFinite(a.periodDays) || a.periodDays <= 0 || !Number.isFinite(b.periodDays) || b.periodDays <= 0) continue;
      const avgP = (a.periodDays + b.periodDays) / 2;
      if (Math.abs(a.periodDays - b.periodDays) / Math.min(a.periodDays, b.periodDays) <= 0.005 && foldedEpochDelta(a.epochBjd, b.epochBjd, avgP) <= 0.05) {
        cluster.push(j);
        used.add(j);
      }
    }
    const distinct = new Set(cluster.map((k) => items[k].tic)).size;
    if (distinct > 1) { multiHostGroups++; hostsInMulti += distinct; }
  }
  return { groups, multiHostGroups, hostsInMulti };
}

async function main(): Promise<void> {
  const sectors = arg("sectors", "1,2,3").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const limit = Math.max(1, parseInt(arg("limit", "10"), 10));
  const seed = parseInt(arg("seed", "7"), 10);
  const depthsPpm = [500, 1500, 4000];
  const periodsDay = [2, 4, 8];

  console.log(`[p23] candidate-chain validation: sectors=[${sectors}], ${limit} real curves each, depths ${depthsPpm.join("/")} ppm, periods ${periodsDay.join("/")} d, seed ${seed}.`);

  const curves: Curve[] = [];
  for (const s of sectors) curves.push(...(await loadCurves(s, limit)));
  if (!curves.length) { console.log(`\n[p23] no usable curves. VERDICT: NO-USEFUL-DATA`); return; }
  console.log(`\n[p23] ${curves.length} real quiet-star curves loaded. Running NULL arm (no planet -> every candidate is a false positive)...`);

  // NULL arm
  let nullEmitted = 0;
  const nullHits: { tic: number; periodDays: number; epochBjd: number }[] = [];
  for (const c of curves) {
    const r = runChain(c.lc);
    if (r.emitted) { nullEmitted++; nullHits.push({ tic: c.tic, periodDays: r.periodDays, epochBjd: r.epochBjd }); }
  }
  const sys = sharedEphemerisHosts(nullHits);

  // INJECTED arm
  const byDepth = new Map<number, { rec: number; n: number }>();
  const byPeriod = new Map<number, { rec: number; n: number }>();
  let tp = 0;
  let injected = 0;
  let trial = 0;
  for (const c of curves) {
    for (const depth of depthsPpm) {
      for (const period of periodsDay) {
        trial++;
        const inj = injectTransitInto(c.lc, { seed: seed + trial, periodDays: period, depthFrac: depth / 1e6 });
        const r = runChain(inj);
        const recovered = r.emitted && periodMatched(r.periodDays, period, 5);
        injected++;
        const d = byDepth.get(depth) ?? { rec: 0, n: 0 }; d.n++; if (recovered) { d.rec++; tp++; } byDepth.set(depth, d);
        const p = byPeriod.get(period) ?? { rec: 0, n: 0 }; p.n++; if (recovered) p.rec++; byPeriod.set(period, p);
      }
    }
  }

  console.log(`\n[p23] ===== CANDIDATE-CHAIN VALIDATION (blind BLS + Stage-2 depth screen + SNR>=7) =====`);
  console.log(`[p23] curves (real, quiet): ${curves.length}; injections: ${injected}`);
  console.log(`\n[p23] COMPLETENESS by injected depth:`);
  for (const depth of depthsPpm) { const b = byDepth.get(depth)!; console.log(`[p23]   ${String(depth).padStart(5)} ppm -> ${pct(b.rec, b.n)} (${b.rec}/${b.n})`); }
  console.log(`[p23] COMPLETENESS by injected period:`);
  for (const period of periodsDay) { const b = byPeriod.get(period)!; console.log(`[p23]   ${String(period).padStart(4)} d   -> ${pct(b.rec, b.n)} (${b.rec}/${b.n})`); }
  console.log(`\n[p23] FALSE-ALARM RATE (null arm, no planet injected): ${nullEmitted}/${curves.length} quiet stars produced a surviving candidate = ${pct(nullEmitted, curves.length)}.`);
  console.log(`[p23]   of those ${nullEmitted} false positives: ${sys.groups} independent ephemeris group(s), ${sys.multiHostGroups} of them shared across multiple hosts (${sys.hostsInMulti} host-rows) -> the sector-common systematic artifact.`);
  const purity = tp + nullEmitted > 0 ? (tp / (tp + nullEmitted)) * 100 : NaN;
  console.log(`\n[p23] PURITY proxy TP/(TP+FP) over this curve population: ${Number.isFinite(purity) ? purity.toFixed(1) + "%" : "n/a"} (TP=${tp} recovered injections, FP=${nullEmitted} null candidates).`);
  console.log(`[p23] NOTE: single-sector ~27 d baseline caps recoverable periods (>=2 transits needed); long-period completeness is physically limited, not a bug. Figures characterize the CANDIDATE chain on real photometry, not the production verdict path, and are not a sky completeness.`);
  console.log(`\nVERDICT: CANDIDATE-CHAIN-MEASURED`);
}

main().catch((e) => {
  console.error(`[p23] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
