// P92 - SCRAMBLED FALSE-ALARM NULL + joint completeness/reliability threshold optimisation (authority roadmap, priority 3).
//
// WHAT THIS MEASURES. The field's 2025 consensus vetter, LEO-Vetter (Kunimoto et al. 2025, ApJ), tunes its flux-level
// thresholds by minimising sqrt((1-C)^2 + (1-R_FA)^2), where C is completeness on INJECTED planets and R_FA is
// reliability against FALSE ALARMS drawn from a time-SCRAMBLED population, and it reports that scrambling is the honest
// false-alarm surrogate because light-curve INVERSION is not: scattered-light ramps at the start of each TESS orbit are
// asymmetric under reflection, and M-dwarf flares invert into absorption dips. This repo already has the inversion null
// (src/detect/invertedNull.ts) and a per-candidate phase-scrambling FAP (src/detect/fap.ts), but neither is a
// candidate-level false-alarm POPULATION scored jointly with completeness. This study builds exactly that, on real
// TESS-SPOC photometry, and puts scrambled and inverted false alarms side by side.
//
// METHOD (all through src/detect/falseAlarmNull.ts, deterministic, seeds fixed):
//   * Fetch N bright confirmed-planet hosts' real single/multi-sector SPOC curves (token-free public S3).
//   * INJECT arm: multiply a batman-free box transit at P=3 d across a depth grid onto each real curve, run the same
//     BLS detector, record every detection as an injected TCE with its truth period -> completeness denominator.
//   * SCRAMBLE arm: scrambleFlux each real curve (shuffle and block modes), run the detector, collect survivors -> the
//     false-alarm population -> reliability denominator.
//   * INVERT arm: invertCurve each real curve, run the detector keeping only positive dips -> an ALTERNATIVE false-alarm
//     population, measured under the same gate for a like-for-like scramble-vs-invert comparison.
//   * Sweep the BLS-SNR gate, compute C / R_FA / the joint objective per threshold, pick the optimum, and report how
//     many scrambled vs inverted false alarms clear it.
//
// Research only: no worker import, no verdict, no bundle hash, no money path; this MEASURES a candidate-level null and
// proposes a threshold from data -- it wires nothing in. discoveryClaim structurally false.
//
// Run: npm run p92:scrambled-fa [-- --targets 12 --perCurve 3 --maxsectors 2 --seed 7 --depths 500,1000,2000,4000]

import { preprocess } from "../src/detect/detrend.ts";
import { invertCurve } from "../src/detect/invertedNull.ts";
import { bls } from "../src/detect/bls.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import {
  scrambleFlux,
  type Tce,
  sweepThresholds,
  optimizeThreshold,
} from "../src/detect/falseAlarmNull.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const wantTargets = Math.max(4, parseInt(arg("targets", "12"), 10));
const perCurve = Math.max(1, parseInt(arg("perCurve", "3"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "2"), 10));
const seed = parseInt(arg("seed", "7"), 10);
const injPeriod = Number(arg("period", "3"));
const depthsPpm = arg("depths", "300,500,1000,2000,4000").split(",").map((s) => parseInt(s, 10)).filter((v) => Number.isFinite(v) && v > 0);
const GRID = { minPeriodDays: 1.5, maxPeriodDays: 13, oversample: 8 };
// A blind BLS look-elsewhere on these real curves drives spurious peaks well past SNR 12 (measured: scrambled null
// median SNR ~13), so the sweep must span up to ~40 for completeness to show a real knee rather than saturate.
const THRESHOLDS = [5, 8, 10, 12, 15, 18, 22, 26, 30, 35, 40];

/** Argmax detector over the full grid: the statistic a blind search would report -- used for the false-alarm
 *  nulls (scrambled / inverted), where we want the strongest SPURIOUS peak the noise can masquerade as. */
function detectPeak(lc: LightCurve): { periodDays: number; stat: number } | null {
  try {
    const b = bls(lc, GRID);
    if (Number.isFinite(b.snr) && Number.isFinite(b.periodDays) && b.snr > 0) return { periodDays: b.periodDays, stat: b.snr };
    return null;
  } catch {
    return null;
  }
}

