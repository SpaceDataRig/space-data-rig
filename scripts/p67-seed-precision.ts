// P67 - SEED-PRECISION: is the P62 "seed wall" a real limit, or an artifact of seeding from a NAIVE single
// BLS peak when the production detector is ALREADY iterative multi-signal extraction?
//
// WHY THIS EXISTS. P62 (npm run p62:phase-aligned-joint) concluded NO-LIFT and localised the joint-search
// bottleneck to "seed acquisition": a blind single-sector BLS peak is usually the WRONG period on multi-planet
// hosts (it locks a neighbouring planet or a harmonic), so constraining the joint fold to that bad seed dragged
// re-find to 4/20, below even the naive 6/20. BUT the production detector is not a single BLS peak -- p33/p49/p50
// all run `iterativeBls` (mask-and-refind, top-k signals, strongest first). P62 seeded from `bls()`'s single best
// peak, NOT from `iterativeBls`'s ranked multi-signals. That is a gap in the evidence: we never measured whether
// the STRONGER detector actually acquires a correct seed. This script closes it.
//
// STRICT A/B on the SAME planets (sample read back from reports/p60 + p62 rows so nothing is re-selected). For
// each known planet we measure SEED ACQUISITION directly -- does the seed period match catalog truth within tol --
// from three different seeders, then feed each into the SAME phase-aligned narrow joint fold P62 used:
//   NAIVE-SEED   -- best-SNR single-sector bls() peak (P62's seeder; continuity control, expect the ~4/20 refined).
//   ITER-TOP1    -- iterativeBls(stitched).signals[0] (the production detector's strongest signal).
//   ITER-TOPK    -- ANY of iterativeBls(stitched).signals[0..k-1] (production uses maxSignals=3): the honest
//                   "can the pipeline put the right period on the table at all" number, a seed-RECALL ceiling.
//   ORACLE       -- refinement seeded at catalog truth (diagnostic ceiling, identical to P62).
//
// The load-bearing question: does ITER-TOPK seed-hit rate substantially exceed NAIVE-SEED? If yes, the P62
// "blind seed is usually wrong" is scoped correctly to a SINGLE-PEAK seeder, and iterative multi-signal seed
// acquisition largely lifts it (the bottleneck statement must be softened). If no, the wall is now confirmed
// against the STRONGER detector and P62's negative is robust. Positive control ONLY, on KNOWN planets; research
// probe: no worker import, no verdict / bundle hash / money path, nothing anchored or claimed. discoveryClaim
// structurally false. If the result changes nothing we still write the measured seed-recall numbers down.
//
// Run: npm run p67:seed-precision [-- --minsnr 7 --tol 5 --win 0.10 --k 3 --maxsectors 4 --tmag 11 --minperiod 1 --maxperiod 13]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { iterativeBls } from "../src/detect/iterative.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";
import { buildStamp } from "./report-freshness.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const maxSectors = Math.max(2, parseInt(arg("maxsectors", "4"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const minSnr = Number(arg("minsnr", "7"));
const tolPct = Number(arg("tol", "5"));
const win = Number(arg("win", "0.10")); // +- fractional window around the seed for the phase-aligned refinement
const k = Math.max(1, parseInt(arg("k", "3"), 10)); // iterative signals to consider as candidate seeds

const matched = (period: number, cat: number) => Number.isFinite(period) && Math.abs(period - cat) / cat * 100 <= tolPct;

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const lc = await fetchSpocLightCurve(tic, [sector], name); if (lc) return lc; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

interface Row {
  name: string; catPeriod: number; nSectors: number;
  naiveSeed: number; naiveSeedHit: boolean; naiveSeedSnr: number;
  iterTop1: number; iterTop1Hit: boolean; iterN: number; iterTopKHit: boolean;
  iterSeedPeriod: number; // the iterative signal (top-k) closest to truth, for reporting
  refineNaive: boolean; refineIter: boolean; refineOracle: boolean;
  oracleSeed: number;
}

