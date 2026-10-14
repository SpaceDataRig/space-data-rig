// P62 - PHASE-ALIGNED joint folding vs the naive stitch (third-party roadmap, targeted fix of the P60
// negative result; measure-before-gate). P60 found joint == single re-find (6/20 each, no lift) and the
// per-planet rows show WHY: most misses were PERIOD MISMATCH / phase drift on the stitched baseline, not
// low SNR (many known planets yield a high-SNR BLS peak at the WRONG period). A long stitched baseline makes
// the folded transit smear if the trial period is even slightly off, so the naive wide-scan BLS can lock onto
// a spurious harmonic instead of the true ephemeris.
//
// THE FIX THIS SCRIPT MEASURES (the reviewer's suggestion): find the candidate per-sector first (a coarse
// seed), then run a NARROW-WINDOW, HIGH-OVERSAMPLE joint fold around that seed -- a phase-aligned period
// REFINEMENT on the long baseline. If aligning the phase recovers the true ephemeris, the joint path should
// re-find MORE known planets than the naive stitch.
//
// Four arms on the SAME 20 confirmed planets P60 used (sample read back from reports/p60-joint-vs-single.json
// so it is a strict A/B, no re-selection):
//   SINGLE        -- best of independent per-sector bls(); recovered if ANY sector clears minSnr & matches (P60 baseline).
//   NAIVE-JOINT   -- bls() on the stitched baseline over the full period range (P60 baseline, expected ~6/20).
//   REFINED       -- seed = the highest-SNR single-sector period (DATA, no catalog peeking), then
//                    bls(stitched, {min/max period = seed*(1+-win), oversample}) = the phase-aligned joint fold.
//   ORACLE        -- same refinement but seeded at CATALOG truth (diagnostic ceiling: separates "bad seed"
//                    failures from "the joint fold cannot recover" failures).
//
// Positive control ONLY, on KNOWN planets. Research probe: no worker import, no verdict / bundle hash / money
// path, nothing anchored or claimed. discoveryClaim structurally false. If refinement gives NO clear lift, the
// honest conclusion ("joint search is not a free lunch on few-sector TESS baselines") is written to RESEARCH
// long-term limitations rather than papered over.
//
// Run: npm run p62:phase-aligned-joint [-- --minsnr 7 --tol 5 --win 0.10 --oversample 24 --maxsectors 4 --tmag 11 --minperiod 1 --maxperiod 13 --minsectordepth 150]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { foldedBoxDepth } from "../src/detect/shapeCoherence.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";

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
const win = Number(arg("win", "0.10")); // +- fractional window around the seed for the refinement scan
const oversample = Math.max(8, parseInt(arg("oversample", "24"), 10)); // finer frequency grid = phase alignment
const minSectorDepthPpm = Number(arg("minsectordepth", "150"));

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
  seedPeriod: number; // data seed (best single-sector period)
  singleRecovered: boolean; bestSingleSnr: number;
  naiveJointRecovered: boolean; naiveJointPeriod: number; naiveJointSnr: number;
  refinedRecovered: boolean; refinedPeriod: number; refinedSnr: number; refinedCorrob: number;
  oracleRecovered: boolean; oracleSnr: number;
}