/**
 * Recovery detector AT a known ephemeris: a narrow BLS grid centred on `period`, so the statistic is the SNR of a
 * signal at exactly the injected period. This is the standard injection-recovery completeness measure and is
 * deliberately immune to the host-planet contamination that biases an argmax-only detector (a confirmed host's own
 * planet otherwise steals the single strongest peak and reads as a missed injection at every threshold).
 */
function detectAtPeriod(lc: LightCurve, period: number): number {
  try {
    const b = bls(lc, { minPeriodDays: period * 0.97, maxPeriodDays: period * 1.03, oversample: GRID.oversample });
    return Number.isFinite(b.snr) && b.snr > 0 ? b.snr : 0;
  } catch {
    return 0;
  }
}

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let a = 0; a < 3; a++) { try { const lc = await fetchSpocLightCurve(tic, [sector], name); if (lc) return lc; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 400 * (a + 1))); }
  return null;
}
async function fetchStitched(tic: number, sectors: number[], name: string): Promise<LightCurve | null> {
  const parts: LightCurve[] = [];
  for (const s of sectors.slice(0, maxSectors)) {
    const lc = await fetchSectorCurve(tic, s, name);
    if (lc && lc.points.length >= 60) parts.push(lc);
  }
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0] ?? null;
  return stitchLightCurves(parts) ?? parts[0] ?? null;
}

