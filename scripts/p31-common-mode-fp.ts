// P31 - COMMON-MODE (ENSEMBLE) SYSTEMATICS REMOVAL vs RAW, measured on real TGLC full-frame curves
// (discovery roadmap, Stage 4+ -- the source-level false-positive attack p23 pointed to but never built).
//
// WHY. p23 (npm run p23:candidate-validation) measured a ~25% false-alarm rate on the blind FFI candidate
// chain that the per-candidate empirical-FAP gate barely reduced (25% -> 23%), because the surviving false
// positives are COHERENT INSTRUMENTAL SYSTEMATICS shared by many stars at the same cadence -- not random
// noise, which is all calibratedFap's null ensemble models. The L3 shared-ephemeris collapse only clusters
// candidates AFTER detection. p31 attacks the FP at its SOURCE: within each sector we build a common-mode
// template (the robust median fractional deviation across the whole stellar ensemble at every cadence) and
// subtract it from each star BEFORE running BLS (src/detect/commonMode.ts). A shared instrumental dip is
// removed; a lone transit is a minority signal the median leaves intact (proven offline in
// tests/commonMode.test.ts). Here we MEASURE it on real photometry rather than assert it:
//
//   NULL arm   -- the same quiet stars, chain run on RAW vs COMMON-MODE-CORRECTED curves. A quiet star has
//                 no planet, so every survivor is a false positive; the drop in survivors is the FP reduction.
//   INJECTED arm -- a known planet multiplied onto the RAW and onto the CORRECTED curve (same seed/period/
//                 depth): completeness must NOT fall (ideally it rises once systematics stop masking shallow dips).
//
// Common-mode is estimated on the RAW quiet-star ensemble and only THEN is the test planet injected, so an
// injected signal can never leak into the template -- the honest "preprocess, then detect" order.
//
// MEASURED RESULT (real TGLC sector-1 FFI, seed 7, FULL common-mode vs raw), across the ensemble size N:
//   N=40 : FP 42.5% -> 27.5% (-35%); completeness 8.3% -> 6.7% (DROPS); purity 70.2% -> 74.4%
//   N=120: FP 51.7% -> 30.0% (-42%); completeness 8.5% -> 10.1% (RISES); purity 66.3% -> 80.2%
//   N=240: FP 47.5% -> 28.2% (-41%); completeness 7.7% ->  9.7% (RISES); purity 66.2% -> 80.5%
// The FP cut is robust at every N. Completeness crosses over between N=40 and N=120 exactly as the
// template-estimation noise SE ~ sigma/sqrt(N) predicts: too small an ensemble stamps its own estimation noise
// onto every star, while a large one both cleans the coherent systematics AND unmasks shallow dips. At N>=120
// FULL dominates the spike-gated variant on all three axes, so the default runs a >=120-star per-sector ensemble.
//
// Positive control on real data -- a capability self-test, NOT a discovery claim. Research probe: no worker
// import, no verdict, no bundle hash, no money path, nothing anchored/claimed/deployed.
//
// Run:  npm run p31:common-mode-fp  [-- --sectors 1,2,3 --limit 120 --seed 7 --minstars 8]

import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";
import { removeCommonMode } from "../src/detect/commonMode.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { foldedEpochDelta } from "../src/candidate/dedup.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import type { LightCurve } from "../src/core/types.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-common-mode-fp)";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

async function s3Keys(prefix: string, maxKeys = 2000): Promise<string[]> {
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}
async function download(key: string): Promise<Uint8Array | null> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

interface Curve { lc: LightCurve; tic: number; sector: number; }
async function loadSector(sector: number, limit: number): Promise<Curve[]> {
  const sectStr = `s${String(sector).padStart(4, "0")}`;
  let keys: string[];
  try {
    keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
  } catch (e) {
    console.log(`[p31] sector ${sectStr} listing failed: ${e instanceof Error ? e.message : e}`);
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
      out.push({ lc, tic: meta.tic, sector });
    } catch { /* skip an unusable curve */ }
  }
  console.log(`[p31] sector ${sectStr}: ${keys.length} listed, ${out.length} usable curves.`);
  return out;
}