async function main(): Promise<void> {
  // strict A/B: reuse the exact 20 planets P60 resolved (read the committed report's row names + periods).
  let baseline: { name: string; catPeriod: number }[] = [];
  try {
    const p60 = JSON.parse(readFileSync("reports/p60-joint-vs-single.json", "utf8"));
    baseline = (p60.rows || []).map((r: any) => ({ name: r.name, catPeriod: r.catPeriod }));
  } catch { console.log("  (could not read reports/p60-joint-vs-single.json -- falling back to fresh selection)"); }
  const wantNames = new Set(baseline.map((b) => b.name));
  const catPeriodByName = new Map(baseline.map((b) => [b.name, b.catPeriod]));

  console.log(`P62 PHASE-ALIGNED joint fold vs naive stitch: strict A/B on the ${baseline.length || "?"} P60 planets; refine window +-${(win * 100).toFixed(0)}%, oversample ${oversample}, minSnr ${minSnr}, tol ${tolPct}%. REAL SPOC photometry, token-free; no discovery claim.`);

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

    // SINGLE + data seed (best-SNR sector).
    let bestSingle = { periodDays: NaN, snr: -Infinity };
    let singleRecovered = false;
    for (const lc of sectorLcs) {
      let b; try { b = bls(lc, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
      if (b.snr > bestSingle.snr) bestSingle = { periodDays: b.periodDays, snr: b.snr };
      if (b.snr >= minSnr && matched(b.periodDays, catPeriod)) singleRecovered = true;
    }

    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;

    // NAIVE-JOINT (full-range stitched fold -- the P60 arm).
    let naive = { periodDays: NaN, snr: NaN, epochBjd: NaN, durationDays: NaN };
    try { const b = bls(stitched, { maxPeriodDays: maxPeriod + 2 }); naive = { periodDays: b.periodDays, snr: b.snr, epochBjd: b.epochBjd, durationDays: b.durationDays }; } catch { /* ignore */ }
    const naiveJointRecovered = naive.snr >= minSnr && matched(naive.periodDays, catPeriod);

    // REFINED (data seed -> narrow-window phase-aligned joint fold).
    let refined = { periodDays: NaN, snr: NaN, epochBjd: NaN, durationDays: NaN };
    if (Number.isFinite(bestSingle.periodDays) && bestSingle.periodDays > 1) {
      try {
        const b = bls(stitched, { minPeriodDays: bestSingle.periodDays * (1 - win), maxPeriodDays: bestSingle.periodDays * (1 + win), oversample });
        refined = { periodDays: b.periodDays, snr: b.snr, epochBjd: b.epochBjd, durationDays: b.durationDays };
      } catch { /* ignore */ }
    }
    const refinedRecovered = refined.snr >= minSnr && matched(refined.periodDays, catPeriod);
    let refinedCorrob = 0;
    if (refinedRecovered) {
      for (const lc of sectorLcs) {
        const d = foldedBoxDepth(lc, refined.periodDays, refined.epochBjd, refined.durationDays);
        const depthPpm = d.depth * 1e6;
        if (Number.isFinite(depthPpm) && depthPpm >= minSectorDepthPpm && classifyDepthRegime(depthPpm).planetPlausible) refinedCorrob++;
      }
    }

    // ORACLE (catalog-truth seed -> refinement ceiling; diagnostic only, NOT a discovery procedure).
    let oracle = { periodDays: NaN, snr: NaN };
    try { const b = bls(stitched, { minPeriodDays: catPeriod * (1 - win), maxPeriodDays: catPeriod * (1 + win), oversample }); oracle = { periodDays: b.periodDays, snr: b.snr }; } catch { /* ignore */ }
    const oracleRecovered = oracle.snr >= minSnr && matched(oracle.periodDays, catPeriod);

    rows.push({
      name, catPeriod, nSectors: sectorLcs.length, seedPeriod: bestSingle.periodDays,
      singleRecovered, bestSingleSnr: bestSingle.snr,
      naiveJointRecovered, naiveJointPeriod: naive.periodDays, naiveJointSnr: naive.snr,
      refinedRecovered, refinedPeriod: refined.periodDays, refinedSnr: refined.snr, refinedCorrob,
      oracleRecovered, oracleSnr: oracle.snr,
    });
    console.log(`  ${name.padEnd(16)} P=${catPeriod.toFixed(3)}d nsec ${sectorLcs.length}  single[${singleRecovered ? "RE" : "--"}]  naive[${naiveJointRecovered ? "RE" : "--"} Snr ${Number.isFinite(naive.snr) ? naive.snr.toFixed(0) : "?"}]  refined[${refinedRecovered ? "RE" : "--"} P ${Number.isFinite(refined.periodDays) ? refined.periodDays.toFixed(3) : "?"} Snr ${Number.isFinite(refined.snr) ? refined.snr.toFixed(0) : "?"}]  oracle[${oracleRecovered ? "RE" : "--"}]`);
  }

  if (rows.length < 5) {
    console.log(`\nonly ${rows.length} planets resolved (catalog/SPOC fallback?). VERDICT: INSUFFICIENT-DATA (re-run shortly)`);
    process.exitCode = 0; return;
  }

  const n = rows.length;
  const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
  const single = cnt((r) => r.singleRecovered);
  const naive = cnt((r) => r.naiveJointRecovered);
  const refined = cnt((r) => r.refinedRecovered);
  const oracle = cnt((r) => r.oracleRecovered);
  const refinedCorrob = cnt((r) => r.refinedRecovered && r.refinedCorrob >= 2);
  const fixedByRefine = cnt((r) => r.refinedRecovered && !r.naiveJointRecovered); // naive-miss, refined-hit
  const brokeByRefine = cnt((r) => !r.refinedRecovered && r.naiveJointRecovered);
  const [rLo, rHi] = wilsonInterval(refined, n);
  const [nLo, nHi] = wilsonInterval(naive, n);
  const liftRefinedVsSingle = 100 * (refined - single) / n;
  const liftRefinedVsNaive = 100 * (refined - naive) / n;

  console.log(`\n=== P62 SUMMARY (${n} confirmed planets, >=2 usable sectors) ===`);
  console.log(`  SINGLE        : ${single}/${n} = ${(100 * single / n).toFixed(1)}%`);
  console.log(`  NAIVE-JOINT   : ${naive}/${n} = ${(100 * naive / n).toFixed(1)}%  [${(100 * nLo).toFixed(0)}, ${(100 * nHi).toFixed(0)}]`);
  console.log(`  REFINED (data): ${refined}/${n} = ${(100 * refined / n).toFixed(1)}%  [${(100 * rLo).toFixed(0)}, ${(100 * rHi).toFixed(0)}]   (+${liftRefinedVsNaive.toFixed(1)} pp vs naive, ${liftRefinedVsSingle >= 0 ? "+" : ""}${liftRefinedVsSingle.toFixed(1)} vs single)`);
  console.log(`  REFINED corroborated (>=2 sectors confirm at refined ephemeris): ${refinedCorrob}/${n}`);
  console.log(`  ORACLE (truth-seed ceiling): ${oracle}/${n} = ${(100 * oracle / n).toFixed(1)}%`);
  console.log(`  refinement FIXED ${fixedByRefine} naive-misses, BROKE ${brokeByRefine} (period-mismatch is the lever, not SNR)`);
  console.log(`  gap oracle-refined = ${oracle - refined}  -> ${oracle > refined ? "the joint fold CAN recover when seeded right; the bottleneck is seed acquisition (single-sector detection), not the alignment" : "even a perfect seed does not lift re-find here -> the few-sector baseline itself, not phase drift, is the limit"}`);

  const clearLift = refined - naive >= 2 && refined - single >= 2;
  const verdict = clearLift
    ? "PHASE-ALIGNMENT-LIFTS (refined joint fold re-finds clear more known planets than naive/single -- the alignment fix works; a future novel hunt may lean on it, still requiring novelty + calibrated vetting + independent follow-up, discoveryClaim false)"
    : refined > naive || refined > single
      ? "MODEST-NOISE-LIFT (small gain within overlapping Wilson CIs -- not decisive)"
      : "NO-LIFT-JOINT-NOT-A-FREE-LUNCH (phase-aligned refinement does not recover more known planets on this few-sector sample; the P60 negative stands and is now mechanistically explained)";
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  measure-before-gate: positive control on KNOWN planets; NOT a discovery; no gate relaxed. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p62-phase-aligned-joint.ts", n, maxSectors, minPeriod, maxPeriod, tmagCap, minSnr, tolPct, win, oversample, minSectorDepthPpm,
      arms: "SINGLE best per-sector bls; NAIVE full-range stitched bls; REFINED stitched bls seeded at the best single-sector period within +-win (phase-aligned fold); ORACLE same seeded at catalog truth (diagnostic ceiling)",
      data: "real TESS-SPOC light curves (token-free public S3); strict A/B on the P60 20-planet sample",
      note: "targets the P60 negative (period-mismatch / phase-drift); NOT a discovery claim; nothing gated.",
    },
    singleRefind: { count: single, n, rate: single / n },
    naiveJointRefind: { count: naive, n, rate: naive / n, ciLow: nLo, ciHigh: nHi },
    refinedRefind: { count: refined, n, rate: refined / n, ciLow: rLo, ciHigh: rHi },
    refinedCorroborated: { count: refinedCorrob, n },
    oracleRefind: { count: oracle, n, rate: oracle / n },
    fixedByRefine, brokeByRefine,
    liftRefinedVsNaivePp: liftRefinedVsNaive, liftRefinedVsSinglePp: liftRefinedVsSingle,
    bottleneck: oracle > refined ? "seed-acquisition" : "few-sector-baseline",
    verdict,
    discoveryClaim: false,
    rows,
  };
  writeFileSync("reports/p62-phase-aligned-joint.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P62 phase-aligned joint folding vs the naive stitch (targeted fix of the P60 negative)",
    "",
    `Reproduce: \`npm run p62:phase-aligned-joint -- --minsnr ${minSnr} --tol ${tolPct} --win ${win} --oversample ${oversample}\``,
    "",
    `P60 found joint == single re-find (${naive}/${n} each) and the per-planet rows showed why: most`,
    "misses were PERIOD MISMATCH on the stitched long baseline (a high-SNR peak at the wrong period from phase",
    "drift), not low SNR. This script tests the reviewer's fix -- detect per-sector first, then run a narrow,",
    "high-oversample joint fold around that seed (phase-aligned period refinement) -- on the SAME planets.",
    "",
    `| arm | re-find | 95% Wilson CI |`,
    `|---|---|---|`,
    `| single-sector (best) | ${single}/${n} = ${(100 * single / n).toFixed(1)}% | - |`,
    `| naive joint (full-range) | ${naive}/${n} = ${(100 * naive / n).toFixed(1)}% | [${(100 * nLo).toFixed(0)}, ${(100 * nHi).toFixed(0)}] |`,
    `| REFINED (data-seed, phase-aligned) | ${refined}/${n} = ${(100 * refined / n).toFixed(1)}% | [${(100 * rLo).toFixed(0)}, ${(100 * rHi).toFixed(0)}] |`,
    `| ORACLE (truth-seed ceiling, diagnostic) | ${oracle}/${n} = ${(100 * oracle / n).toFixed(1)}% | - |`,
    "",
    `Refinement FIXED ${fixedByRefine} naive-misses and BROKE ${brokeByRefine}. Corroborated at the refined`,
    `ephemeris (>=2 sectors confirm a planet-plausible dip): ${refinedCorrob}/${n}.`,
    "",
    `**Bottleneck:** oracle minus refined = ${oracle - refined}. ${oracle > refined ? "A perfect (truth) seed recovers more than the data seed, so the binding constraint is single-sector seed acquisition, not the alignment step." : "Even a truth seed does not lift re-find here, so the few-sector baseline itself -- not phase drift -- is the limit."}`,
    "",
    `**VERDICT: ${json.verdict}**`,
    "",
    "Discovery claims stay structurally false; nothing here is gated, anchored, or deployed.",
    "",
  ].join("\n");
  writeFileSync("reports/p62-phase-aligned-joint.md", md);
  console.log("\nwrote reports/p62-phase-aligned-joint.md and reports/p62-phase-aligned-joint.json");
}

main().catch((e) => { console.error(`[p62] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
