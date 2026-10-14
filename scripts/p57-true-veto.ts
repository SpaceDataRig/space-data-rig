// P57: the REAL true-veto 2x2 acceptance test (roadmap priority 0) -- the measurement P52 believed
// was blocked behind an ExoFOP token but that the public TOI table supplies token-free.
//
// The reviewer's standard for a veto tool is the full 2x2: against a MIX of labelled blends/false
// positives (which it SHOULD fire on) and known planets (which it must NOT), how many blends does it
// CATCH and how many planets does it WRONGLY KILL? P53 could only measure the second half (positives).
// Here we take, from the public ExoFOP TOI table: known-planet (KP) rows as the positive class and
// false-positive / eclipsing-binary (FP/EB) rows as the negative class, each with its catalog
// ephemeris; fetch the real TESS-SPOC target-pixel cube; run the PSF double-difference localization
// (src/detect/psfDiffImaging.ts) and the naive centroid (P44 baseline); then feed the labelled cases
// into the acceptance scorer (src/candidate/vetoAcceptance.ts) for the true veto power / false-veto /
// ROC / safe-to-gate verdict.
//
// HONEST CAVEAT we bake in: the TOI label does NOT separate an OFF-target blend (which a localization
// veto CAN catch) from an ON-target eclipsing binary (which it legitimately cannot -- that needs a
// shape/odd-even discriminator). So the measured veto power is a LOWER BOUND for the localization
// tool, and the clean, disqualifying number is the FALSE-VETO rate (a KP wrongly killed). We report
// both plus the offset distributions so the reader sees the mechanism, and keep nothing gated.
//
// Usage:
//   npm run p57:true-veto
//   npm run p57:true-veto -- --neg 18 --pos 18 --tmag 11 --boot 120
import { writeFileSync, mkdirSync } from "node:fs";
import {
  fetchToiTable, labelledNegatives, confirmedPositives, type ToiRecord,
} from "../src/data/toiDispositions.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { localizePsfDiff, judgePsfDiff } from "../src/detect/psfDiffImaging.ts";
import { localizeTransitSource, judgeLocalization } from "../src/detect/diffImaging.ts";
import { acceptVetoTool, type VetoCase } from "../src/candidate/vetoAcceptance.ts";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

const wantNeg = Math.round(argNum("neg", 18));
const wantPos = Math.round(argNum("pos", 18));
const tmagCap = argNum("tmag", 11); // SPOC covers bright targets; keep the sample bright enough to have cubes
const boot = Math.round(argNum("boot", 120));
const GATE_ARCSEC = 2.0;
const MIN_AMP_SNR = 5;
const MIN_DELTA_CHI2 = 9;

interface Measured {
  rec: ToiRecord;
  sector: number;
  psfOffset: number;
  psfVeto: boolean;
  psfClassification: string;
  naiveOffset: number;
  naiveVeto: boolean;
}

// brightest-first so we maximize the chance a TESS-SPOC cube exists for the target
function pickBrightest(rows: ToiRecord[], n: number): ToiRecord[] {
  return rows
    .filter((r) => Number.isFinite(r.tessMag) && r.tessMag <= tmagCap)
    .sort((a, b) => a.tessMag - b.tessMag)
    .slice(0, n);
}

async function measureOne(rec: ToiRecord): Promise<Measured | null> {
  const name = `TIC ${rec.tic} TOI ${rec.toi}`;
  const sectorList = rec.sectors.length ? rec.sectors : await sectorsForCoord(rec.ra, rec.dec).catch(() => [] as number[]);
  for (const s of sectorList.slice(0, 3)) {
    try {
      const lc = await fetchSpocLightCurve(rec.tic, [s], name);
      if (!lc) continue;
      const cube = await fetchSpocTargetPixels(rec.tic, s, lc.targetId);
      if (!cube) continue;
      const psf = localizePsfDiff(cube, rec.epochBjd, rec.periodDays, Number.isFinite(rec.durationHours) ? rec.durationHours : 2, { bootstraps: boot, seed: 4242 });
      const naive = localizeTransitSource(cube, rec.epochBjd, rec.periodDays, Number.isFinite(rec.durationHours) ? rec.durationHours : 2, { bootstraps: boot, seed: 4242 });
      if (!psf || !psf.determined || !naive || !naive.determined) return null;
      const pv = judgePsfDiff(psf, GATE_ARCSEC, { minAmpSnr: MIN_AMP_SNR, minDeltaChi2: MIN_DELTA_CHI2 });
      const nv = judgeLocalization(naive, GATE_ARCSEC, { minSnr: 5 });
      return {
        rec, sector: s,
        psfOffset: psf.offsetArcsec, psfClassification: pv.classification, psfVeto: pv.classification === "off-target",
        naiveOffset: naive.offsetArcsec, naiveVeto: nv.classification === "off-target",
      };
    } catch { /* try next sector */ }
  }
  return null;
}

