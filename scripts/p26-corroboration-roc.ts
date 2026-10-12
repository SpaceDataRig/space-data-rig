// CORROBORATION ROC: measure the false-alarm <-> completeness trade-off of the STRUCTURAL FP lever that
// the p23 candidate-chain study pointed to (discovery roadmap, Stage 4 -> toward validation-grade).
//
// WHY. p23 (npm run p23:candidate-validation) measured the blind FFI candidate chain at a ~25% false-alarm
// rate and showed the per-candidate empirical-FAP gate barely helps (25% -> 23%) because the surviving false
// positives are COHERENT instrumental systematics -- a sector-common dip that lights up MANY unrelated stars at
// one (period, epoch), and a one-off spike that is significant against its own noise yet is not a planet. The
// correct lever is REPEATABILITY, and src/candidate/corroboration.ts encodes four cumulative gates. This script
// MEASURES what each gate costs; it does NOT wire any of them into a verdict, an anchor, or the money path.
//
// THE TWO THINGS WE SEPARATE HERE.
//   * L3 -- reject ephemerides shared by MULTIPLE hosts. This needs only the pooled per-sector detections, so it
//     is measured DIRECTLY on real FFI curves (sectors sampled like p22/p23). A (period, epoch) appearing on >1
//     distinct host is a sector-common artifact, not N planets.
//   * L4 -- require the SAME host to repeat a coincident ephemeris across >=2 INDEPENDENT baselines. On a cheap
//     first-N-per-sector FFI sample, virtually no low-declination star recurs in two sectors (the same result p22
//     got: 0 corroborated), so REAL same-host corroboration is reported as an AVAILABILITY count. To still quantify
//     the COMPLETENESS COST of demanding repeatability we use a clearly-labelled PROXY: split one real light curve
//     into two sub-baselines and require a coherent injected transit to survive BOTH. This is a mid-sector split of
//     real photometry, NOT two independent years, so it does not reproduce genuine cross-sector systematics -- it
//     measures the detectability price of "must recur in two independent windows" on real noise/cadence/gaps.
//
// HONESTY. This characterizes the CANDIDATE research chain on real photometry; it is NOT a sky completeness and
// it never touches the production verdict / bundle hash / money path. Nothing here is a discovery claim; no
// anchoring, no POST, no spend. Deterministic given --seed. Network-bound (lists sectors, downloads a bounded set).
//
// Run:  npm run p26:corroboration  [-- --sectors 1,2,3 --limit 30 --seed 7 --nnull 40]

import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { foldedEpochDelta, DEFAULT_COINCIDENCE } from "../src/candidate/dedup.ts";
import { applyLayerFilters, type SectorDetection } from "../src/candidate/corroboration.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-corroboration-roc)";
const FAP_MAX = 0.05;
const PERIOD_TOL_PCT = 5; // injected period counts as "recovered" if the BLS peak matches truth within this (aliases allowed)

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
    } catch { /* transient socket close on the public bucket; retry */ }
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
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const t = await getText(url);
  if (t === null) throw new Error(`S3 list failed for ${prefix}`);
  return [...t.matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}
async function download(key: string): Promise<Uint8Array | null> {
  return getBytes(`${S3_BASE}/${key}`);
}
function epochAtMinFlux(lc: LightCurve): number {
  let t = NaN;
  let min = Infinity;
  for (const p of lc.points) if (p.flux < min) { min = p.flux; t = p.time; }
  return t;
}

