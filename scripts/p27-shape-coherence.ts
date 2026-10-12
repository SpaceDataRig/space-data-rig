// SHAPE-COHERENCE SEPARATION: does a cheap, single-observation in-transit consistency statistic separate
// the false positives that survived p26's layers from real injected transits? (discovery roadmap, Stage 4).
//
// WHY. p26 measured that (L3) rejecting multi-host shared ephemerides cuts the coherent-systematic FP by ~63%
// at no planet cost, and that (L4) cross-sector corroboration would cut it further but is completeness-brutal on
// a shallow single-pass sample. What remains after L3 is dominated by SINGLE-HOST coherent artifacts -- one-off
// spikes, a bad column, an attitude glitch -- that BLS folds into a box whose MEAN depth is carried by a handful
// of samples. src/detect/shapeCoherence.ts compares the in-box MEDIAN drop to the box MEAN drop; a real periodic
// transit fills its box (ratio ~ 1), a one-point spike does not (ratio ~ 0). This script MEASURES how well that
// ratio separates a null-arm FP population from an injected-TP population on REAL TGLC curves.
//
// HONESTY. Measure-only: NOTHING here gates a verdict, anchors, spends, or claims a discovery. A separation is
// only a CANDIDATE discriminator until calibrated on real confirmed planets (the p2:vet-calibrate discipline).
// No empirical-FAP is run, so this is fast. Network-bound (lists sectors, downloads a bounded set).
//
// Run:  npm run p27:shape-coherence  [-- --sectors 1,2,3,4,5 --limit 12 --seed 7]

import { tglcBytesToLightCurve } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { shapeCoherence } from "../src/detect/shapeCoherence.ts";
import { foldedEpochDelta, DEFAULT_COINCIDENCE } from "../src/candidate/dedup.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-shape-coherence)";
const PERIOD_TOL_PCT = 5;

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
async function getText(url: string): Promise<string | null> {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
      if (r.ok) return await r.text();
    } catch { /* transient socket close; retry */ }
    await new Promise((res) => setTimeout(res, 350 * (a + 1)));
  }
  return null;
}
async function getBytes(url: string): Promise<Uint8Array | null> {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch { /* transient socket close; retry */ }
    await new Promise((res) => setTimeout(res, 350 * (a + 1)));
  }
  return null;
}
async function s3Keys(prefix: string, maxKeys: number): Promise<string[]> {
  const t = await getText(`${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`);
  if (t === null) throw new Error(`S3 list failed for ${prefix}`);
  return [...t.matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}
function epochAtMinFlux(lc: LightCurve): number {
  let t = NaN;
  let min = Infinity;
  for (const p of lc.points) if (p.flux < min) { min = p.flux; t = p.time; }
  return t;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}
function q(xs: number[], f: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))));
  return s[idx]!;
}

interface NullDet { hostKey: number; sector: number; periodDays: number; epochBjd: number; ratio: number; }
function coincident(a: NullDet, b: NullDet): boolean {
  if (!(a.periodDays > 0) || !(b.periodDays > 0)) return false;
  if (Math.abs(a.periodDays - b.periodDays) / Math.min(a.periodDays, b.periodDays) > DEFAULT_COINCIDENCE.periodTolPct / 100) return false;
  const avgP = (a.periodDays + b.periodDays) / 2;
  return foldedEpochDelta(a.epochBjd, b.epochBjd, avgP) <= DEFAULT_COINCIDENCE.t0TolDays;
}

