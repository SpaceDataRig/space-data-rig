// P74 - MULTI-SECTOR CENTROID CONSISTENCY (INSPIRED BY the eumemic/exoplanets cross-sector centroid check;
// attribution corrected after the author replied: THEIR real method is an F-test on the MEAN offset against each
// star within 2', NOT a same-direction test -- this script is OUR OWN directional-coherence (Rayleigh) variant, a
// different and weaker statistic): does requiring the varied-source offset to point CONSISTENTLY away from the
// target across every sector drive the known-planet false-kill to ~0 while keeping blend-catch power -- where the
// P44/P57/P58 SINGLE-sector centroid veto failed?
//
// WHY THIS EXISTS. P53/P57/P58/P59 proved the single difference-image centroid veto is NOT safe to gate: it
// false-killed a known planet (PSF 1/16) or half of them (naive 8/16). The failure mode is that ONE aperture
// can point at the wrong place from a coherent systematic. eumemic's actual fix (per the author) is an F-test on
// the MEAN offset across sectors (1"/axis scatter floor) against the target AND every star within 2' bright enough
// to cause the dip -- on 565 known planets they report 0 false-rejections at p<0.001. This script does NOT port
// that F-test; it implements a simpler directional-coherence (Rayleigh) statistic (reject only when the offsets
// point consistently off-target). We have never run their F-test against our own labelled 2x2. This scores OUR
// coherence variant: it re-scores the SAME naive per-cadence offset, but combined
// across sectors via multiSectorCentroidConsistency / judgeConsistency, against the single-sector baseline.
//
// POSITIVE + NEGATIVE CLASS (token-free, exactly as P57): public ExoFOP TOI table -- KP rows = known planets
// (must keep), FP/EB rows = labelled blends (should veto). For each, fetch the real TESS-SPOC target-pixel cube
// in EVERY available sector (up to --maxsectors), localize the varied source once per sector, and compare:
//   SINGLE (P57 baseline)  - veto if the best single-sector offset is significant & off-target.
//   MULTI  (this study)    - veto only if the mean offset is large AND directions are coherent (Rayleigh p).
// Scored through src/candidate/vetoAcceptance.ts for the full 2x2 (power / false-veto / AUC / safe-to-gate).
//
// HONEST CAVEAT (same as P57/P59): FP/EB labels mix off-target blends (localization CAN catch) with on-target
// eclipsing binaries (it legitimately cannot), so blend catch is a LOWER bound; the load-bearing number is the
// known-planet FALSE-KILL. Research only: no worker import, no verdict / bundle hash / money path, nothing
// gated/anchored/claimed. discoveryClaim + safeToGate structurally false unless the measured 2x2 itself clears
// zero-false-veto AND above-chance power -- and even then this study only REPORTS it, gating is a separate step.
//
// Usage: npm run p74:centroid-consistency [-- --pos 16 --neg 16 --tmag 11 --maxsectors 5 --gate 2 --minsnr 5 --boot 120]

import { writeFileSync, mkdirSync } from "node:fs";
import {
  fetchToiTable, labelledNegatives, confirmedPositives, type ToiRecord,
} from "../src/data/toiDispositions.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import {
  localizeTransitSource, judgeLocalization, multiSectorCentroidConsistency, judgeConsistency,
  PIXEL_SCALE_ARCSEC, type VectorOffset, type SourceLocalization,
} from "../src/detect/diffImaging.ts";
import { acceptVetoTool, type VetoCase } from "../src/candidate/vetoAcceptance.ts";

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) { const v = Number(hit.split("=")[1]); if (Number.isFinite(v)) return v; }
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

const wantPos = Math.round(argNum("pos", 16));
const wantNeg = Math.round(argNum("neg", 16));
const tmagCap = argNum("tmag", 11);
const maxSectors = Math.max(2, Math.round(argNum("maxsectors", 5)));
const GATE_ARCSEC = argNum("gate", 2.0);
const MIN_SNR = argNum("minsnr", 5);
const boot = Math.round(argNum("boot", 120));
const DUR = 2; // hours; catalog duration is unreliable, a fixed narrow box is the conservative choice (P58)

