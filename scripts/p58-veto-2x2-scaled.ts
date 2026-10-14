// P58: a larger, HARDER true-veto 2x2 -- priority-0 scale-up with a phase refinement that removes a
// confound in P57.
//
// Two upgrades over scripts/p57:
//  (1) MORE labelled cases (bigger negative + positive samples -> tighter Wilson CIs).
//  (2) A TRANSIT-PHASE REFINEMENT. P57 localized each target at the raw catalog epoch; a known planet
//      whose catalog epoch has drifted off the single-sector baseline folds at the wrong phase, so the
//      "in-transit" rows mix real and empty signal and the difference image can mislocalize -- the most
//      likely explanation for P57's single false kill (a KP at a 43" PSF offset). Because the fold is
//      modulo the period, we sweep the phase across ONE period, pick the phase with the strongest real
//      transit dip (max naive dropSnr), and evaluate BOTH vetoes there. This isolates the tool's true
//      localization behaviour from catalog-timing error.
//
// Labels are the token-free public ExoFOP TOI dispositions (src/data/toiDispositions.ts): known planets
// (KP) = must keep, false positives / eclipsing binaries (FP/EB) = should veto. Each case drives its real
// TESS-SPOC target-pixel cube through the PSF double-difference (P53) and the naive centroid (P44), and
// the labelled decisions go into the acceptance scorer (src/candidate/vetoAcceptance.ts).
//
// HONEST CAVEAT (unchanged, now with more data): the FP/EB label does NOT separate an off-target blend
// (which localization CAN catch) from an on-target eclipsing binary (which it legitimately cannot). So the
// catch-rate is a LOWER bound, not the tool's true sensitivity; the clean, disqualifying number is the
// false-veto rate. Nothing is gated. Research-only; no verdict/bundle/money path. discoveryClaim false.
//
// Usage:
//   npm run p58:veto-2x2
//   npm run p58:veto-2x2 -- --neg 24 --pos 24 --tmag 11 --boot 80 --phases 16
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
const wantNeg = Math.round(argNum("neg", 24));
const wantPos = Math.round(argNum("pos", 24));
const tmagCap = argNum("tmag", 11);
const boot = Math.round(argNum("boot", 80));
const PHASES = Math.round(argNum("phases", 16));
const GATE_ARCSEC = 2.0;
const MIN_AMP_SNR = 5;
const MIN_DELTA_CHI2 = 9;

interface Measured {
  rec: ToiRecord; sector: number; phaseFrac: number;
  psfOffset: number; psfClassification: string; psfVeto: boolean; psfAmpSnr: number;
  naiveOffset: number; naiveVeto: boolean; naiveDropSnr: number;
}

function pickBrightest(rows: ToiRecord[], n: number): ToiRecord[] {
  return rows.filter((r) => Number.isFinite(r.tessMag) && r.tessMag <= tmagCap).sort((a, b) => a.tessMag - b.tessMag).slice(0, n);
}

