// P77 - faithful re-port + RE-MEASUREMENT of eumemic's multi-sector centroid F-test (validation/centroid_sectors.md).
//
// WHY. P74 mis-described eumemic's cross-sector centroid check as a "same-direction coherence" test and measured
// THAT; the author corrected us: their real method is an F-test on the MEAN per-sector offset against the target
// and against every star within 2' bright enough to cause the dip (per-axis scatter floored at 1", at least two
// sectors). The statistic now lives in src/detect/centroidFtest.ts (with offline tests). This script applies it to
// our OWN real data and measures the load-bearing acceptance number eumemic reports -- the known-planet FALSE-REJECT
// rate (0/565 at p<0.001) -- plus the labelled-blend catch, so we can honestly say whether THEIR method, not our
// earlier coherence variant, behaves on our sample.
//
// SCOPING (honest). This first re-port tests the TARGET hypothesis (s = 0,0) per target: rejecting it flags the
// signal as off-target. The known-planet false-reject rate and the labelled-blend catch are fully determined by the
// target test; we do NOT yet run the per-neighbour "which star fits" pass (it needs a T-magnitude neighbour census
// per target that we have not assembled here). So a blend here means "off the target," and an on-target eclipsing
// binary (not off-target) is NOT expected to be caught -- same caveat P74 logged.
//
// Red lines: research only. No worker import, no verdict, no bundle hash, no money path; nothing gated, anchored or
// claimed. discoveryClaim false, safeToGate false (sample is tiny by design).
//
// Usage: npm run p77:centroid-ctest [-- --pos 20 --neg 20 --tmag 11 --maxsectors 8 --minsnr 5 --boot 120 --alpha 0.001]

import { writeFileSync, mkdirSync } from "node:fs";
import { fetchToiTable, labelledNegatives, confirmedPositives, type ToiRecord } from "../src/data/toiDispositions.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { localizeTransitSource, PIXEL_SCALE_ARCSEC, type SourceLocalization } from "../src/detect/diffImaging.ts";
import { targetCentroidP, type Offset } from "../src/detect/centroidFtest.ts";

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) { const v = Number(hit.split("=")[1]); if (Number.isFinite(v)) return v; }
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

const wantPos = Math.round(argNum("pos", 20));
const wantNeg = Math.round(argNum("neg", 20));
const tmagCap = argNum("tmag", 11);
const maxSectors = Math.max(2, Math.round(argNum("maxsectors", 8)));
const MIN_SNR = argNum("minsnr", 5);
const boot = Math.round(argNum("boot", 120));
const ALPHA = argNum("alpha", 0.001);
const ALPHA2 = 0.01;
const DUR = 2; // fixed narrow box (catalog duration unreliable), matching P58/P74

interface Measured {
  rec: ToiRecord;
  offsets: Offset[]; // per-sector east/north offsets (arcsec), usable sectors only
  pTarget: number; // F-test of the mean offset against the target (s=0,0)
  nUsed: number;
  nDropped: number;
  meanOffsetArcsec: number;
  testable: boolean; // nUsed >= 2
}

function pickBrightest(rows: ToiRecord[], n: number): ToiRecord[] {
  return rows.filter((r) => Number.isFinite(r.tessMag) && r.tessMag <= tmagCap).sort((a, b) => a.tessMag - b.tessMag).slice(0, n);
}

function offsetOf(loc: SourceLocalization): Offset {
  return { east: (loc.sourceCentroid.x - loc.targetCentroid.x) * PIXEL_SCALE_ARCSEC, north: (loc.sourceCentroid.y - loc.targetCentroid.y) * PIXEL_SCALE_ARCSEC };
}

async function measure(rec: ToiRecord): Promise<Measured | null> {
  const name = `TIC ${rec.tic} TOI ${rec.toi}`;
  const list = (rec.sectors.length ? rec.sectors : await sectorsForCoord(rec.ra, rec.dec).catch(() => [] as number[])).slice(0, maxSectors);
  const offsets: Offset[] = [];
  for (const s of list) {
    try {
      const lc = await fetchSpocLightCurve(rec.tic, [s], name);
      if (!lc) continue;
      const cube = await fetchSpocTargetPixels(rec.tic, s, lc.targetId);
      if (!cube) continue;
      const loc = localizeTransitSource(cube, rec.epochBjd, rec.periodDays, DUR, { bootstraps: boot, seed: 4242 });
      if (!loc || !loc.determined || loc.dropSnr < MIN_SNR) continue;
      offsets.push(offsetOf(loc));
    } catch { /* try next sector */ }
  }
  const r = targetCentroidP(offsets);
  return {
    rec, offsets, pTarget: r.p, nUsed: r.nUsed, nDropped: r.nDropped,
    meanOffsetArcsec: Math.hypot(r.meanEast, r.meanNorth), testable: r.testable,
  };
}