function q(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

async function main() {
  console.log(`P57 real true-veto 2x2 acceptance (gate=${GATE_ARCSEC}", boot=${boot}, tmag<=${tmagCap})`);
  const records = await fetchToiTable();
  if (records.length === 0) {
    console.log("public TOI table unavailable (network) -- cannot build the labelled classes here.");
    return;
  }
  const negAll = labelledNegatives(records);
  const posAll = confirmedPositives(records);
  console.log(`public TOI table: ${records.length} rows; labelled negatives(FP/EB,placeable)=${negAll.length}; positives(KP,placeable)=${posAll.length}`);

  const negPick = pickBrightest(negAll, wantNeg);
  const posPick = pickBrightest(posAll, wantPos);
  console.log(`brightest-first sample to measure: ${negPick.length} negatives + ${posPick.length} positives\n`);

  const measured: Measured[] = [];
  let skippedNoCube = 0;
  for (const rec of [...negPick, ...posPick]) {
    const m = await measureOne(rec);
    if (!m) { skippedNoCube++; continue; }
    measured.push(m);
    const tag = rec.label === "blend-or-fp" ? "NEG" : "POS";
    console.log(`  [${tag}] ${rec.label.padEnd(12)} TIC ${rec.tic} s${m.sector}: PSF offset ${m.psfOffset.toFixed(2)}" -> ${m.psfClassification}${m.psfVeto ? " (VETO)" : ""} | naive ${m.naiveOffset.toFixed(2)}"${m.naiveVeto ? " (VETO)" : ""}`);
  }

  const measuredNeg = measured.filter((m) => m.rec.label === "blend-or-fp");
  const measuredPos = measured.filter((m) => m.rec.label === "known-planet");
  console.log(`\nusable labelled cases: ${measured.length} (${measuredNeg.length} negatives, ${measuredPos.length} positives); ${skippedNoCube} sampled targets had no SPOC cube / too few cadences`);

  if (measured.length === 0) {
    console.log("no measurable cases (network/SPOC unavailable) -- cannot run the acceptance test here.");
    return;
  }

  // Build labelled VetoCases (PSF veto) and the naive-centroid comparison set.
  const psfCases: VetoCase[] = measured.map((m) => ({
    id: `TIC ${m.rec.tic}`,
    isBlend: m.rec.label === "blend-or-fp",
    veto: m.psfVeto,
    score: m.psfOffset,
  }));
  const naiveCases: VetoCase[] = measured.map((m) => ({
    id: `TIC ${m.rec.tic}`,
    isBlend: m.rec.label === "blend-or-fp",
    veto: m.naiveVeto,
    score: m.naiveOffset,
  }));

  const psfVerdict = acceptVetoTool(psfCases, { targetPower: 0.5, maxFalseVetoes: 0 });
  const naiveVerdict = acceptVetoTool(naiveCases, { targetPower: 0.5, maxFalseVetoes: 0 });

  const negOffsets = measuredNeg.map((m) => m.psfOffset).sort((a, b) => a - b);
  const posOffsets = measuredPos.map((m) => m.psfOffset).sort((a, b) => a - b);

  console.log(`\nPSF veto -- true 2x2: ${JSON.stringify(psfVerdict.metrics.cm)}`);
  console.log(`  veto power (catch rate on labelled blends) = ${psfVerdict.metrics.vetoPower == null ? "n/a" : psfVerdict.metrics.vetoPower.toFixed(2)} ${psfVerdict.metrics.vetoPowerCI ? `[${psfVerdict.metrics.vetoPowerCI[0].toFixed(2)}, ${psfVerdict.metrics.vetoPowerCI[1].toFixed(2)}]` : ""}`);
  console.log(`  false-veto rate (real planets killed)      = ${psfVerdict.metrics.falseVetoRate == null ? "n/a" : psfVerdict.metrics.falseVetoRate.toFixed(2)} ${psfVerdict.metrics.falseVetoCI ? `[${psfVerdict.metrics.falseVetoCI[0].toFixed(2)}, ${psfVerdict.metrics.falseVetoCI[1].toFixed(2)}]` : ""}`);
  console.log(`  ROC AUC (blend offset vs planet offset)    = ${psfVerdict.auc == null ? "n/a" : psfVerdict.auc.toFixed(3)}`);
  console.log(`  naive centroid: power=${naiveVerdict.metrics.vetoPower?.toFixed(2)} falseVeto=${naiveVerdict.metrics.falseVetoRate?.toFixed(2)} AUC=${naiveVerdict.auc?.toFixed(3)}`);
  console.log(`  blend PSF offsets  arcsec: p50=${q(negOffsets, 0.5).toFixed(2)} max=${negOffsets[negOffsets.length - 1]?.toFixed(2) ?? "n/a"}`);
  console.log(`  planet PSF offsets arcsec: p50=${q(posOffsets, 0.5).toFixed(2)} max=${posOffsets[posOffsets.length - 1]?.toFixed(2) ?? "n/a"}`);
  console.log(`\n  PSF VERDICT: safeToGate=${psfVerdict.safeToGate} -- ${psfVerdict.reason}`);
  console.log(`  (caveat: FP/EB labels mix off-target blends, which localization can catch, with on-target`);
  console.log(`   eclipsing binaries, which it cannot -- so veto power is a LOWER bound; false-veto rate is exact)`);

  const json = {
    meta: {
      generatedBy: "scripts/p57-true-veto.ts", gateArcsec: GATE_ARCSEC, boot, tmagCap,
      labelSource: "public ExoFOP TOI table (token-free) TESS/TFOPWG Disposition",
      negativeClass: "FP (TFOPWG False Positive) or EB (TESS Eclipsing Binary)",
      positiveClass: "KP (known planet)",
      detector: "src/detect/psfDiffImaging.ts (PSF double-difference) + diffImaging.ts (naive)",
      scorer: "src/candidate/vetoAcceptance.ts",
      caveat: "FP/EB labels do not separate off-target blends (catchable by localization) from on-target" +
        " eclipsing binaries (not catchable); veto power is therefore a LOWER bound, false-veto rate is exact.",
    },
    population: { tableRows: records.length, labelledNegatives: negAll.length, labelledPositives: posAll.length, sampledNeg: negPick.length, sampledPos: posPick.length, usable: measured.length, usableNeg: measuredNeg.length, usablePos: measuredPos.length, skippedNoCube },
    psf: { verdict: psfVerdict.safeToGate, reason: psfVerdict.reason, cm: psfVerdict.metrics.cm, vetoPower: psfVerdict.metrics.vetoPower, vetoPowerCI: psfVerdict.metrics.vetoPowerCI, falseVetoRate: psfVerdict.metrics.falseVetoRate, falseVetoCI: psfVerdict.metrics.falseVetoCI, vetoPrecision: psfVerdict.metrics.vetoPrecision, auc: psfVerdict.auc },
    naive: { verdict: naiveVerdict.safeToGate, reason: naiveVerdict.reason, cm: naiveVerdict.metrics.cm, vetoPower: naiveVerdict.metrics.vetoPower, falseVetoRate: naiveVerdict.metrics.falseVetoRate, auc: naiveVerdict.auc },
    blendOffsetArcsec: { p50: q(negOffsets, 0.5), max: negOffsets[negOffsets.length - 1] ?? null },
    planetOffsetArcsec: { p50: q(posOffsets, 0.5), max: posOffsets[posOffsets.length - 1] ?? null },
    cases: measured.map((m) => ({ tic: m.rec.tic, toi: m.rec.toi, label: m.rec.label, tessMag: m.rec.tessMag, sector: m.sector, psfOffsetArcsec: +m.psfOffset.toFixed(3), psfClassification: m.psfClassification, naiveOffsetArcsec: +m.naiveOffset.toFixed(3) })),
    discoveryClaim: false,
    safeToGate: psfVerdict.safeToGate,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p57-true-veto.json", JSON.stringify(json, null, 2) + "\n");

  const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "n/a" : (v * 100).toFixed(0) + "%");
  const md = [
    "# P57 the real true-veto 2x2 acceptance test (token-free labelled negative class)",
    "",
    `Reproduce: \`npm run p57:true-veto -- --neg ${wantNeg} --pos ${wantPos} --tmag ${tmagCap} --boot ${boot}\``,
    "Labels come from the PUBLIC ExoFOP TOI table (no token): known planets (KP) = must keep, and",
    "false positives / eclipsing binaries (FP/EB) = should veto. Each case's ephemeris drives a real",
    "TESS-SPOC target-pixel cube through the PSF double-difference localization; the labelled",
    "decisions go into the acceptance scorer (`src/candidate/vetoAcceptance.ts`).",
    "",
    `**Population.** Table rows ${records.length}; placeable labelled negatives ${negAll.length}, positives ${posAll.length};`,
    `brightest-first sample ${negPick.length}+${posPick.length}; **${measured.length} usable** (${measuredNeg.length} negatives, ${measuredPos.length} positives) with a retrievable cube;`,
    `${skippedNoCube} sampled targets had no SPOC product or too few in/out cadences.`,
    "",
    "## PSF double-difference -- the true 2x2",
    "",
    "| | labelled blend (should veto) | labelled planet (must keep) |",
    "|---|---|---|",
    `| veto fired | ${psfVerdict.metrics.cm.trueVeto} | ${psfVerdict.metrics.cm.falseVeto} |`,
    `| kept | ${psfVerdict.metrics.cm.missedBlend} | ${psfVerdict.metrics.cm.trueKeep} |`,
    "",
    `- veto power (blends caught): **${pct(psfVerdict.metrics.vetoPower)}** ${psfVerdict.metrics.vetoPowerCI ? `(95% CI ${psfVerdict.metrics.vetoPowerCI[0].toFixed(2)}-${psfVerdict.metrics.vetoPowerCI[1].toFixed(2)})` : ""}`,
    `- false-veto rate (planets killed): **${pct(psfVerdict.metrics.falseVetoRate)}** ${psfVerdict.metrics.falseVetoCI ? `(95% CI ${psfVerdict.metrics.falseVetoCI[0].toFixed(2)}-${psfVerdict.metrics.falseVetoCI[1].toFixed(2)})` : ""}`,
    `- ROC AUC (blend vs planet offset): ${psfVerdict.auc == null ? "n/a" : psfVerdict.auc.toFixed(3)}; naive centroid AUC ${naiveVerdict.auc == null ? "n/a" : naiveVerdict.auc.toFixed(3)}`,
    `- blend offsets p50 ${q(negOffsets, 0.5).toFixed(2)}" / max ${negOffsets[negOffsets.length - 1]?.toFixed(2) ?? "n/a"}"; planet offsets p50 ${q(posOffsets, 0.5).toFixed(2)}" / max ${posOffsets[posOffsets.length - 1]?.toFixed(2) ?? "n/a"}"`,
    "",
    `**VERDICT: safeToGate = ${psfVerdict.safeToGate}.** ${psfVerdict.reason}`,
    "",
    "## Honest caveat (why a modest power number here is NOT the whole story)",
    "",
    "The FP/EB label does not distinguish an **off-target blend** (light from a neighbouring star --",
    "exactly what a localization veto can catch) from an **on-target eclipsing binary** (the dip really",
    "is at the target -- which localization *legitimately cannot* reject and should not try; that needs a",
    "shape / odd-even discriminator). So the catch-rate above is a **lower bound** for the localization",
    "tool, not its true sensitivity. The precise, disqualifying number is the **false-veto rate**: a known",
    "planet wrongly killed. Whatever the power number, we do NOT gate on it here.",
    "",
    "This is a MEASUREMENT, not a deployed gate. Nothing is wired into the critic / money path.",
    "discoveryClaim: false.",
    "",
  ].join("\n");
  writeFileSync("reports/p57-true-veto.md", md);
  console.log("\nwrote reports/p57-true-veto.md and reports/p57-true-veto.json");
}

main().catch((e) => {
  console.error("p57 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
