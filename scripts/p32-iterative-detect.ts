// P32 - ITERATIVE MULTI-SIGNAL EXTRACTION, scored per host system against the single-BLS p30 baseline.
//
// WHY. p28/p29/p30 converged on one honest bottleneck: on a stitched multi-sector baseline a SINGLE blind BLS
// pass reports ONE period, so in a MULTI-planet system it can recover at most one of the co-orbiting planets
// (p30 per-system recovery of known planets was just 2/10). p30 named the fix explicitly -- "a real survey
// needs iterative multi-signature extraction" -- and src/detect/iterative.ts implements it (find strongest
// transit, resolve its half/third-period alias, refine the period on a dense local grid, MASK its in-transit
// cadences, re-run BLS on the residual, repeat). p32 MEASURES whether that actually recovers MORE known
// planets per system than a single pass, on REAL photometry. The number is measured, never asserted.
//
// DESIGN (a controlled contrast, measure-before-gate). Same hosts, same stitched curves, same match tolerance
// for both arms; the ONLY difference is single-pass vs iterative extraction. Both arms are alias-resolved and
// both apply the production depth-regime screen, so the delta isolates the multi-signal benefit.
//   * Arm A (baseline): the SINGLE strongest signal from one iterativeBls run -> at most one planet per host.
//   * Arm B (new):      EVERY signal from that SAME run (up to maxSignals) -> can match several planets.
// Both arms come from one run, so they share identical period refinement, alias resolution and SNR/depth
// floors; the ONLY difference is how many extracted signals are scored. A plain un-floored bls() pass is not
// a fair baseline -- it "matches" periods (even negative-depth artifacts) the production gate would reject.
// BASELINE: both arms run on the SAME curve -- the best available stitched SPOC sectors for the host (>=1
// sector; a single contiguous ~27 d sector is a standard multi-planet search baseline, and stitching more
// sectors only helps if they are phase-coherent, which p12/p29 showed is not guaranteed). MULTI-planet hosts
// are required (>=2 in-range known planets): a single-planet host caps both arms at one and proves nothing.
// DATA: real TESS-SPOC PDCSAP curves pulled straight from the public S3 bucket by deterministic (TIC,sector)
// key. The TESScut sector-lookup service is NOT used -- it is unreachable from some networks (fetch fails),
// which made sectorsForCoord() return [] and silently starved the survey; sectors are probed on S3 directly
// instead (a missing product is a fast 404). A host with no SPOC product is skipped, never counted.
// We report total known in-range planets recovered by each arm, the per-host improvement count, and the number
// of iterative signals that matched NO known planet (a purity diagnostic), so gains AND over-reach are visible.
//
// Positive control on KNOWN planets -- a capability self-test, NOT a discovery claim. Research probe: no worker
// import, no verdict, no bundle hash, no money path, nothing anchored/claimed/deployed.
// PHASE 2 (real-noise injection): Phase 1's catalog delta cannot separate "algorithm broken" from "public
// curves too shallow", so Phase 2 injects TWO floor-clearing transits into the SAME real curves (real noise,
// cadence and gaps preserved) and checks single-pass vs iterative recovery -- single is capped at 1 of 2 by
// construction, iterative can get both. A capability self-test on REAL noise, still not a discovery claim.
//
// Run:  npm run p32:iterative  [-- --hosts 12 --maxsectors 3 --minperiod 1 --maxperiod 13 --tmag 11 --matchtol 2 --maxsignals 5]