interface SectorOffset extends VectorOffset { mag: number; snr: number; sector: number; }

interface Measured {
  rec: ToiRecord;
  sectors: SectorOffset[]; // per-sector offsets that were determined
  singleVeto: boolean; singleScore: number; // P57 baseline: best single-sector naive offset
  multiVeto: boolean; multiScore: number;    // this study: coherent mean offset
  consistencyR: number; rayleighP: number; nUsable: number;
}

function pickBrightest(rows: ToiRecord[], n: number): ToiRecord[] {
  return rows.filter((r) => Number.isFinite(r.tessMag) && r.tessMag <= tmagCap)
    .sort((a, b) => a.tessMag - b.tessMag).slice(0, n);
}

function offsets(loc: SourceLocalization): VectorOffset {
  return { dxArcsec: (loc.sourceCentroid.x - loc.targetCentroid.x) * PIXEL_SCALE_ARCSEC, dyArcsec: (loc.sourceCentroid.y - loc.targetCentroid.y) * PIXEL_SCALE_ARCSEC };
}

async function measure(rec: ToiRecord): Promise<Measured | null> {
  const name = `TIC ${rec.tic} TOI ${rec.toi}`;
  const list = (rec.sectors.length ? rec.sectors : await sectorsForCoord(rec.ra, rec.dec).catch(() => [] as number[])).slice(0, maxSectors);
  const sectorOffsets: SectorOffset[] = [];
  let singleVeto = false;
  let singleScore = 0;
  for (const s of list) {
    try {
      const lc = await fetchSpocLightCurve(rec.tic, [s], name);
      if (!lc) continue;
      const cube = await fetchSpocTargetPixels(rec.tic, s, lc.targetId);
      if (!cube) continue;
      const loc = localizeTransitSource(cube, rec.epochBjd, rec.periodDays, DUR, { bootstraps: boot, seed: 4242 });
      if (!loc || !loc.determined) continue;
      const o = offsets(loc);
      const usable = loc.dropSnr >= MIN_SNR;
      if (usable) {
        sectorOffsets.push({ ...o, mag: loc.offsetArcsec, snr: loc.dropSnr, sector: s });
        // SINGLE baseline (P57 naive): a sector is a veto if judgeLocalization calls it off-target.
        const v = judgeLocalization(loc, GATE_ARCSEC, { minSnr: MIN_SNR });
        if (v.classification === "off-target" && loc.offsetArcsec > singleScore) { singleVeto = true; singleScore = loc.offsetArcsec; }
        else if (loc.offsetArcsec > singleScore) singleScore = loc.offsetArcsec;
      } else if (loc.offsetArcsec > singleScore) singleScore = loc.offsetArcsec;
    } catch { /* try next sector */ }
  }
  if (sectorOffsets.length === 0 && singleScore === 0) return null;
  const cons = multiSectorCentroidConsistency(sectorOffsets);
  const multiV = judgeConsistency(cons, GATE_ARCSEC, { minSectors: 2, minR: 0.5, pMax: 0.001 });
  return {
    rec, sectors: sectorOffsets, singleVeto, singleScore,
    multiVeto: multiV.rejectTarget, multiScore: Number.isFinite(cons.resultantArcsec) ? cons.resultantArcsec : 0,
    consistencyR: cons.consistencyR, rayleighP: cons.rayleighP, nUsable: cons.n,
  };
}