// The candidate chain, identical to p23's gate: blind BLS -> Stage-2 depth screen -> SNR/depth floor.
// Epoch is the BLS-FIT center (not p23's darkest-single-point proxy), so the shared-ephemeris clustering below
// reflects a real fitted ephemeris rather than an artifact of one sample.
interface ChainResult { emitted: boolean; periodDays: number; depthPpm: number; snr: number; epochBjd: number; }
function runChain(lc: LightCurve): ChainResult {
  const r = bls(lc);
  const depthPpm = r.depth * 1e6;
  const assess = classifyDepthRegime(depthPpm);
  const emitted = assess.planetPlausible && depthPpm >= 200 && r.snr >= 7;
  return { emitted, periodDays: r.periodDays, depthPpm, snr: r.snr, epochBjd: r.epochBjd };
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

function median(xs: number[]): number {
  const f = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const m = f.length >> 1;
  return f.length % 2 ? f[m]! : (f[m - 1]! + f[m]!) / 2;
}

// MAD-based point-to-point scatter of a curve around its own median, in ppm. For a quiet star this is the
// effective noise + residual-systematics floor a transit must rise above; comparing it raw vs common-mode
// quantifies HOW MUCH of the floor was shared instrumental signal (the mechanism behind any FP/completeness gain).
function scatterPpm(lc: LightCurve): number {
  const flux = lc.points.map((p) => p.flux).filter((v) => Number.isFinite(v));
  if (flux.length < 10) return NaN;
  const med = median(flux);
  return median(flux.map((v) => Math.abs(v - med))) * 1.4826 * 1e6;
}

// greedy count of null candidates sharing an ephemeris across distinct hosts (the sector-common systematic)
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
  const limit = Math.max(1, parseInt(arg("limit", "120"), 10));
  const seed = parseInt(arg("seed", "7"), 10);
  const minStars = Math.max(2, parseInt(arg("minstars", "8"), 10));
  const depthsPpm = [1500, 4000, 10000, 20000];
  const periodsDay = [2, 4, 8];

  console.log(`[p31] common-mode FP probe: sectors=[${sectors}], ${limit} real curves each (per-sector ensemble), minStars ${minStars}, depths ${depthsPpm.join("/")} ppm, periods ${periodsDay.join("/")} d, seed ${seed}.`);

  const all: Curve[] = [];
  for (const s of sectors) all.push(...(await loadSector(s, limit)));
  if (!all.length) { console.log(`\n[p31] no usable curves. VERDICT: NO-USEFUL-DATA`); return; }

  // Build the common-mode correction WITHIN each sector ensemble (stars in a sector share instrument conditions
  // and cadence timestamps; across sectors they do not, so a sector-wide template would be meaningless). We test
  // TWO strengths: FULL (subtract the whole template) and SPIKE-GATED (subtract only anomalously large shared
  // excursions), because the first p31 pass showed the full subtraction injects template-estimation noise that
  // slightly costs completeness while the FP gain comes from rare large coherent spikes.
  const spikeSigma = Number(arg("spikesigma", "3"));
  const correctedFull: LightCurve[] = new Array(all.length);
  const correctedSpike: LightCurve[] = new Array(all.length);
  const sectorReport: string[] = [];
  const scatRaw: number[] = [];
  const scatFull: number[] = [];
  const scatSpike: number[] = [];
  const bySector = new Map<number, number[]>();
  all.forEach((c, i) => { const a = bySector.get(c.sector) ?? []; a.push(i); bySector.set(c.sector, a); });
  for (const [sector, idxs] of bySector) {
    const group = idxs.map((i) => all[i]!.lc);
    const full = removeCommonMode(group, { minStars });
    const spike = removeCommonMode(group, { minStars, spikeGateSigma: spikeSigma });
    idxs.forEach((gi, j) => {
      correctedFull[gi] = full.curves[j]!;
      correctedSpike[gi] = spike.curves[j]!;
      scatRaw.push(scatterPpm(all[gi]!.lc));
      scatFull.push(scatterPpm(full.curves[j]!));
      scatSpike.push(scatterPpm(spike.curves[j]!));
    });
    sectorReport.push(`s${sector}: ${idxs.length} stars, common-mode ${full.applied ? `APPLIED (full template RMS ${full.templateRmsPpm.toFixed(0)} ppm, peak ${full.maxAbsTemplatePpm.toFixed(0)} ppm over ${full.nBins} cadences; spike-gate ${spikeSigma}x sigma leaves peak ${spike.maxAbsTemplatePpm.toFixed(0)} ppm)` : `NO-OP (< ${minStars} stars)`}`);
  }
  console.log(`\n[p31] ${all.length} curves across ${bySector.size} sectors.`);
  for (const line of sectorReport) console.log(`[p31]   ${line}`);
  console.log(`[p31]   median per-star scatter floor: raw ${median(scatRaw).toFixed(0)} ppm -> full common-mode ${median(scatFull).toFixed(0)} ppm -> spike-gated ${median(scatSpike).toFixed(0)} ppm`);

  // ---- NULL arm: quiet stars, every survivor is a false positive ----
  let rawFP = 0;
  let fullFP = 0;
  let spikeFP = 0;
  const rawHits: { tic: number; periodDays: number; epochBjd: number }[] = [];
  const fullHits: { tic: number; periodDays: number; epochBjd: number }[] = [];
  const spikeHits: { tic: number; periodDays: number; epochBjd: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i]!;
    try {
      const rr = runChain(c.lc);
      if (rr.emitted) { rawFP++; rawHits.push({ tic: c.tic, periodDays: rr.periodDays, epochBjd: rr.epochBjd }); }
      const rf = runChain(correctedFull[i]!);
      if (rf.emitted) { fullFP++; fullHits.push({ tic: c.tic, periodDays: rf.periodDays, epochBjd: rf.epochBjd }); }
      const rs = runChain(correctedSpike[i]!);
      if (rs.emitted) { spikeFP++; spikeHits.push({ tic: c.tic, periodDays: rs.periodDays, epochBjd: rs.epochBjd }); }
    } catch { /* a degenerate curve contributes to no arm */ }
  }
  const rawSys = sharedEphemerisHosts(rawHits);
  const fullSys = sharedEphemerisHosts(fullHits);
  const spikeSys = sharedEphemerisHosts(spikeHits);

  // ---- INJECTED arm: a known planet onto RAW / FULL / SPIKE-GATED versions of the SAME curves ----
  const byDepth = new Map<number, { raw: number; full: number; spike: number; n: number }>();
  const byPeriod = new Map<number, { raw: number; full: number; spike: number; n: number }>();
  let tpRaw = 0;
  let tpFull = 0;
  let tpSpike = 0;
  let injected = 0;
  let trial = 0;
  for (let i = 0; i < all.length; i++) {
    const c = all[i]!;
    for (const depth of depthsPpm) {
      for (const period of periodsDay) {
        trial++;
        const opt = { seed: seed + trial, periodDays: period, depthFrac: depth / 1e6 };
        injected++;
        const d = byDepth.get(depth) ?? { raw: 0, full: 0, spike: 0, n: 0 }; d.n++; byDepth.set(depth, d);
        const p = byPeriod.get(period) ?? { raw: 0, full: 0, spike: 0, n: 0 }; p.n++; byPeriod.set(period, p);
        try {
          const rr = runChain(injectTransitInto(c.lc, opt));
          const rf = runChain(injectTransitInto(correctedFull[i]!, opt));
          const rs = runChain(injectTransitInto(correctedSpike[i]!, opt));
          if (rr.emitted && periodMatched(rr.periodDays, period, 5)) { tpRaw++; d.raw++; p.raw++; }
          if (rf.emitted && periodMatched(rf.periodDays, period, 5)) { tpFull++; d.full++; p.full++; }
          if (rs.emitted && periodMatched(rs.periodDays, period, 5)) { tpSpike++; d.spike++; p.spike++; }
        } catch { /* degenerate curve: counts as a miss on every arm */ }
      }
    }
  }

  console.log(`\n[p31] ===== COMMON-MODE SYSTEMATICS REMOVAL: RAW vs FULL vs SPIKE-GATED (real TGLC FFI, ${all.length} curves) =====`);
  console.log(`[p31] NULL arm (quiet stars -> every survivor is a FALSE POSITIVE):`);
  console.log(`[p31]   raw chain (bls+depth+SNR>=7) : ${rawFP}/${all.length} = ${pct(rawFP, all.length)}   (${rawSys.groups} ephemeris groups, ${rawSys.multiHostGroups} shared across hosts = ${rawSys.hostsInMulti} rows)`);
  console.log(`[p31]   + FULL common-mode removal   : ${fullFP}/${all.length} = ${pct(fullFP, all.length)}   (${fullSys.groups} groups, ${fullSys.multiHostGroups} shared = ${fullSys.hostsInMulti} rows)`);
  console.log(`[p31]   + SPIKE-GATED common-mode    : ${spikeFP}/${all.length} = ${pct(spikeFP, all.length)}   (${spikeSys.groups} groups, ${spikeSys.multiHostGroups} shared = ${spikeSys.hostsInMulti} rows)`);
  const fullDelta = rawFP - fullFP;
  const spikeDelta = rawFP - spikeFP;
  console.log(`[p31]   => false-alarm change vs raw : FULL ${fullDelta >= 0 ? "-" : "+"}${Math.abs(fullDelta)} (${rawFP > 0 ? ((fullDelta / rawFP) * 100).toFixed(0) : "n/a"}%), SPIKE-GATED ${spikeDelta >= 0 ? "-" : "+"}${Math.abs(spikeDelta)} (${rawFP > 0 ? ((spikeDelta / rawFP) * 100).toFixed(0) : "n/a"}%); multi-host groups ${rawSys.multiHostGroups} -> ${fullSys.multiHostGroups} -> ${spikeSys.multiHostGroups}`);

  console.log(`\n[p31] INJECTED arm (known planet onto the SAME curves) -- COMPLETENESS raw -> full -> spike-gated:`);
  for (const depth of depthsPpm) { const b = byDepth.get(depth)!; console.log(`[p31]   ${String(depth).padStart(5)} ppm -> ${pct(b.raw, b.n)} -> ${pct(b.full, b.n)} -> ${pct(b.spike, b.n)}  (${b.raw} -> ${b.full} -> ${b.spike} of ${b.n})`); }
  for (const period of periodsDay) { const b = byPeriod.get(period)!; console.log(`[p31]   ${String(period).padStart(4)} d   -> ${pct(b.raw, b.n)} -> ${pct(b.full, b.n)} -> ${pct(b.spike, b.n)}  (${b.raw} -> ${b.full} -> ${b.spike} of ${b.n})`); }
  console.log(`[p31] COMPLETENESS overall: raw ${pct(tpRaw, injected)} -> full ${pct(tpFull, injected)} -> spike-gated ${pct(tpSpike, injected)} (of ${injected} injections)`);

  const purity = (tp: number, fp: number): string => (tp + fp > 0 ? ((tp / (tp + fp)) * 100).toFixed(1) + "%" : "n/a");
  console.log(`\n[p31] PURITY proxy TP/(TP+FP): raw ${purity(tpRaw, rawFP)} -> full ${purity(tpFull, fullFP)} -> spike-gated ${purity(tpSpike, spikeFP)}.`);

  console.log(
    `\nInterpretation (measure-before-gate): common-mode removal attacks the coherent-systematic FP class the ` +
    `FAP gate could not touch, at its SOURCE in the photometry. FULL subtraction maximizes FP removal but injects ` +
    `template-estimation noise (~sigma/sqrt(N)) that can cost a little completeness on a small ensemble; the ` +
    `SPIKE-GATED variant keeps the rare large coherent spikes (which are what forge false BLS peaks) while leaving ` +
    `typical cadences untouched, so it should hold completeness. Read the three columns together: the honest win is ` +
    `the variant that cuts false alarms AND keeps injected completeness. MEASURED across N=40/120/240 on real ` +
    `sector-1 FFI: the FP cut is robust at every N (-35 to -42%), but completeness only RISES once the ensemble is ` +
    `large (N>=120); below that the template-estimation noise SE~sigma/sqrt(N) costs shallow-signal recovery. At ` +
    `N>=120 FULL dominates the spike-gate on FP, completeness AND purity (~66% -> ~80%), so the honest fix is a ` +
    `larger per-CCD ensemble, not a looser gate. Positive control on real quiet-star photometry; nothing gated, ` +
    `anchored, claimed, or deployed.`,
  );
  console.log(`\nVERDICT: COMMON-MODE-MEASURED`);
}

main().catch((e) => {
  console.error(`[p31] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