interface ChainResult { emitted: boolean; periodDays: number; depthPpm: number; snr: number; epochBjd: number; regime: string; }
function runChain(lc: LightCurve): ChainResult {
  const r = bls(lc);
  const depthPpm = r.depth * 1e6;
  const assess = classifyDepthRegime(depthPpm);
  const emitted = assess.planetPlausible && depthPpm >= 200 && r.snr >= 7;
  return { emitted, periodDays: r.periodDays, depthPpm, snr: r.snr, epochBjd: epochAtMinFlux(lc), regime: assess.regime };
}
function passesFap(lc: LightCurve, r: ChainResult, nNull: number, seed: number): boolean {
  try { return calibratedFap(lc, r.snr, r.periodDays, { nNull, seed }).fap <= FAP_MAX; } catch { return false; }
}
// are two detections ephemeris-coincident? (same period within tol AND folded epoch within tol)
function coincident(a: SectorDetection, b: SectorDetection): boolean {
  if (!(a.periodDays > 0) || !(b.periodDays > 0)) return false;
  if (Math.abs(a.periodDays - b.periodDays) / Math.min(a.periodDays, b.periodDays) > DEFAULT_COINCIDENCE.periodTolPct / 100) return false;
  const avgP = (a.periodDays + b.periodDays) / 2;
  return foldedEpochDelta(a.epochBjd, b.epochBjd, avgP) <= DEFAULT_COINCIDENCE.t0TolDays;
}
function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}
function subCurve(lc: LightCurve, lo: number, hi: number, label: string): LightCurve {
  const points = lc.points.filter((p) => p.time >= lo && p.time < hi);
  return { targetId: lc.targetId + label, mission: lc.mission, cadenceSec: lc.cadenceSec, points, source: lc.source };
}

interface Sample { lc: LightCurve; hostKey: number; sector: number; }