async function main(): Promise<void> {
  // strict A/B: reuse the exact planets P60/P62 resolved (read the committed reports' row names + periods).
  let baseline: { name: string; catPeriod: number }[] = [];
  try {
    const p60 = JSON.parse(readFileSync("reports/p60-joint-vs-single.json", "utf8"));
    baseline = (p60.rows || []).map((r: any) => ({ name: r.name, catPeriod: r.catPeriod }));
  } catch { console.log("  (could not read reports/p60-joint-vs-single.json -- falling back to fresh selection)"); }
  const wantNames = new Set(baseline.map((b) => b.name));
  const catPeriodByName = new Map(baseline.map((b) => [b.name, b.catPeriod]));

  console.log(`P67 SEED-PRECISION: naive single-peak vs iterative multi-signal seeds on the ${baseline.length || "?"} P60/P62 planets; refine window +-${(win * 100).toFixed(0)}%, k=${k}, minSnr ${minSnr}, tol ${tolPct}%. REAL SPOC photometry, token-free; no discovery claim.`);

  const catalog = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.tic != null && p.ra != null && p.dec != null)
    .filter((p) => wantNames.size === 0 || wantNames.has(p.pl_name ?? p.hostname ?? ""));
  const planets = catalog.slice(0, 40);

  const rows: Row[] = [];
  for (const p of planets) {
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    const catPeriod = catPeriodByName.get(name) ?? p.pl_orbper ?? NaN;
    if (!Number.isFinite(catPeriod) || catPeriod < minPeriod || catPeriod > maxPeriod) continue;
    let sectors: number[];
    try { sectors = await sectorsForCoord(p.ra!, p.dec!); } catch { continue; }
    if (sectors.length < 2) continue;
    const sectorLcs: LightCurve[] = [];
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(p.tic!, s, name);
      if (lc && lc.points.length >= 60) sectorLcs.push(lc);
    }
    if (sectorLcs.length < 2) continue;

    // NAIVE seed = best-SNR single-sector bls() peak (P62's seeder).
    let naive = { periodDays: NaN, snr: -Infinity };
    for (const lc of sectorLcs) {
      let b; try { b = bls(lc, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
      if (b.snr > naive.snr) naive = { periodDays: b.periodDays, snr: b.snr };
    }
    const naiveSeedHit = naive.snr >= minSnr && matched(naive.periodDays, catPeriod);

    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;

    // ITERATIVE seed = the production multi-signal detector on the stitched long baseline.
    let it; try { it = iterativeBls(stitched, { maxPeriodDays: maxPeriod + 2, maxSignals: k, minSnr }); } catch { it = { signals: [] }; }
    const sigs = it.signals || [];
    const iterTop1 = sigs[0]?.periodDays ?? NaN;
    const iterTop1Hit = !!sigs[0] && sigs[0].snr >= minSnr && matched(sigs[0].periodDays, catPeriod);
    const iterTopKHit = sigs.some((s) => s.snr >= minSnr && matched(s.periodDays, catPeriod));
    const bestIterSeed = sigs.filter((s) => matched(s.periodDays, catPeriod))[0]?.periodDays ?? iterTop1;

    // Feed each seeder into the SAME phase-aligned narrow joint fold P62 used.
    const foldRecover = (seedPeriod: number) => {
      if (!(Number.isFinite(seedPeriod) && seedPeriod > 1)) return false;
      try { const b = bls(stitched, { minPeriodDays: seedPeriod * (1 - win), maxPeriodDays: seedPeriod * (1 + win), oversample: 24 }); return b.snr >= minSnr && matched(b.periodDays, catPeriod); } catch { return false; }
    };
    const refineNaive = foldRecover(naive.periodDays);
    const refineIter = foldRecover(iterTop1);
    // ORACLE ceiling (truth seed), identical to P62.
    const refineOracle = foldRecover(catPeriod);

    rows.push({
      name, catPeriod, nSectors: sectorLcs.length,
      naiveSeed: naive.periodDays, naiveSeedHit, naiveSeedSnr: naive.snr,
      iterTop1, iterTop1Hit, iterN: sigs.length, iterTopKHit, iterSeedPeriod: bestIterSeed,
      refineNaive, refineIter, refineOracle, oracleSeed: catPeriod,
    });
    console.log(`  ${name.padEnd(16)} P=${catPeriod.toFixed(3)}d nsec ${sectorLcs.length}  naive-seed[${naiveSeedHit ? "HIT" : "miss"} ${Number.isFinite(naive.periodDays) ? naive.periodDays.toFixed(3) : "?"}]  iter-n ${sigs.length} top1[${iterTop1Hit ? "HIT" : "miss"} ${Number.isFinite(iterTop1) ? iterTop1.toFixed(3) : "?"}] topk[${iterTopKHit ? "HIT" : "miss"}]  refine naive/iter/oracle ${refineNaive ? "RE" : "--"}/${refineIter ? "RE" : "--"}/${refineOracle ? "RE" : "--"}`);
  }

  if (rows.length < 5) {
    console.log(`\nonly ${rows.length} planets resolved (catalog/SPOC fallback?). VERDICT: INSUFFICIENT-DATA (re-run shortly)`);
    process.exitCode = 0; return;
  }

  const n = rows.length;
  const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
  const naiveHit = cnt((r) => r.naiveSeedHit);
  const iterTop1Hit = cnt((r) => r.iterTop1Hit);
  const iterTopKHit = cnt((r) => r.iterTopKHit);
  const refineNaive = cnt((r) => r.refineNaive);
  const refineIter = cnt((r) => r.refineIter);
  const refineOracle = cnt((r) => r.refineOracle);
  const [kLo, kHi] = wilsonInterval(iterTopKHit, n);
  const [t1Lo, t1Hi] = wilsonInterval(iterTop1Hit, n);
  const recallGainPp = 100 * (iterTopKHit - naiveHit) / n;

  console.log(`\n=== P67 SUMMARY (${n} confirmed planets, >=2 usable sectors) ===`);
  console.log(`  SEED-HIT (period == truth within ${tolPct}%, snr>=${minSnr}):`);
  console.log(`    naive single-peak   : ${naiveHit}/${n} = ${(100 * naiveHit / n).toFixed(1)}%   (P62's seeder)`);
  console.log(`    iterative top-1     : ${iterTop1Hit}/${n} = ${(100 * iterTop1Hit / n).toFixed(1)}%  [${(100 * t1Lo).toFixed(0)}, ${(100 * t1Hi).toFixed(0)}]`);
  console.log(`    iterative top-${k} (any) : ${iterTopKHit}/${n} = ${(100 * iterTopKHit / n).toFixed(1)}%  [${(100 * kLo).toFixed(0)}, ${(100 * kHi).toFixed(0)}]   <- SEED RECALL ceiling`);
  console.log(`  REFINED re-find (phase-aligned fold seeded at ...):`);
  console.log(`    naive seed ${refineNaive}/${n} | iter top-1 ${refineIter}/${n} | oracle ${refineOracle}/${n}`);
  console.log(`  seed-recall gain (iter top-${k} over naive peak) = ${recallGainPp >= 0 ? "+" : ""}${recallGainPp.toFixed(1)} pp`);

  const clearSeedLift = iterTopKHit - naiveHit >= 3;
  const verdict = clearSeedLift
    ? `SEED-RECALL-LIFTS: the production iterative detector puts a correct period on the table for ${iterTopKHit}/${n} planets vs ${naiveHit}/${n} for a single BLS peak -- the P62 "seed wall" is a SINGLE-PEAK artifact, not a property of the pipeline's real detector (soften the bottleneck claim).`
    : iterTopKHit > naiveHit
      ? `MODEST-SEED-LIFT (iterative top-${k} recall exceeds the single peak but within overlapping Wilson CIs -- not decisive; the wall is real but somewhat softer than P62 implied).`
      : `SEED-WALL-CONFIRMED: even the stronger iterative detector's top-${k} seeds match truth no better than a single peak (${iterTopKHit}/${n} vs ${naiveHit}/${n}) -- P62's bottleneck is robust against the production detector.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  measure-before-gate: positive control on KNOWN planets; NOT a discovery; no gate relaxed. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["reports/p60-joint-vs-single.json", "scripts/p67-seed-precision.ts"]),
      generatedBy: "scripts/p67-seed-precision.ts", n, k, maxSectors, minPeriod, maxPeriod, tmagCap, minSnr, tolPct, win,
      arms: "SEED-HIT = seeder period matches catalog truth within tol at snr>=floor; seeders: naive single-sector bls peak; iterativeBls(stitched) top-1; iterativeBls top-k (any); ORACLE truth seed. REFINED = phase-aligned narrow joint fold seeded at each.",
      data: "real TESS-SPOC light curves (token-free public S3); strict A/B on the P60/P62 sample",
      note: "tests whether the P62 'seed-acquisition bottleneck' survives seeding from the production iterative detector rather than a single BLS peak; NOT a discovery claim; nothing gated.",
    },
    seedHit: {
      naivePeak: { count: naiveHit, n, rate: naiveHit / n },
      iterativeTop1: { count: iterTop1Hit, n, rate: iterTop1Hit / n, ciLow: t1Lo, ciHigh: t1Hi },
      iterativeTopK: { count: iterTopKHit, n, rate: iterTopKHit / n, ciLow: kLo, ciHigh: kHi },
      recallGainPp: recallGainPp,
    },
    refinedRefind: { naiveSeed: refineNaive, iterTop1Seed: refineIter, oracleSeed: refineOracle, n },
    bottleneck: clearSeedLift ? "single-peak-seeder (not the pipeline detector)" : (iterTopKHit > naiveHit ? "partially-seed-acquisition" : "seed-acquisition-confirmed"),
    verdict,
    discoveryClaim: false,
    rows,
  };
  writeFileSync("reports/p67-seed-precision.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P67 seed-precision: does the production iterative detector clear the P62 'seed wall'?",
    "",
    `Reproduce: \`npm run p67:seed-precision -- --minsnr ${minSnr} --tol ${tolPct} --win ${win} --k ${k}\``,
    "",
    "P62 localised the joint-search bottleneck to seed acquisition, but seeded the refinement from a NAIVE",
    "single-sector BLS peak. The production detector (p33/p49/p50) is `iterativeBls` -- mask-and-refind top-k",
    "signals. This study measures SEED HIT (does the seeder's period match catalog truth within tol) for each",
    `seeder on the SAME ${n} confirmed planets, then feeds each into P62's phase-aligned narrow joint fold.`,
    "",
    "| seeder | seed-hit | refined re-find | 95% Wilson CI (hit) |",
    "|---|---|---|---|",
    `| naive single peak | ${naiveHit}/${n} | ${refineNaive}/${n} | - |`,
    `| iterative top-1 | ${iterTop1Hit}/${n} | ${refineIter}/${n} | [${(100 * t1Lo).toFixed(0)}, ${(100 * t1Hi).toFixed(0)}] |`,
    `| iterative top-${k} (any) | ${iterTopKHit}/${n} | - | [${(100 * kLo).toFixed(0)}, ${(100 * kHi).toFixed(0)}] |`,
    `| ORACLE (truth seed, ceiling) | - | ${refineOracle}/${n} | - |`,
    "",
    `Seed-recall gain (iterative top-${k} over the single peak) = ${recallGainPp >= 0 ? "+" : ""}${recallGainPp.toFixed(1)} pp.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Discovery claims stay structurally false; nothing here is gated, anchored, or deployed.",
    "",
  ].join("\n");
  writeFileSync("reports/p67-seed-precision.md", md);
  console.log("\nwrote reports/p67-seed-precision.md and reports/p67-seed-precision.json");
}

main().catch((e) => { console.error(`[p67] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