import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes, stitchLightCurves } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantHosts = Math.max(1, parseInt(arg("hosts", "12"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "3"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const matchTolPct = Number(arg("matchtol", "2"));
const maxSignals = Math.max(2, parseInt(arg("maxsignals", "5"), 10));

// TESScut's sector-lookup service is unreachable from some networks, which makes sectorsForCoord() return []
// and silently starve the survey. But SPOC S3 keys are DETERMINISTIC given (TIC, sector) and a missing product
// is a fast 404, so probe sectors directly on the public bucket -- no TESScut dependency. Collects up to
// `maxCurves` real PDCSAP curves, preferring the lowest (earliest, usually contiguous) sectors, and stops as
// soon as it has enough so a dataless host costs only fast 404s.
async function collectSpocCurves(tic: number, name: string, maxCurves: number, sectorMax = 40): Promise<LightCurve[]> {
  const out: LightCurve[] = [];
  for (let s = 1; s <= sectorMax && out.length < maxCurves; s++) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 });
    } catch { /* transient; skip this sector */ }
    if (!bytes) continue;
    try {
      const lc = fitsToLightCurve(bytes, name);
      if (lc.points.length < 60) continue;
      lc.source = `TESS-SPOC PDCSAP product sector ${s} from public S3 (REAL photometry); CC BY 4.0, cite Caldwell et al. 2020`;
      out.push(lc);
    } catch { /* unparseable; skip this sector */ }
  }
  return out;
}

/** Indices of `planets` whose true period is within tolPct of ANY period in `periods`. */
function matchSet(periods: number[], planets: ArchivePlanet[], tolPct: number): Set<number> {
  const m = new Set<number>();
  for (const P of periods) {
    if (!Number.isFinite(P) || P <= 0) continue;
    for (let i = 0; i < planets.length; i++) {
      const tp = planets[i].pl_orbper;
      if (tp == null || !(tp > 0)) continue;
      if ((Math.abs(P - tp) / tp) * 100 <= tolPct) m.add(i);
    }
  }
  return m;
}

const label = (p: ArchivePlanet): string => `${p.pl_name ?? p.hostname ?? "?"} ${p.pl_orbper?.toFixed(3)}d`;

interface Row {
  host: string;
  nPlanets: number;
  nSectors: number;
  singlePeriod: number;
  singleMatched: number;
  iterPeriods: number[];
  iterMatched: number;
  iterSignals: number;
  spurious: number;
  matchedNames: string[];
}