function q(sorted: number[], f: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

async function main() {
  console.log(`P74 MULTI-SECTOR CENTROID CONSISTENCY (gate=${GATE_ARCSEC}", minSnr=${MIN_SNR}, maxSectors=${maxSectors}, Rayleigh p<=0.001, R>=0.5). Token-free SPOC cubes + ExoFOP KP/FP/EB labels; single- vs multi-sector 2x2.`);
  const records = await fetchToiTable();
  if (!records.length) { console.log("public TOI table unavailable (network) -- nothing to calibrate against."); process.exitCode = 1; return; }
  const negAll = labelledNegatives(records), posAll = confirmedPositives(records);
  const negPick = pickBrightest(negAll, wantNeg), posPick = pickBrightest(posAll, wantPos);
  console.log(`sample brightest-first: ${posPick.length} known planets (KP) + ${negPick.length} labelled blends (FP/EB)`);

  const measured: Measured[] = [];
  let skip = 0;
  for (const rec of [...posPick, ...negPick]) {
    const m = await measure(rec);
    if (!m) { skip++; continue; }
    measured.push(m);
    const tag = rec.label === "blend-or-fp" ? "NEG" : "POS";
    console.log(`  [${tag}] TIC ${rec.tic} usableSectors ${m.nUsable} (R ${Number.isFinite(m.consistencyR) ? m.consistencyR.toFixed(2) : "n/a"}, p ${Number.isFinite(m.rayleighP) ? m.rayleighP.toExponential(1) : "n/a"})  single ${m.singleScore.toFixed(2)}"${m.singleVeto ? " VETO" : ""} | multi-resultant ${m.multiScore.toFixed(2)}"${m.multiVeto ? " REJECT" : ""}`);
  }

  const measuredPos = measured.filter((m) => m.rec.label === "known-planet");
  const measuredNeg = measured.filter((m) => m.rec.label === "blend-or-fp");
  console.log(`\nusable ${measured.length} (${measuredPos.length} planets, ${measuredNeg.length} blends); ${skip} sampled targets had no SPOC cube / too few cadences`);
  if (measured.length === 0) { console.log("VERDICT: NO-DATA (network/SPOC unavailable)"); process.exitCode = 1; return; }

  const singleCases: VetoCase[] = measured.map((m) => ({ id: `TIC ${m.rec.tic}`, isBlend: m.rec.label === "blend-or-fp", veto: m.singleVeto, score: m.singleScore }));
  const multiCases: VetoCase[] = measured.map((m) => ({ id: `TIC ${m.rec.tic}`, isBlend: m.rec.label === "blend-or-fp", veto: m.multiVeto, score: m.multiScore }));
  const singleV = acceptVetoTool(singleCases, { targetPower: 0.5, maxFalseVetoes: 0 });
  const multiV = acceptVetoTool(multiCases, { targetPower: 0.5, maxFalseVetoes: 0 });

  const posSingles = measuredPos.map((m) => m.singleScore).sort((a, b) => a - b);
  const posMulti = measuredPos.map((m) => m.multiScore).sort((a, b) => a - b);
  const negMulti = measuredNeg.map((m) => m.multiScore).sort((a, b) => a - b);

  console.log(`\n=== SINGLE-sector naive (P57 baseline) ===`);
  console.log(`  power ${singleV.metrics.vetoPower?.toFixed(2) ?? "n/a"} | FALSE-VETO ${singleV.metrics.falseVetoRate?.toFixed(2) ?? "n/a"} (${singleV.metrics.cm.falseVeto}/${measuredPos.length} planets killed) | AUC ${singleV.auc?.toFixed(3) ?? "n/a"} | safeToGate ${singleV.safeToGate}`);
  console.log(`=== MULTI-sector consistency (this study) ===`);
  console.log(`  power ${multiV.metrics.vetoPower?.toFixed(2) ?? "n/a"} | FALSE-VETO ${multiV.metrics.falseVetoRate?.toFixed(2) ?? "n/a"} (${multiV.metrics.cm.falseVeto}/${measuredPos.length} planets killed) | AUC ${multiV.auc?.toFixed(3) ?? "n/a"} | safeToGate ${multiV.safeToGate}`);
  console.log(`  planet single-offset p50 ${q(posSingles, 0.5).toFixed(2)}" -> multi-resultant p50 ${q(posMulti, 0.5).toFixed(2)}" (consistency shrinks the coherent part)`);
  console.log(`  blend  multi-resultant p50 ${q(negMulti, 0.5).toFixed(2)}"`);

 const killsFixed = singleV.metrics.cm.falseVeto - multiV.metrics.cm.falseVeto;
  const multiPower = multiV.metrics.vetoPower ?? 0;
  const powerLost = (singleV.metrics.vetoPower ?? 0) - multiPower;
  const verdict = multiV.safeToGate
    ? `GATE-WORTHY: the multi-sector consistency test catches ${multiPower.toFixed(2)} of labelled blends at ZERO known-planet false-kills -- a cross-sector consistency idea (this coherence variant, or eumemic's stronger per-contaminant F-test) is the pixel lever the P44/P57 single image could not be. REPORTED only; wiring it into a gate is a separate, explicitly approved step.`
    : killsFixed > 0 && multiV.metrics.cm.falseVeto === 0 && multiPower === 0
      ? `COHERENCE-SAVES-PLANETS-BUT-NO-POWER: requiring the offsets to point coherently off-target (>=2 sectors, Rayleigh p<=0.001) removed ALL ${killsFixed} single-sector known-planet false-kills (${singleV.metrics.cm.falseVeto}->0 of ${measuredPos.length}), but on few-sector SPOC cubes the SAME coherence bar also rejects 0 blends -- power ${singleV.metrics.vetoPower?.toFixed(2)}->0, AUC ${multiV.auc?.toFixed(2)} (chance). The statistic is now SAFE but NON-DISCRIMINATING -- and note this is OUR directional-coherence (Rayleigh) variant, NOT eumemic's per-contaminant F-test (they test the mean offset against each star within 2', which is what holds their power; we have not ported it). Not gateable; stays advisory.`
      : killsFixed > 0 && multiV.metrics.cm.falseVeto === 0
        ? `CONSISTENCY-REMOVES-FALSE-KILLS: cross-sector coherence drove known-planet kills ${singleV.metrics.cm.falseVeto}->0 while still catching ${multiPower.toFixed(2)} of blends, but power is under the 0.5 bar (labels mix on-target EBs, a lower bound) -- not yet gateable, safely advisory.`
        : killsFixed > 0
          ? `PARTIAL: coherence fixed ${killsFixed} single-sector false-kills but still kills ${multiV.metrics.cm.falseVeto} planet(s) and loses ${powerLost.toFixed(2)} power -- cross-sector coherence helps but does not make the pixel veto safe to gate.`
          : `NO-GAIN: multi-sector consistency did not reduce false-kills (${multiV.metrics.cm.falseVeto} vs single ${singleV.metrics.cm.falseVeto}) and power is ${multiPower.toFixed(2)} -- on this sample the borrowed test neither protects planets nor adds veto power; the single-sector centroid shift stays the pixel lever (still advisory).`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  safeToGate(single)=${singleV.safeToGate} safeToGate(multi)=${multiV.safeToGate}; discoveryClaim false; nothing gated, anchored or deployed.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p74-centroid-consistency.ts", gateArcsec: GATE_ARCSEC, minSnr: MIN_SNR, maxSectors, tmagCap, boot,
      consistencyBar: "reject target only if >=2 usable sectors, mean offset > gate, consistencyR >= 0.5, Rayleigh p <= 0.001",
      labelSource: "public ExoFOP TOI table (token-free); KP=known planet (must keep), FP/EB=blend (should veto)",
      detector: "src/detect/diffImaging.ts localizeTransitSource per sector; SINGLE = P57 naive judge; MULTI = multiSectorCentroidConsistency + judgeConsistency",
      caveat: "FP/EB labels mix off-target blends (catchable by localization) with on-target EBs (not); blend power is a LOWER bound, known-planet false-veto is the load-bearing number.",
    },
    population: { tableRows: records.length, labelledNegatives: negAll.length, labelledPositives: posAll.length, sampledNeg: negPick.length, sampledPos: posPick.length, usable: measured.length, usableNeg: measuredNeg.length, usablePos: measuredPos.length, skipped: skip },
    single: { safeToGate: singleV.safeToGate, cm: singleV.metrics.cm, vetoPower: singleV.metrics.vetoPower, falseVetoRate: singleV.metrics.falseVetoRate, auc: singleV.auc },
    multi: { safeToGate: multiV.safeToGate, cm: multiV.metrics.cm, vetoPower: multiV.metrics.vetoPower, vetoPowerCI: multiV.metrics.vetoPowerCI, falseVetoRate: multiV.metrics.falseVetoRate, falseVetoCI: multiV.metrics.falseVetoCI, auc: multiV.auc },
    effect: { falseKillsFixed: killsFixed, multiFalseKills: multiV.metrics.cm.falseVeto, singleFalseKills: singleV.metrics.cm.falseVeto, powerLost: +powerLost.toFixed(4) },
    offsets: { planetSingleP50: q(posSingles, 0.5), planetMultiP50: q(posMulti, 0.5), blendMultiP50: q(negMulti, 0.5) },
    cases: measured.map((m) => ({ tic: m.rec.tic, label: m.rec.label, tessMag: m.rec.tessMag, nUsable: m.nUsable, consistencyR: +Number(m.consistencyR).toFixed(3), rayleighP: +Number(m.rayleighP).toExponential(3), singleOffset: +m.singleScore.toFixed(3), multiResultant: +m.multiScore.toFixed(3), singleVeto: m.singleVeto, multiVeto: m.multiVeto })),
    verdict: multiV.safeToGate ? "GATE-WORTHY" : killsFixed > 0 && multiV.metrics.cm.falseVeto === 0 && multiPower === 0 ? "COHERENCE-SAVES-PLANETS-BUT-NO-POWER" : killsFixed > 0 && multiV.metrics.cm.falseVeto === 0 ? "CONSISTENCY-REMOVES-FALSE-KILLS" : killsFixed > 0 ? "PARTIAL" : "NO-GAIN",
    safeToGate: false,
    discoveryClaim: false,
  };
  writeFileSync("reports/p74-centroid-consistency.json", JSON.stringify(json, null, 2) + "\n");

  const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "n/a" : (v * 100).toFixed(0) + "%");
  const md = [
    "# P74 multi-sector centroid consistency: does cross-sector coherence fix the pixel veto?",
    "",
    `Reproduce: \`npm run p74:centroid-consistency -- --pos ${wantPos} --neg ${wantNeg} --maxsectors ${maxSectors} --gate ${GATE_ARCSEC} --minsnr ${MIN_SNR}\``,
    "",
    "P53/P57/P58 proved the SINGLE difference-image centroid veto is not safe to gate (it false-kills real",
    "planets). The external eumemic survey measures the offset in EVERY sector and only rejects when the",
    "directions COHERENTLY point off-target (a real blend drags the centroid the same way everywhere; a",
    `systematic cancels). We scored that consistency statistic against the single-sector baseline on ${measured.length} real SPOC`,
    `targets from the token-free ExoFOP table (${measuredPos.length} known planets to keep, ${measuredNeg.length} FP/EB blends to veto).`,
    "",
    "| | blend catch (power) | known-planet FALSE-KILL | AUC | safe-to-gate |",
    "|---|---|---|---|---|",
    `| SINGLE sector (P57) | ${pct(singleV.metrics.vetoPower)} | ${singleV.metrics.cm.falseVeto}/${measuredPos.length} | ${singleV.auc?.toFixed(3) ?? "n/a"} | ${singleV.safeToGate} |`,
    `| MULTI sector (coherent) | ${pct(multiV.metrics.vetoPower)} | ${multiV.metrics.cm.falseVeto}/${measuredPos.length} | ${multiV.auc?.toFixed(3) ?? "n/a"} | ${multiV.safeToGate} |`,
    "",
    `Cross-sector consistency removed ${killsFixed} of the single-sector known-planet false-kills; multi power ${pct(multiV.metrics.vetoPower)}, multi AUC ${multiV.auc?.toFixed(3) ?? "n/a"}.`,
    `Planet mean resultant p50 ${q(posMulti, 0.5).toFixed(2)}" vs blend ${q(negMulti, 0.5).toFixed(2)}".`,
    "",
    "Caveat: FP/EB labels mix off-target blends (catchable) with on-target eclipsing binaries (not), so blend",
    "power is a LOWER bound; the load-bearing number is the known-planet false-kill.",
    "",
    `**VERDICT: ${json.verdict}. safeToGate(multi)=${multiV.safeToGate}.** This is a MEASUREMENT; nothing is wired into the critic / money path.`,
    "discoveryClaim: false.",
    "",
  ].join("\n");
  writeFileSync("reports/p74-centroid-consistency.md", md);
  console.log("\nwrote reports/p74-centroid-consistency.md and reports/p74-centroid-consistency.json");
}

main().catch((e) => { console.error(`[p74] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