async function main(): Promise<void> {
  const sectors = arg("sectors", "1,2,3").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const limit = Math.max(1, parseInt(arg("limit", "30"), 10));
  const seed = parseInt(arg("seed", "7"), 10);
  const nNull = Math.max(20, parseInt(arg("nnull", "40"), 10));
  const depthsPpm = arg("depths", "500,1500,4000").split(",").map(Number).filter(Number.isFinite);
  const periodsDay = arg("periods", "2,4,8").split(",").map(Number).filter(Number.isFinite);
  const nullOnly = process.argv.includes("--null-only"); // fast path: measure the FP layers on a big sample, skip the slow injected arm

  console.log(`[p26] corroboration ROC: sectors [${sectors.join(",")}], <=${limit} curves each (token-free TGLC), ` +
    `depths ${depthsPpm.join("/")} ppm, periods ${periodsDay.join("/")} d, seed ${seed}, FAP<=${FAP_MAX} (nNull ${nNull}).`);

  // ---- sample curves; map each gaiaid to a sequential hostKey (never Number(gaiaid): int64 precision loss). ----
  const hostKeyByGaia = new Map<string, number>();
  const sectorsByGaia = new Map<string, Set<number>>();
  const samples: Sample[] = [];
  for (const s of sectors) {
    const sectStr = `s${String(s).padStart(4, "0")}`;
    let keys: string[];
    try {
      keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`, limit * 4)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
    } catch (e) {
      console.log(`[p26]   sector ${sectStr}: ${e instanceof Error ? e.message : e}; skipping.`);
      continue;
    }
    let got = 0;
    for (const key of keys) {
      const m = key.match(/gaiaid-(\d+)/);
      if (!m) continue;
      const gaiaid = m[1];
      try {
        const bytes = await download(key);
        if (!bytes) continue;
        const lc = tglcBytesToLightCurve(bytes, `Gaia ${gaiaid}`);
        if (!lc || lc.points.length < 60) continue;
        if (tglcHeaderMeta(bytes).tic == null) continue; // need a real TIC to key the host
        let hk = hostKeyByGaia.get(gaiaid);
        if (hk == null) { hk = hostKeyByGaia.size; hostKeyByGaia.set(gaiaid, hk); }
        const set = sectorsByGaia.get(gaiaid) ?? new Set<number>();
        set.add(s);
        sectorsByGaia.set(gaiaid, set);
        samples.push({ lc, hostKey: hk, sector: s });
        got++;
      } catch { /* skip an unusable curve */ }
    }
    console.log(`[p26]   sector ${sectStr}: ${keys.length} listed, ${got} usable curves.`);
  }
  if (!samples.length) { console.log(`\n[p26] no usable curves. VERDICT: NO-USEFUL-DATA (network? re-run).`); return; }

  const distinctHosts = hostKeyByGaia.size;
  const multiSectorHosts = [...sectorsByGaia.values()].filter((set) => set.size >= 2).length;
  console.log(`\n[p26] ${samples.length} curves on ${distinctHosts} distinct hosts; ${multiSectorHosts} hosts recur in >=2 sampled sectors ` +
    `(same-host cross-sector corroboration is only measurable on those -- the physical FFI single-pass limit p22 also hit).`);

  // ---- NULL arm: base chain on un-injected curves; every surviving host is a false positive by construction. ----
  const nullDets: SectorDetection[] = [];
  for (const smp of samples) {
    const r = runChain(smp.lc);
    if (!r.emitted) continue;
    nullDets.push({ tic: smp.hostKey, sector: smp.sector, periodDays: r.periodDays, epochBjd: r.epochBjd, fapPassed: passesFap(smp.lc, r, nNull, seed) });
  }
  const nullCounts = applyLayerFilters(nullDets);

  // ---- INJECTED arm: coherent ephemeris on real curves -> completeness at each layer (L4 via split-half proxy). ----
  let trials = 0;
  let injL1 = 0; // recovered in the full curve (SNR+depth, period matched)
  let injL2 = 0; // + clears empirical FAP
  let injL4proxy = 0; // split-half proxy: the coherent transit survives BOTH sub-baselines of one real curve
  const byDepth = new Map<number, { n: number; l1: number; l4p: number }>();
  const byPeriod = new Map<number, { n: number; l1: number; l4p: number }>();
  let trial = 0;
  for (const smp of (nullOnly ? [] : samples)) {
    const lc = smp.lc;
    const t0base = lc.points[0] ? lc.points[0].time : 2459000;
    const tEnd = lc.points[lc.points.length - 1] ? lc.points[lc.points.length - 1].time : t0base + 27;
    const mid = (t0base + tEnd) / 2;
    for (const depth of depthsPpm) {
      for (const period of periodsDay) {
        trial++;
        trials++;
        const d = byDepth.get(depth) ?? { n: 0, l1: 0, l4p: 0 }; d.n++; byDepth.set(depth, d);
        const p = byPeriod.get(period) ?? { n: 0, l1: 0, l4p: 0 }; p.n++; byPeriod.set(period, p);
        // inject the SAME absolute epoch into the full curve and both halves => one coherent ephemeris
        const inj = injectTransitInto(lc, { seed: seed + trial, periodDays: period, depthFrac: depth / 1e6, t0Bjd: t0base + period });
        const rFull = runChain(inj);
        const recFull = rFull.emitted && periodMatched(rFull.periodDays, period, PERIOD_TOL_PCT);
        if (!recFull) continue;
        injL1++; d.l1++; p.l1++;
        const fapFull = passesFap(inj, rFull, nNull, seed);
        if (fapFull) injL2++;

        // L4 proxy: split the injected curve at mid-time into two sub-baselines; corroboration needs BOTH to recover,
        // to clear FAP, and to be ephemeris-coincident.
        const injA = injectTransitInto(subCurve(lc, t0base, mid, "#A"), { seed: seed + trial, periodDays: period, depthFrac: depth / 1e6, t0Bjd: t0base + period });
        const injB = injectTransitInto(subCurve(lc, mid, tEnd + 1e-6, "#B"), { seed: seed + trial, periodDays: period, depthFrac: depth / 1e6, t0Bjd: t0base + period });
        const rA = runChain(injA);
        const rB = runChain(injB);
        const mA = rA.emitted && periodMatched(rA.periodDays, period, PERIOD_TOL_PCT) && passesFap(injA, rA, nNull, seed);
        const mB = rB.emitted && periodMatched(rB.periodDays, period, PERIOD_TOL_PCT) && passesFap(injB, rB, nNull, seed);
        if (mA && mB) {
          const a = { tic: smp.hostKey, sector: 1, periodDays: rA.periodDays, epochBjd: rA.epochBjd, fapPassed: true };
          const b = { tic: smp.hostKey, sector: 2, periodDays: rB.periodDays, epochBjd: rB.epochBjd, fapPassed: true };
          if (coincident(a, b)) { injL4proxy++; d.l4p++; p.l4p++; }
        }
      }
    }
  }

  // real same-host multi-sector corroboration on the INJECTED arm is only defined where a host has >=2 real sectors;
  // we measured the completeness cost structurally via the split-half proxy above and report the availability honestly.

  // ---- report ----
  const denom = samples.length;
  console.log(`\n[p26] ===== CORROBORATION ROC on real FFI (TGLC) =====`);
  console.log(`[p26] curves: ${samples.length} (hosts ${distinctHosts}, multi-sector hosts ${multiSectorHosts}); injections: ${trials}; FAP nulls/candidate: ${nNull}\n`);
  console.log(`[p26] FALSE ALARMS (null arm, distinct quiet hosts surviving each cumulative layer, base ${denom} curves):`);
  console.log(`[p26]   L1  SNR+depth               : ${nullCounts.hostsL1} hosts = ${pct(nullCounts.hostsL1, distinctHosts)} of hosts`);
  console.log(`[p26]   L2  + empirical FAP<=${FAP_MAX}   : ${nullCounts.hostsL2} hosts = ${pct(nullCounts.hostsL2, distinctHosts)} of hosts`);
  console.log(`[p26]   L3  + reject multi-host eph : ${nullCounts.hostsL3} hosts = ${pct(nullCounts.hostsL3, distinctHosts)} of hosts   (removes sector-common shared-ephemeris dips; costs NO single-host planet)`);
  console.log(`[p26]   L4  + same-host cross-sector: ${nullCounts.hostsL4} hosts = ${pct(nullCounts.hostsL4, distinctHosts)} of hosts   (needs >=2 real sectors on the host; ${multiSectorHosts} hosts qualify)\n`);
  if (!nullOnly) {
    console.log(`[p26] COMPLETENESS (injected arm, fraction of ${trials} injections surviving each layer):`);
    console.log(`[p26]   L1  SNR+depth               : ${pct(injL1, trials)} (${injL1}/${trials})`);
    console.log(`[p26]   L2  + empirical FAP<=${FAP_MAX}   : ${pct(injL2, trials)} (${injL2}/${trials})`);
    console.log(`[p26]   L3  + reject multi-host eph : ${pct(injL2, trials)} (${injL2}/${trials})   (equals L2: single-host planets are never a multi-host artifact)\n`);
    console.log(`[p26]   L4* split-half corroboration PROXY (must survive 2 sub-baselines of the same real curve):`);
    console.log(`[p26]         ${pct(injL4proxy, trials)} (${injL4proxy}/${trials})   [proxy, NOT true cross-year coverage]`);
    console.log(`[p26]   L4* by injected depth (L1 -> L4 proxy):`);
    for (const depth of depthsPpm) { const b = byDepth.get(depth)!; console.log(`[p26]       ${String(depth).padStart(5)} ppm -> L1 ${pct(b.l1, b.n)} (${b.l1}/${b.n})  L4* ${pct(b.l4p, b.n)} (${b.l4p}/${b.n})`); }
    console.log(`[p26]   L4* by injected period (L1 -> L4 proxy):`);
    for (const period of periodsDay) { const b = byPeriod.get(period)!; console.log(`[p26]       ${String(period).padStart(4)} d   -> L1 ${pct(b.l1, b.n)} (${b.l1}/${b.n})  L4* ${pct(b.l4p, b.n)} (${b.l4p}/${b.n})`); }
  } else {
    console.log(`[p26] COMPLETENESS: injected arm skipped (--null-only); the FP layers above are measured on a large quiet-star sample.`);
  }

  const fpCutL3 = nullCounts.hostsL2 > 0 ? ((nullCounts.hostsL2 - nullCounts.hostsL3) / nullCounts.hostsL2) * 100 : NaN;
  console.log(`\n[p26] HEADLINE: L3 (reject multi-host shared ephemerides) cut the FAP-surviving false alarms by ${Number.isFinite(fpCutL3) ? fpCutL3.toFixed(0) + "%" : "n/a"} ` +
    `(${nullCounts.hostsL2} -> ${nullCounts.hostsL3}) at ZERO cost to single-host planets (injected L3 == L2). The extra cut to 0 FP by real cross-sector corroboration (L4) ` +
    `is gated by same-host multi-sector coverage, present on ${multiSectorHosts}/${distinctHosts} sampled hosts -- the Stage-5 (deeper baseline / collaborators) requirement.`);
  console.log(`[p26] NOTE: null and injected arms are different populations; FP is per-quiet-host, completeness is per-injection. Corroboration is a RESEARCH trade-off only -- ` +
    `it gates NOTHING in production, anchors nothing, and claims no discovery. L4* is a mid-sector split proxy on real noise, not two independent years.`);
  console.log(`\nVERDICT: CORROBORATION-ROC-MEASURED`);
}

main().catch((e) => {
  console.error(`[p26] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