async function main(): Promise<void> {
  console.log(
    `P32 iterative multi-signal extraction vs single-BLS (p30 baseline), scored per HOST system: ${wantHosts} MULTI-planet hosts, ` +
    `P in [${minPeriod},${maxPeriod}] d, T<=${tmagCap}, up to ${maxSectors} sectors, match tol ${matchTolPct}%, maxSignals ${maxSignals}. ` +
    `REAL photometry; known-planet positive control; no discovery claim.`,
  );

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);

  // Group by host TIC; keep MULTI-planet hosts (>=2 in-range planets) -- the only systems where iterative
  // extraction can beat a single pass. A single-planet host caps both arms at 1 and proves nothing.
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) {
    const arr = byHost.get(p.tic!) ?? [];
    arr.push(p);
    byHost.set(p.tic!, arr);
  }
  const multiHosts = [...byHost.entries()].filter(([, arr]) => arr.length >= 2);
  const hosts = multiHosts.slice(0, wantHosts * 5); // over-sample: some hosts lack >=2 usable sectors
  console.log(`  catalog: ${planets.length} in-range planets on ${byHost.size} hosts; ${multiHosts.length} are MULTI-planet (>=2 in-range)\n`);

  const rows: Row[] = [];
  const cachedCurves: { name: string; lc: LightCurve }[] = [];
  let tried = 0;
  for (const [tic, hostPlanets] of hosts) {
    if (rows.length >= wantHosts) break;
    tried++;
    const name = hostPlanets[0].hostname ?? hostPlanets[0].pl_name ?? `TIC ${tic}`;
    const sectorLcs = await collectSpocCurves(tic, name, maxSectors);
    if (sectorLcs.length < 1) {
      console.log(`  [${tried}/${hosts.length}] ${name}: no SPOC light curve on public S3 (probed sectors 1-40); skip`);
      continue;
    }

    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;
    cachedCurves.push({ name, lc: stitched }); // reuse in Phase 2 without re-downloading
    const t0 = Date.now();

    // ONE iterativeBls run feeds BOTH arms so the detection criteria are IDENTICAL: Arm A is the single
    // strongest plausible signal (what one refined, alias-resolved, floor-gated BLS pass reports); Arm B is
    // every plausible signal extracted. The delta is the PURE multi-signal benefit, not a threshold difference.
    let singlePeriod = NaN;
    let singleMatched = 0;
    let iterPeriods: number[] = [];
    let iterMatched = 0;
    let spurious = 0;
    let nSig = 0;
    let stoppedReason = "n/a";
    try {
      const iter = iterativeBls(stitched, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals });
      stoppedReason = iter.stoppedReason;
      const plausibleSignals = iter.signals.filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible);
      nSig = plausibleSignals.length;
      iterPeriods = plausibleSignals.map((s) => s.periodDays);
      iterMatched = matchSet(iterPeriods, hostPlanets, matchTolPct).size;
      spurious = plausibleSignals.filter((s) => matchSet([s.periodDays], hostPlanets, matchTolPct).size === 0).length;
      const first = plausibleSignals.slice(0, 1); // Arm A: strongest plausible signal only
      singlePeriod = first.length ? first[0].periodDays : NaN;
      singleMatched = matchSet(first.map((s) => s.periodDays), hostPlanets, matchTolPct).size;
    } catch { /* leave zeros */ }

    const matchedIdx = matchSet(iterPeriods, hostPlanets, matchTolPct);
    const matchedNames = [...matchedIdx].map((i) => label(hostPlanets[i]));
    rows.push({ host: name, nPlanets: hostPlanets.length, nSectors: sectorLcs.length, singlePeriod, singleMatched, iterPeriods, iterMatched, iterSignals: nSig, spurious, matchedNames });

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  [${tried}/${hosts.length}] ${name.padEnd(18)} (${hostPlanets.length} pl, ${sectorLcs.length} sec, ${stitched.points.length} pts, ${secs}s)  ` +
      `single ${Number.isFinite(singlePeriod) ? singlePeriod.toFixed(3) + "d" : "--"} -> ${singleMatched}  |  ` +
      `iter ${nSig} sig [${iterPeriods.map((p) => p.toFixed(2)).join(", ")}] -> ${iterMatched}` +
      `${spurious ? `, ${spurious} spurious` : ""} (stop: ${stoppedReason})` +
      `${iterMatched > singleMatched ? "  <== +MULTI" : ""}`,
    );
    if (matchedNames.length) console.log(`      recovered: ${matchedNames.join("; ")}`);
  }

  if (!rows.length) {
    console.log(`\nNo MULTI-planet hosts with >=1 usable sector resolved. Re-run shortly (network/coverage permitting).`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const K = rows.reduce((a, r) => a + r.nPlanets, 0);
  const S = rows.reduce((a, r) => a + r.singleMatched, 0);
  const I = rows.reduce((a, r) => a + r.iterMatched, 0);
  const improved = rows.filter((r) => r.iterMatched > r.singleMatched).length;
  const regressed = rows.filter((r) => r.iterMatched < r.singleMatched).length;
  const spuriousTotal = rows.reduce((a, r) => a + r.spurious, 0);
  const sigTotal = rows.reduce((a, r) => a + r.iterSignals, 0);
  const H = rows.length;

  console.log(`\n=== P32 SUMMARY (${H} MULTI-planet host systems with >=1 usable sector) ===`);
  console.log(`  Known in-range planets across these hosts            : ${K}`);
  console.log(`  Recovered by the SINGLE strongest signal [arm A]     : ${S}/${K}  (${(100 * S / K).toFixed(1)}%)`);
  console.log(`  Recovered by ITERATIVE multi-signal      [arm B]     : ${I}/${K}  (${(100 * I / K).toFixed(1)}%)   delta ${I - S >= 0 ? "+" : ""}${I - S}`);
  console.log(`  Hosts where iterative found MORE planets             : ${improved}/${H}   (regressed on ${regressed})`);
  console.log(`  Mean planets recovered per host  single / iterative  : ${(S / H).toFixed(2)} / ${(I / H).toFixed(2)}`);
  console.log(`  Iterative signals that matched NO known planet       : ${spuriousTotal}/${sigTotal}  (purity diagnostic; some may be real planets outside the catalog range or aliases)`);

  console.log(
    `\nInterpretation (measure-before-gate): both arms come from ONE iterativeBls run and share identical ` +
    `refinement, alias resolution and SNR/depth floors, so the delta is the pure multi-signal benefit. A ` +
    `single pass is capped at one period per star; iterative mask-and-refind is the p30-named fix that can ` +
    `surface co-orbiting planets. If arm B recovers materially more known planets WITHOUT a large spurious ` +
    `count, iterative extraction is a genuine multi-planet upgrade. If the delta is ~0 because arm B rarely ` +
    `pulls a SECOND signal above the floor (per-host stop reasons snr-floor/depth-floor), the honest reading ` +
    `is that on underpowered public few-sector SPOC curves the second, shallower/longer-period planet falls ` +
    `below the production gate -- the limit is DATA POWER, not the algorithm (the offline unit test proves ` +
    `iterative cleanly separates two ~1%-deep planets when SNR suffices). That is consistent with p26-p30 and ` +
    `motivates deeper baselines / more compute (Track C). Known-planet positive control only; nothing gated, ` +
    `anchored, claimed, or deployed.`,
  );
  // ---- Phase 2: REAL-noise injection positive control ------------------------------------------
  // Phase 1's delta of +0 cannot tell "the iterative algorithm is broken" from "the public curves are
  // too shallow". Phase 2 separates those: take the SAME real stitched curves already downloaded in
  // Phase 1, MULTIPLICATIVELY inject TWO floor-clearing transits (real noise/cadence/gaps preserved),
  // and ask whether single-pass vs iterative recovers them. Single-pass reports one period per star so
  // it can recover at most 1 of the 2; iterative mask-and-refind can recover both. If iterative recovers
  // both on most curves while single recovers ~1, the algorithm is sound on REAL noise and Phase 1's
  // null is a data-power limit, not an algorithm fault. Capability self-test only.
  const INJ = [
    { periodDays: 3.3, depthFrac: 0.0025, seed: 11 },
    { periodDays: 8.1, depthFrac: 0.0018, seed: 22 },
  ];
  const phase2 = cachedCurves.slice(0, 6);
  if (phase2.length) {
    console.log(`\n=== P32 PHASE 2: real-noise injection positive control (${phase2.length} real curves, 2 injected transits each: P=3.3d@2500ppm + P=8.1d@1800ppm) ===`);
    let sumA = 0;
    let sumB = 0;
    let bothB = 0;
    for (const { name, lc } of phase2) {
      let cur = lc;
      for (const inj of INJ) cur = injectTransitInto(cur, { ...inj, label: name });
      let recA = 0;
      let recB = 0;
      try {
        const iter = iterativeBls(cur, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals });
        const plausible = iter.signals.filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible).map((s) => s.periodDays);
        const armA = plausible.slice(0, 1);
        recA = INJ.filter((t) => armA.some((p) => periodMatched(p, t.periodDays, matchTolPct))).length;
        recB = INJ.filter((t) => plausible.some((p) => periodMatched(p, t.periodDays, matchTolPct))).length;
      } catch { /* leave 0 */ }
      sumA += recA;
      sumB += recB;
      if (recB === INJ.length) bothB++;
      console.log(`  ${name.padEnd(18)} single->${recA}/2  iterative->${recB}/2${recB === INJ.length ? "  <== BOTH" : ""}`);
    }
    const N2 = phase2.length;
    console.log(`  injected transits recovered  single [arm A]: ${sumA}/${2 * N2}   iterative [arm B]: ${sumB}/${2 * N2}`);
    console.log(`  curves where iterative recovered BOTH injected: ${bothB}/${N2}   (single-pass is capped at 1 by construction)`);
    console.log(`  Read: if iterative recovers both on most curves while single recovers ~1, the mask-and-refind`);
    console.log(`  algorithm is sound on REAL noise and Phase 1's delta~0 is a DATA-POWER limit, not an algorithm fault.`);
  } else {
    console.log(`\n=== P32 PHASE 2: skipped (no real curves cached from Phase 1) ===`);
  }

  console.log(`\nVERDICT: ITERATIVE-RAN`);
}

main().catch((e) => {
  console.error(`[p32] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