async function main(): Promise<void> {
  console.log(`P92 SCRAMBLED FALSE-ALARM NULL + joint C/R optimisation. targets=${wantTargets}, perCurve=${perCurve}, maxsectors=${maxSectors}, seed=${seed}, injectP=${injPeriod}d, depths=[${depthsPpm}]ppm, thresholds=[${THRESHOLDS}]. Token-free real SPOC; discoveryClaim false.`);

  const planets = (await fetchConfirmedPlanets({ maxTmag: 12, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.tic != null && p.ra != null && p.dec != null && p.pl_orbper != null);
  const seen = new Set<string>();
  const hosts: { name: string; tic: number; ra: number; dec: number }[] = [];
  for (const p of planets) {
    const h = p.hostname || `TIC ${p.tic}`;
    if (seen.has(h)) continue; seen.add(h);
    if (!(p.pl_orbper! >= 1 && p.pl_orbper! <= 13)) continue;
    hosts.push({ name: p.pl_name ?? h, tic: p.tic!, ra: p.ra!, dec: p.dec! });
    if (hosts.length >= wantTargets * 4) break;
  }

  const curves: LightCurve[] = [];
  for (const hst of hosts) {
    if (curves.length >= wantTargets) break;
    let sectors: number[]; try { sectors = await sectorsForCoord(hst.ra, hst.dec); } catch { continue; }
    if (!sectors.length) continue;
    const lc = await fetchStitched(hst.tic, sectors, hst.name);
    if (!lc || lc.points.length < 150) continue;
    curves.push(preprocess(lc, 0.5));
  }
  if (curves.length < 4) { console.log(`only ${curves.length} usable curves. VERDICT: INSUFFICIENT-DATA`); return; }
  console.log(`  ${curves.length} real curves fetched.`);

  // ---- INJECT arm: completeness denominator (one injected TCE per curve x depth). ----
  const injected: Tce[] = [];
  for (let c = 0; c < curves.length; c++) {
    const curve = curves[c]!;
    for (const d of depthsPpm) {
      const withTransit = injectTransitInto(curve, { seed: seed * 1000 + c * 97 + d, periodDays: injPeriod, depthFrac: d * 1e-6 });
      // Measure recovery at the injected ephemeris (not the argmax) -> C varies with depth and is host-contamination-free.
      const stat = detectAtPeriod(withTransit, injPeriod);
      injected.push({ targetId: `${curve.targetId}#inj${d}`, periodDays: injPeriod, stat, injected: true, truthPeriodDays: injPeriod });
    }
  }

  // ---- SCRAMBLE arm: the false-alarm population (shuffle + block). ----
  const scrambled: Tce[] = [];
  for (const mode of ["shuffle", "block"] as const) {
    for (let c = 0; c < curves.length; c++) {
      const curve = curves[c]!;
      for (let k = 0; k < perCurve; k++) {
        const hit = detectPeak(scrambleFlux(curve, { seed: seed + c * 1000 + k * 13 + (mode === "block" ? 500000 : 0), mode }));
        if (hit) scrambled.push({ targetId: `${curve.targetId}#scr-${mode}-${k}`, periodDays: hit.periodDays, stat: hit.stat, injected: false });
      }
    }
  }

  // ---- INVERT arm: the ALTERNATIVE false-alarm population, positive dips only (LEO-Vetter's caveat on inversion). ----
  const inverted: Tce[] = [];
  for (let c = 0; c < curves.length; c++) {
    const hit = detectPeak(invertCurve(curves[c]!));
    if (hit) inverted.push({ targetId: `${curves[c]!.targetId}#inv`, periodDays: hit.periodDays, stat: hit.stat, injected: false });
  }

  // ---- Joint sweep on the combined (injected + scrambled) pool. ----
  const pool = [...injected, ...scrambled];
  const rows = sweepThresholds(pool, THRESHOLDS);
  const best = optimizeThreshold(rows);
  const thr = best?.threshold ?? 7;

  const meanSnr = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const survScram = scrambled.filter((t) => t.stat >= thr).length;
  const survInv = inverted.filter((t) => t.stat >= thr).length;
  const scramMed = scrambled.map((t) => t.stat).sort((a, b) => a - b)[Math.floor(scrambled.length / 2)] ?? NaN;
  const invMed = inverted.map((t) => t.stat).sort((a, b) => a - b)[Math.floor(inverted.length / 2)] ?? NaN;

  console.log(`\n=== P92 SUMMARY (${curves.length} curves; ${injected.length} injections, ${scrambled.length} scrambled TCEs, ${inverted.length} inverted TCEs) ===`);
  console.log("  threshold | completeness C | reliability R_FA | joint objective");
  for (const r of rows) console.log(`      SNR>=${String(r.threshold).padStart(2)}   |   ${r.c == null ? "n/a" : (100 * r.c).toFixed(1) + "%"}         |   ${r.rFa == null ? "n/a" : (100 * r.rFa).toFixed(1) + "%"}      |   ${r.objective == null ? "n/a" : r.objective.toFixed(3)}`);
  console.log(`  optimum: SNR>=${thr} (C=${best?.c == null ? "n/a" : (100 * best.c).toFixed(1)}%, R_FA=${best?.rFa == null ? "n/a" : (100 * best.rFa).toFixed(1)}%, objective=${best?.objective?.toFixed(3)})`);
  console.log(`  false alarms clearing SNR>=${thr}: scrambled ${survScram}/${scrambled.length} (median snr ${scramMed.toFixed(1)}), inverted ${survInv}/${inverted.length} (median snr ${invMed.toFixed(1)}).`);

  const hasOpt = best != null && best.c != null && best.rFa != null;
  const scramRate = scrambled.length ? survScram / scrambled.length : NaN;
  const invRate = inverted.length ? survInv / inverted.length : NaN;
  const verdict = hasOpt
    ? `C/R-OPTIMISED: the joint objective sqrt((1-C)^2+(1-R_FA)^2) is minimised at SNR>=${thr} giving C=${(100 * (best!.c ?? 0)).toFixed(1)}%, R_FA=${(100 * (best!.rFa ?? 0)).toFixed(1)}% on ${curves.length} real curves; the scrambled false-alarm null puts ${survScram}/${scrambled.length} (${(100 * scramRate).toFixed(1)}%) peaks past that gate, the inverted null ${survInv}/${inverted.length} (${Number.isFinite(invRate) ? (100 * invRate).toFixed(1) : "n/a"}%). Measures a candidate-level null and reads a threshold off it; wires nothing, claims nothing.`
    : `INSUFFICIENT-POPULATION: ${injected.length} injections / ${scrambled.length} scrambled TCEs did not support a joint C/R sweep (need both injected recoveries and scrambled survivors above the lowest threshold). VERDICT: NEEDS-MORE-CURVES.`;
  console.log(`\nVERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["src/detect/falseAlarmNull.ts", "src/detect/invertedNull.ts", "src/data/mastS3.ts", "scripts/p92-scrambled-fa.ts"]),
      generatedBy: "scripts/p92-scrambled-fa.ts", nCurves: curves.length, perCurve, maxSectors, seed,
      injectPeriodDays: injPeriod, depthsPpm, thresholds: THRESHOLDS, blsGrid: GRID,
      data: "real TESS-SPOC PDCSAP light curves (token-free public S3); injected transits for completeness, time-scrambled and inverted curves for the false-alarm nulls",
      note: "LEO-Vetter-style candidate-level null: completeness C on injected planets, reliability against false alarms R_FA on the scrambled population, joint objective sqrt((1-C)^2+(1-R_FA)^2) minimised over the BLS-SNR gate; scrambled vs inverted false-alarm survivors reported side by side (LEO-Vetter found inversion the weaker null: scattered-light ramps are asymmetric under reflection). Measures only; wires nothing; discoveryClaim false.",
    },
    summary: {
      optimumThresholdSnr: thr, completenessC: best?.c ?? null, reliabilityRFA: best?.rFa ?? null, jointObjective: best?.objective ?? null,
      nInjections: injected.length, nScrambled: scrambled.length, nInverted: inverted.length,
      scrambledSurvivorsAtOpt: survScram, invertedSurvivorsAtOpt: survInv,
      scrambledSurvivalRate: Number.isFinite(scramRate) ? scramRate : null, invertedSurvivalRate: Number.isFinite(invRate) ? invRate : null,
      scrambledMedianSnr: Number.isFinite(scramMed) ? scramMed : null, invertedMedianSnr: Number.isFinite(invMed) ? invMed : null,
      meanScrambledSnr: meanSnr(scrambled.map((t) => t.stat)), meanInvertedSnr: meanSnr(inverted.map((t) => t.stat)),
    },
    sweep: rows,
    verdict: hasOpt ? "C/R-OPTIMISED" : "NEEDS-MORE-CURVES",
    safeToGate: false, discoveryClaim: false,
  };
  writeFileSync("reports/p92-scrambled-fa.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P92 scrambled false-alarm null and a data-driven completeness/reliability gate",
    "",
    `Reproduce: \`npm run p92:scrambled-fa -- --targets ${wantTargets} --perCurve ${perCurve} --maxsectors ${maxSectors} --seed ${seed}\``,
    "",
    "LEO-Vetter (Kunimoto et al. 2025, ApJ) tunes its flux-level vetting by minimising sqrt((1-C)^2 + (1-R_FA)^2),",
    "completeness on injected planets and reliability against false alarms drawn from a time-SCRAMBLED population --",
    "and it shows scrambling is the honest false-alarm surrogate where INVERSION is not (orbit-start scattered-light",
    "ramps are asymmetric under reflection; flares invert into dips). This repo had a per-candidate phase-scrambling",
    "FAP and an inversion null but no candidate-level false-alarm POPULATION scored jointly with completeness. On",
    `**${curves.length} real TESS-SPOC curves** we build exactly that: ${injected.length} injected transits, ${scrambled.length}`,
    `scrambled TCEs (shuffle + block), ${inverted.length} inverted TCEs, all through src/detect/falseAlarmNull.ts.`,
    "",
    `| BLS SNR gate | completeness C | reliability R_FA | joint objective |`,
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.threshold} | ${r.c == null ? "n/a" : (100 * r.c).toFixed(1) + "%"} | ${r.rFa == null ? "n/a" : (100 * r.rFa).toFixed(1) + "%"} | ${r.objective == null ? "n/a" : r.objective.toFixed(3)} |`),
    "",
    `**Optimum: SNR>=${thr} (C=${best?.c == null ? "n/a" : (100 * best.c).toFixed(1)}%, R_FA=${best?.rFa == null ? "n/a" : (100 * best.rFa).toFixed(1)}%, objective=${best?.objective?.toFixed(3) ?? "n/a"}).**`,
    "",
    `False alarms clearing the optimum gate: scrambled ${survScram}/${scrambled.length} (${Number.isFinite(scramRate) ? (100 * scramRate).toFixed(1) + "%" : "n/a"}), inverted ${survInv}/${inverted.length} (${Number.isFinite(invRate) ? (100 * invRate).toFixed(1) + "%" : "n/a"}); median BLS SNR ${scramMed.toFixed(1)} (scrambled) vs ${invMed.toFixed(1)} (inverted).`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Builds a reusable candidate-level false-alarm null and reads a threshold off real data; wires nothing into the",
    "runtime, changes no production gate, claims no discovery. discoveryClaim false.",
    "",
  ].join("\n");
  writeFileSync("reports/p92-scrambled-fa.md", md);
  console.log("\nwrote reports/p92-scrambled-fa.md and reports/p92-scrambled-fa.json");
}

main().catch((e) => { console.error(`[p92] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