function q(sorted: number[], f: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

async function main() {
  console.log(`P77 eumemic multi-sector centroid F-test re-port (alpha=${ALPHA}, floor 1"/axis, drop>60", maxSectors=${maxSectors}, minSnr=${MIN_SNR}). Target-hypothesis rejection only; measure-before-gate.`);
  const records = await fetchToiTable();
  if (!records.length) { console.log("public TOI table unavailable (network) -- nothing to measure."); process.exitCode = 1; return; }
  const posPick = pickBrightest(confirmedPositives(records), wantPos);
  const negPick = pickBrightest(labelledNegatives(records), wantNeg);
  console.log(`sample brightest-first: ${posPick.length} known planets (KP) + ${negPick.length} labelled blends (FP/EB)`);

  const measured: Measured[] = [];
  let skip = 0;
  for (const rec of [...posPick, ...negPick]) {
    const m = await measure(rec);
    if (!m) { skip++; continue; }
    measured.push(m);
    const tag = rec.label === "blend-or-fp" ? "NEG" : "POS";
    const pStr = m.testable ? m.pTarget.toExponential(1) : "n/a(<2)";
    console.log(`  [${tag}] TIC ${rec.tic} sectors ${m.nUsed} (drop ${m.nDropped}) mean ${m.meanOffsetArcsec.toFixed(1)}"  p_target ${pStr}${m.testable && m.pTarget < ALPHA ? " REJECT-TARGET" : ""}`);
  }

  const testable = measured.filter((m) => m.testable);
  const posT = testable.filter((m) => m.rec.label === "known-planet");
  const negT = testable.filter((m) => m.rec.label === "blend-or-fp");
  const posReject = posT.filter((m) => m.pTarget < ALPHA).length;
  const posReject2 = posT.filter((m) => m.pTarget < ALPHA2).length;
  const negCatch = negT.filter((m) => m.pTarget < ALPHA).length;
  const negCatch2 = negT.filter((m) => m.pTarget < ALPHA2).length;
  const posMeanP50 = q(posT.map((m) => m.meanOffsetArcsec).sort((a, b) => a - b), 0.5);
  const negMeanP50 = q(negT.map((m) => m.meanOffsetArcsec).sort((a, b) => a - b), 0.5);

  console.log(`\nusable ${measured.length}; testable (>=2 sectors) ${testable.length} -> ${posT.length} planets, ${negT.length} blends; ${skip} had no cube / <2 usable sectors`);
  console.log(`  KNOWN-PLANET target-reject: ${posReject}/${posT.length} at p<${ALPHA} (their calibration: 0/565); ${posReject2}/${posT.length} at p<${ALPHA2}`);
  console.log(`  BLEND target-reject (catch): ${negCatch}/${negT.length} at p<${ALPHA} (their: 127/175=73%); ${negCatch2}/${negT.length} at p<${ALPHA2}`);
  console.log(`  mean |offset| p50: planets ${posMeanP50.toFixed(1)}"  blends ${negMeanP50.toFixed(1)}"`);

  const insufficient = posT.length + negT.length < 10;
  const safeHere = posReject === 0;
  const verdict = posT.length === 0 || negT.length === 0
    ? "INSUFFICIENT-COVERAGE: the fewest-sector class has no testable (>=2-sector) target, so the false-reject-vs-catch trade-off cannot be read on this sample. The re-port runs; it is not yet validated here. Measure-only."
    : insufficient
      ? `MEASURED-TINY (n=${testable.length} testable): known-planet false-reject ${posReject}/${posT.length} at p<${ALPHA}; blend catch ${negCatch}/${negT.length}. ${safeHere ? "Zero false-rejects is consistent with eumemic's 0/565, but" : "Non-zero false-rejects,"} n is far below their 565/175, so this is a smoke-test of the faithful re-port, NOT a re-validation. safeToGate stays false.`
      : `REPRODUCED-DIRECTIONALLY: on ${testable.length} testable targets the F-test false-rejected ${posReject}/${posT.length} known planets at p<${ALPHA} and caught ${negCatch}/${negT.length} labelled blends. ${safeHere ? "Zero false-rejects matches eumemic's 0/565 signature" : "Some false-rejects -- unlike eumemic's 0/565 -- likely from our coarser per-sector localization"}. Still below their sample size; advisory only.`;
  console.log(`\nVERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { generatedBy: "scripts/p77-centroid-ctest.ts", wantPos, wantNeg, tmagCap, maxSectors, MIN_SNR, boot, alpha: ALPHA, DUR,
      data: "real TESS-SPOC target-pixel cubes, per-sector difference-image centroid offsets (east/north arcsec); ExoFOP KP/FP/EB labels; token-free public S3",
      note: "faithful re-port of eumemic's centroid F-test (src/detect/centroidFtest.ts); target-hypothesis rejection only, no per-neighbour fit; measure-before-gate." },
    counts: { usable: measured.length, testable: testable.length, planetsTestable: posT.length, blendsTestable: negT.length, skip },
    planets: { rejectAtAlpha: posReject, rejectAt01: posReject2, n: posT.length, meanOffsetP50Arcsec: posMeanP50 },
    blends: { catchAtAlpha: negCatch, catchAt01: negCatch2, n: negT.length, meanOffsetP50Arcsec: negMeanP50 },
    eumemicReference: { planetFalseReject: "0/565 at p<0.001 (3/565 at p<0.01)", blendCatch: "127/175 (73%) at p<0.001; 38% within 15 arcsec", source: "eumemic/exoplanets validation/centroid_sectors.md" },
    cases: measured.map((m) => ({ tic: m.rec.tic, toi: m.rec.toi, label: m.rec.label, tessMag: m.rec.tessMag, nUsed: m.nUsed, nDropped: m.nDropped, testable: m.testable, meanOffsetArcsec: Number(m.meanOffsetArcsec.toFixed(2)), pTarget: m.pTarget })),
    verdict, safeToGate: false, discoveryClaim: false,
  };
  writeFileSync("reports/p77-centroid-ctest.json", JSON.stringify(json, null, 2), "utf8");
  const lines = [
    "# P77 eumemic multi-sector centroid F-test -- faithful re-port, measured on our data",
    "",
    `Reproduce: \`npm run p77:centroid-ctest -- --pos ${wantPos} --neg ${wantNeg} --maxsectors ${maxSectors} --minsnr ${MIN_SNR}\``,
    "",
    "P74 mislabelled eumemic's cross-sector centroid check; the author corrected us -- it is an F-test on the mean",
    "offset (1\"/axis floor, >=2 sectors) against the target and each star within 2'. src/detect/centroidFtest.ts now",
    "reproduces that statistic (verified against their formula and offline tests); this script runs it on our real",
    "SPOC cubes and reports the load-bearing number: does it false-reject our known planets?",
    "",
    "| class | testable (>=2 sectors) | target-rejected p<0.001 | p<0.01 | mean offset p50 |",
    "|---|---|---|---|---|",
    `| known planets | ${posT.length} | ${posReject} | ${posReject2} | ${posMeanP50.toFixed(1)}" |`,
    `| labelled blends | ${negT.length} | ${negCatch} | ${negCatch2} | ${negMeanP50.toFixed(1)}" |`,
    "",
    `eumemic calibration for reference: 0/565 known planets rejected at p<0.001, 127/175 (73%) neighbour-blend TOIs caught.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Measures only; changes no threshold, gates nothing, touches no money path. Target-hypothesis rejection only (no",
    "per-neighbour fit yet). discoveryClaim false, safeToGate false.",
  ];
  writeFileSync("reports/p77-centroid-ctest.md", lines.join("\n") + "\n", "utf8");
  console.log("wrote reports/p77-centroid-ctest.{md,json}");
}

main().catch((e) => { console.error("p77 failed:", e); process.exitCode = 1; });