async function main(): Promise<void> {
  const sectors = arg("sectors", "1,2,3,4,5").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const limit = Math.max(1, parseInt(arg("limit", "12"), 10));
  const seed = parseInt(arg("seed", "7"), 10);
  const depthsPpm = arg("depths", "500,1500,4000").split(",").map(Number).filter(Number.isFinite);
  const periodsDay = arg("periods", "2,4,8").split(",").map(Number).filter(Number.isFinite);

  console.log(`[p27] shape-coherence separation: sectors [${sectors.join(",")}], <=${limit} curves each, depths ${depthsPpm.join("/")} ppm, periods ${periodsDay.join("/")} d, seed ${seed}.`);

  // ---- sample curves (real quiet-star TGLC). ----
  const hostKeyByGaia = new Map<string, number>();
  const samples: { lc: LightCurve; hostKey: number; sector: number }[] = [];
  for (const s of sectors) {
    const sectStr = `s${String(s).padStart(4, "0")}`;
    let keys: string[];
    try {
      keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`, limit * 4)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
    } catch (e) {
      console.log(`[p27]   sector ${sectStr}: ${e instanceof Error ? e.message : e}; skipping.`);
      continue;
    }
    let got = 0;
    for (const key of keys) {
      const m = key.match(/gaiaid-(\d+)/);
      if (!m) continue;
      try {
        const bytes = await getBytes(`${S3_BASE}/${key}`);
        if (!bytes) continue;
        const lc = tglcBytesToLightCurve(bytes, `Gaia ${m[1]}`);
        if (!lc || lc.points.length < 60) continue;
        let hk = hostKeyByGaia.get(m[1]);
        if (hk == null) { hk = hostKeyByGaia.size; hostKeyByGaia.set(m[1], hk); }
        samples.push({ lc, hostKey: hk, sector: s });
        got++;
      } catch { /* skip an unusable curve */ }
    }
    console.log(`[p27]   sector ${sectStr}: ${keys.length} listed, ${got} usable.`);
  }
  if (!samples.length) { console.log(`\n[p27] no usable curves. VERDICT: NO-USEFUL-DATA`); return; }

  // ---- NULL arm: base-chain survivors -> coherence ratio. Separate single-host residual (post-L3) from multi-host. ----
  const nullDets: NullDet[] = [];
  for (const smp of samples) {
    const r = bls(smp.lc);
    const depthPpm = r.depth * 1e6;
    const emitted = classifyDepthRegime(depthPpm).planetPlausible && depthPpm >= 200 && r.snr >= 7;
    if (!emitted) continue;
    const coh = shapeCoherence(smp.lc, r);
    nullDets.push({ hostKey: smp.hostKey, sector: smp.sector, periodDays: r.periodDays, epochBjd: epochAtMinFlux(smp.lc), ratio: coh.ratio });
  }
  // mark multi-host shared-ephemeris detections (what L3 removes); the rest are single-host residual FPs.
  const isMultiHost = nullDets.map((d) => nullDets.some((o) => o.hostKey !== d.hostKey && coincident(d, o)));
  const fpAllRatio = nullDets.filter((d) => Number.isFinite(d.ratio)).map((d) => d.ratio);
  const fpResidualRatio = nullDets.filter((d, i) => !isMultiHost[i] && Number.isFinite(d.ratio)).map((d) => d.ratio);

  // ---- INJECTED arm: coherent transit on real curves -> coherence ratio (ground-truth TP). ----
  const tpRatio: number[] = [];
  let tpTrials = 0;
  let trial = 0;
  for (const smp of samples) {
    const lc = smp.lc;
    const tStart = lc.points[0] ? lc.points[0].time : 2459000;
    for (const depth of depthsPpm) {
      for (const period of periodsDay) {
        trial++;
        tpTrials++;
        const inj = injectTransitInto(lc, { seed: seed + trial, periodDays: period, depthFrac: depth / 1e6, t0Bjd: tStart + period });
        const r = bls(inj);
        if (!(r.snr >= 7 && classifyDepthRegime(r.depth * 1e6).planetPlausible && r.depth * 1e6 >= 200) || !periodMatched(r.periodDays, period, PERIOD_TOL_PCT)) continue;
        const coh = shapeCoherence(inj, r);
        if (Number.isFinite(coh.ratio)) tpRatio.push(coh.ratio);
      }
    }
  }

  // ---- report distributions + a threshold scan (measure-only, NOT a gate) ----
  console.log(`\n[p27] ===== SHAPE-COHERENCE SEPARATION =====`);
  console.log(`[p27] curves: ${samples.length}; null FP detections: ${nullDets.length} (${fpAllRatio.length} with finite ratio; ${fpResidualRatio.length} single-host residual after L3); injected TP recovered: ${tpRatio.length}/${tpTrials}\n`);
  const stat = (name: string, xs: number[]) => xs.length
    ? console.log(`[p27]   ${name}: n=${xs.length} median=${median(xs).toFixed(2)} p25=${q(xs, 0.25).toFixed(2)} p75=${q(xs, 0.75).toFixed(2)}`)
    : console.log(`[p27]   ${name}: (none)`);
  stat("TP (injected) coherence ratio ", tpRatio);
  stat("FP (all null) coherence ratio ", fpAllRatio);
  stat("FP (single-host, post-L3)     ", fpResidualRatio);
  console.log(`\n[p27] threshold scan -- at ratio < tau we WOULD flag as spike (this is NOT applied anywhere):`);
  console.log(`[p27]   tau   TP-kept(completeness)   FP-flagged(all)   FP-flagged(post-L3 residual)`);
  for (const tau of [0.3, 0.4, 0.5, 0.6]) {
    const tpKept = tpRatio.length ? (tpRatio.filter((x) => x >= tau).length / tpRatio.length) * 100 : NaN;
    const fpAllFlag = fpAllRatio.length ? (fpAllRatio.filter((x) => x < tau).length / fpAllRatio.length) * 100 : NaN;
    const fpResFlag = fpResidualRatio.length ? (fpResidualRatio.filter((x) => x < tau).length / fpResidualRatio.length) * 100 : NaN;
    const f = (v: number) => Number.isFinite(v) ? `${v.toFixed(0)}%` : "n/a";
    console.log(`[p27]   ${tau.toFixed(1)}     ${f(tpKept).padStart(6)}                    ${f(fpAllFlag).padStart(6)}              ${f(fpResFlag).padStart(6)}`);
  }
  console.log(`\n[p27] NOTE: a ratio that separates the post-L3 residual FP from the TP would be a cheap, single-observation ADDITION to corroboration; but periodic instrumental artifacts fill their box too and score ~1, so this cannot be the only tool. Measure-only -- not calibrated, not gated. Reproduce: npm run p27:shape-coherence.`);
  console.log(`\nVERDICT: SHAPE-COHERENCE-MEASURED`);
}

main().catch((e) => {
  console.error(`[p27] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