function q(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

// Evaluate the two vetoes at a candidate transit phase. `withBoot` toggles the expensive bootstrap
// (only needed on the final chosen phase, not while sweeping phases to find the transit).
function evalAtPhase(cube: Parameters<typeof localizePsfDiff>[0], t0: number, P: number, dur: number, b: number) {
  const psf = localizePsfDiff(cube, t0, P, dur, { bootstraps: b, seed: 4242 });
  const naive = localizeTransitSource(cube, t0, P, dur, { bootstraps: Math.min(b, 40), seed: 4242 });
  return { psf, naive };
}

async function measureOne(rec: ToiRecord): Promise<Measured | null> {
  const name = `TIC ${rec.tic} TOI ${rec.toi}`;
  const dur = Number.isFinite(rec.durationHours) && rec.durationHours > 0 ? rec.durationHours : 2;
  const sectorList = rec.sectors.length ? rec.sectors : await sectorsForCoord(rec.ra, rec.dec).catch(() => [] as number[]);
  for (const s of sectorList.slice(0, 3)) {
    try {
      const lc = await fetchSpocLightCurve(rec.tic, [s], name);
      if (!lc) continue;
      const cube = await fetchSpocTargetPixels(rec.tic, s, lc.targetId);
      if (!cube) continue;
      // phase sweep (cheap) -> pick the phase with the strongest real transit dip (max naive dropSnr)
      let best = { frac: 0, dropSnr: -Infinity, psfAmpSnr: -Infinity };
      for (let j = 0; j < PHASES; j++) {
        const frac = j / PHASES;
        const { naive, psf } = evalAtPhase(cube, rec.epochBjd + frac * rec.periodDays, rec.periodDays, dur, 1);
        const dsnr = naive && naive.determined ? naive.dropSnr : -Infinity;
        if (dsnr > best.dropSnr) best = { frac, dropSnr: dsnr, psfAmpSnr: psf && psf.determined ? psf.ampSnr : -Infinity };
      }
      // final evaluation at the best phase, full bootstrap
      const t0 = rec.epochBjd + best.frac * rec.periodDays;
      const { psf, naive } = evalAtPhase(cube, t0, rec.periodDays, dur, boot);
      if (!psf || !psf.determined || !naive || !naive.determined) return null;
      const pv = judgePsfDiff(psf, GATE_ARCSEC, { minAmpSnr: MIN_AMP_SNR, minDeltaChi2: MIN_DELTA_CHI2 });
      const nv = judgeLocalization(naive, GATE_ARCSEC, { minSnr: 5 });
      return {
        rec, sector: s, phaseFrac: best.frac,
        psfOffset: psf.offsetArcsec, psfClassification: pv.classification, psfVeto: pv.classification === "off-target", psfAmpSnr: psf.ampSnr,
        naiveOffset: naive.offsetArcsec, naiveVeto: nv.classification === "off-target", naiveDropSnr: naive.dropSnr,
      };
    } catch { /* next sector */ }
  }
  return null;
}

async function main() {
  console.log(`P58 scaled + phase-refined true-veto 2x2 (gate=${GATE_ARCSEC}", phases=${PHASES}, boot=${boot}, tmag<=${tmagCap})`);
  const records = await fetchToiTable();
  if (records.length === 0) { console.log("public TOI table unavailable (network) -- cannot build labelled classes here."); return; }
  const negAll = labelledNegatives(records);
  const posAll = confirmedPositives(records);
  console.log(`public TOI table: ${records.length} rows; placeable negatives=${negAll.length}, positives=${posAll.length}`);
  const negPick = pickBrightest(negAll, wantNeg);
  const posPick = pickBrightest(posAll, wantPos);
  console.log(`brightest-first sample: ${negPick.length} negatives + ${posPick.length} positives\n`);

  const measured: Measured[] = [];
  let skippedNoCube = 0;
  for (const rec of [...negPick, ...posPick]) {
    const m = await measureOne(rec);
    if (!m) { skippedNoCube++; continue; }
    measured.push(m);
    const tag = rec.label === "blend-or-fp" ? "NEG" : "POS";
    console.log(`  [${tag}] ${rec.label.padEnd(12)} TIC ${rec.tic} s${m.sector} phase=${m.phaseFrac.toFixed(2)}: PSF ${m.psfOffset.toFixed(2)}" (ampSnr ${m.psfAmpSnr.toFixed(1)}) -> ${m.psfClassification}${m.psfVeto ? " (VETO)" : ""} | naive ${m.naiveOffset.toFixed(2)}" (dropSnr ${m.naiveDropSnr.toFixed(1)})${m.naiveVeto ? " (VETO)" : ""}`);
  }

  const measuredNeg = measured.filter((m) => m.rec.label === "blend-or-fp");
  const measuredPos = measured.filter((m) => m.rec.label === "known-planet");
  console.log(`\nusable labelled cases: ${measured.length} (${measuredNeg.length} negatives, ${measuredPos.length} positives); ${skippedNoCube} had no SPOC cube / no coherent transit`);
  if (measured.length === 0) { console.log("no measurable cases -- cannot run the acceptance test here."); return; }

  const psfCases: VetoCase[] = measured.map((m) => ({ id: `TIC ${m.rec.tic}`, isBlend: m.rec.label === "blend-or-fp", veto: m.psfVeto, score: m.psfOffset }));
  const naiveCases: VetoCase[] = measured.map((m) => ({ id: `TIC ${m.rec.tic}`, isBlend: m.rec.label === "blend-or-fp", veto: m.naiveVeto, score: m.naiveOffset }));
  const psfV = acceptVetoTool(psfCases, { targetPower: 0.5, maxFalseVetoes: 0 });
  const naiveV = acceptVetoTool(naiveCases, { targetPower: 0.5, maxFalseVetoes: 0 });

  const negOff = measuredNeg.map((m) => m.psfOffset).sort((a, b) => a - b);
  const posOff = measuredPos.map((m) => m.psfOffset).sort((a, b) => a - b);
  const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "n/a" : (v * 100).toFixed(0) + "%");
  const ci = (c: [number, number] | null) => (c ? `[${c[0].toFixed(2)}, ${c[1].toFixed(2)}]` : "");

  console.log(`\nPSF veto (phase-refined) -- true 2x2: ${JSON.stringify(psfV.metrics.cm)}`);
  console.log(`  veto power  = ${psfV.metrics.vetoPower == null ? "n/a" : psfV.metrics.vetoPower.toFixed(2)} ${ci(psfV.metrics.vetoPowerCI)}  (LOWER bound: on-target EBs are in the negative class)`);
  console.log(`  false-veto  = ${psfV.metrics.falseVetoRate == null ? "n/a" : psfV.metrics.falseVetoRate.toFixed(2)} ${ci(psfV.metrics.falseVetoCI)}  (exact -- a KP wrongly killed)`);
  console.log(`  ROC AUC     = ${psfV.auc == null ? "n/a" : psfV.auc.toFixed(3)} | naive AUC = ${naiveV.auc == null ? "n/a" : naiveV.auc.toFixed(3)}`);
  console.log(`  naive: power=${naiveV.metrics.vetoPower?.toFixed(2)} falseVeto=${naiveV.metrics.falseVetoRate?.toFixed(2)}`);
  console.log(`  blend PSF offsets p50=${q(negOff, 0.5).toFixed(2)}" max=${negOff[negOff.length - 1]?.toFixed(2) ?? "n/a"}" | planet p50=${q(posOff, 0.5).toFixed(2)}" max=${posOff[posOff.length - 1]?.toFixed(2) ?? "n/a"}"`);
  console.log(`\n  PSF VERDICT: safeToGate=${psfV.safeToGate} -- ${psfV.reason}`);

  const json = {
    meta: {
      generatedBy: "scripts/p58-veto-2x2-scaled.ts", gateArcsec: GATE_ARCSEC, phases: PHASES, boot, tmagCap,
      upgradesOverP57: "larger sample + transit-phase refinement (fold is modulo P, so we sweep one period and pick the strongest real dip, removing catalog-epoch mis-timing as a confound)",
      labelSource: "public ExoFOP TOI table (token-free); negatives FP/EB, positives KP",
      detector: "src/detect/psfDiffImaging.ts + diffImaging.ts", scorer: "src/candidate/vetoAcceptance.ts",
      caveat: "FP/EB labels mix off-target blends (catchable by localization) with on-target eclipsing binaries (not catchable); veto power is a LOWER bound.",
    },
    population: { tableRows: records.length, placeableNegatives: negAll.length, placeablePositives: posAll.length, sampledNeg: negPick.length, sampledPos: posPick.length, usable: measured.length, usableNeg: measuredNeg.length, usablePos: measuredPos.length, skippedNoCube },
    psf: { safeToGate: psfV.safeToGate, reason: psfV.reason, cm: psfV.metrics.cm, vetoPower: psfV.metrics.vetoPower, vetoPowerCI: psfV.metrics.vetoPowerCI, falseVetoRate: psfV.metrics.falseVetoRate, falseVetoCI: psfV.metrics.falseVetoCI, vetoPrecision: psfV.metrics.vetoPrecision, auc: psfV.auc },
    naive: { safeToGate: naiveV.safeToGate, reason: naiveV.reason, cm: naiveV.metrics.cm, vetoPower: naiveV.metrics.vetoPower, falseVetoRate: naiveV.metrics.falseVetoRate, auc: naiveV.auc },
    blendOffsetArcsec: { p50: q(negOff, 0.5), max: negOff[negOff.length - 1] ?? null },
    planetOffsetArcsec: { p50: q(posOff, 0.5), max: posOff[posOff.length - 1] ?? null },
    cases: measured.map((m) => ({ tic: m.rec.tic, toi: m.rec.toi, label: m.rec.label, tessMag: m.rec.tessMag, sector: m.sector, phaseFrac: +m.phaseFrac.toFixed(3), psfOffsetArcsec: +m.psfOffset.toFixed(3), psfAmpSnr: +m.psfAmpSnr.toFixed(1), psfClassification: m.psfClassification, naiveOffsetArcsec: +m.naiveOffset.toFixed(3), naiveDropSnr: +m.naiveDropSnr.toFixed(1) })),
    discoveryClaim: false,
    safeToGate: psfV.safeToGate,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p58-veto-2x2.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P58 a larger, phase-refined true-veto 2x2 (priority-0 scale-up)",
    "",
    `Reproduce: \`npm run p58:veto-2x2 -- --neg ${wantNeg} --pos ${wantPos} --tmag ${tmagCap} --boot ${boot} --phases ${PHASES}\``,
    "Same token-free ExoFOP labels as P57 (KP = keep, FP/EB = veto), but with more cases and a",
    "transit-phase refinement: the fold is modulo the period, so we sweep one full period and localize",
    "at the phase of the strongest real dip. This removes catalog-epoch mis-timing -- the likely cause",
    "of P57's single false kill -- as a confound.",
    "",
    `**Usable labelled cases: ${measured.length}** (${measuredNeg.length} negatives, ${measuredPos.length} positives) out of ${negPick.length + posPick.length} sampled; ${skippedNoCube} had no SPOC cube or no coherent transit.`,
    "",
    "## PSF double-difference -- true 2x2 (phase-refined)",
    "",
    "| | labelled blend (should veto) | labelled planet (must keep) |",
    "|---|---|---|",
    `| veto fired | ${psfV.metrics.cm.trueVeto} | ${psfV.metrics.cm.falseVeto} |`,
    `| kept | ${psfV.metrics.cm.missedBlend} | ${psfV.metrics.cm.trueKeep} |`,
    "",
    `- veto power (blends caught): **${pct(psfV.metrics.vetoPower)}** ${ci(psfV.metrics.vetoPowerCI)} -- a LOWER bound`,
    `- false-veto rate (planets killed): **${pct(psfV.metrics.falseVetoRate)}** ${ci(psfV.metrics.falseVetoCI)} -- exact`,
    `- ROC AUC: PSF ${psfV.auc == null ? "n/a" : psfV.auc.toFixed(3)} vs naive ${naiveV.auc == null ? "n/a" : naiveV.auc.toFixed(3)}; naive false-veto rate ${pct(naiveV.metrics.falseVetoRate)}`,
    "",
    `**VERDICT: safeToGate = ${psfV.safeToGate}.** ${psfV.reason}`,
    "",
    "## Honest reading",
    "",
    "Even with the timing confound removed, the FP/EB negative class still contains on-target eclipsing",
    "binaries that a localization veto legitimately cannot reject, so the catch-rate is a lower bound, not",
    "the tool's sensitivity. The disqualifying number is the false-veto rate: any known planet the refined",
    "PSF still kills is a genuine localization failure, and one is enough to keep the gate closed. Nothing",
    "here is wired into the critic / money path; no candidate is cleared; discoveryClaim false.",
    "",
  ].join("\n");
  writeFileSync("reports/p58-veto-2x2.md", md);
  console.log("\nwrote reports/p58-veto-2x2.md and reports/p58-veto-2x2.json");
}

main().catch((e) => { console.error("p58 failed:", e instanceof Error ? e.message : e); process.exitCode = 1; });
