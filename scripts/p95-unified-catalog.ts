// P95 - A BOUNDED, CITABLE UNIFIED CATALOG + THE JOINT COMPLETENESS/RELIABILITY OPERATING POINT IT READS OFF
// (authority roadmap, priority 4).
//
// WHY. A tool becomes a reference not by a hundred one-off numbers but by ONE stable, citable object: a bounded,
// magnitude-limited catalogue whose rows are reproducible and whose vetting threshold is chosen by a stated, measured
// criterion rather than a round number. This builds that object entirely from the COMMITTED byte-exact real SPOC
// fixtures + the real NASA-archive stellar parameters (stellar-params.json) + the P3 candidate-level null machinery
// (falseAlarmNull.ts). It is deliberately offline and deterministic: no network, so every run re-reads identical
// bytes and the catalog is quotable. Three things it produces, all measured:
//   * KNOWN-PLANET RECOVERY -- on these CONFIRMED-planet hosts the pipeline's blind BLS argmax either lands on a known
//     planet (alias-tolerant) or it does not. That is a real recovery rate on real photometry, the pipeline analog of
//     the ~90% known-TOI recovery the field reports for its vetters (LEO-Vetter, Kunimoto+ 2025).
//   * THE JOINT C/R OPERATING POINT -- completeness C on transits injected into the real curves against false-alarm
//     reliability R_FA on a time-scrambled population, optimised by sqrt((1-C)^2+(1-R_FA)^2) exactly as the field does.
//   * THE CATALOG TABLE -- one row per host: TIC, sectors, stellar Teff/radius/mass/density, its known planet periods,
//     the blind best BLS SNR/period, whether a known planet is recovered, and whether it survives the operating gate.
//
// HONESTY. n = the committed fixture sample (a demonstration-bounded catalogue, NOT a production all-sky catalog); the
// operating SNR is read off THIS sample, not asserted as the survey-wide threshold; nothing here is wired into the
// critic, verdict, bundle hash, or money path; discoveryClaim and safeToGate are structurally false. It reports a
// recovery rate of KNOWN planets, which is a detection statistic, not a claim of any new world.
//
// Run: npm run p95:unified-catalog [-- --perCurve 3 --seed 7 --depths 300,500,1000,2000,4000]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildStamp } from "./report-freshness.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";
import { isAliasOf } from "../src/detect/iterative.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import {
  scrambleFlux, classifyTces, completeness, falseAlarmReliability, jointObjective, sweepThresholds, optimizeThreshold,
  type Tce,
} from "../src/detect/falseAlarmNull.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const perCurve = Math.max(1, parseInt(arg("perCurve", "3"), 10));
const seed = parseInt(arg("seed", "7"), 10);
const injPeriod = Number(arg("period", "3"));
const depthsPpm = arg("depths", "300,500,1000,2000,4000").split(",").map((s) => parseInt(s, 10)).filter((v) => Number.isFinite(v) && v > 0);
const GRID = { minPeriodDays: 1.5, maxPeriodDays: 13, oversample: 8 };
const THRESHOLDS = [5, 8, 10, 12, 15, 18, 22, 26, 30, 35, 40];

const fixtureDir = join("tests", "fixtures", "spoc-curves");
interface CurveMeta { host: string; file: string; tic: number; sectors: number[]; knownPlanetPeriodsDays: number[]; }
interface StarRec { Teff: number; rad: number; mass: number; rho: number; logg: number | null; }

function loadManifest(): CurveMeta[] {
  const m = JSON.parse(readFileSync(join(fixtureDir, "manifest.json"), "utf8")) as { curves: CurveMeta[] };
  return m.curves;
}
function loadStars(): Record<string, StarRec> {
  const p = JSON.parse(readFileSync(join(fixtureDir, "stellar-params.json"), "utf8")) as { stars: Record<string, StarRec> };
  return p.stars;
}
function readCurve(file: string): LightCurve | null {
  const raw = readFileSync(join(fixtureDir, file), "utf8").replace(/\r\n/g, "\n").split("\n");
  const points: { time: number; flux: number }[] = [];
  for (let i = 1; i < raw.length; i++) {
    const line = raw[i]!.trim();
    if (!line) continue;
    const [t, f] = line.split(",");
    const tv = Number(t); const fv = Number(f);
    if (Number.isFinite(tv) && Number.isFinite(fv)) points.push({ time: tv, flux: fv });
  }
  return points.length >= 150 ? { targetId: file, mission: "TESS", points } : null;
}

function detectPeak(lc: LightCurve): { periodDays: number; stat: number } | null {
  try {
    const b = bls(lc, GRID);
    if (Number.isFinite(b.snr) && Number.isFinite(b.periodDays) && b.snr > 0) return { periodDays: b.periodDays, stat: b.snr };
    return null;
  } catch { return null; }
}
function detectAtPeriod(lc: LightCurve, period: number): number {
  try {
    const b = bls(lc, { minPeriodDays: period * 0.97, maxPeriodDays: period * 1.03, oversample: GRID.oversample });
    return Number.isFinite(b.snr) && b.snr > 0 ? b.snr : 0;
  } catch { return 0; }
}

interface CatRow {
  host: string; tic: number; sectors: number[]; teff: number | null; radius: number | null; mass: number | null; density: number | null;
  knownPlanetPeriodsDays: number[]; nPoints: number; blindBestSnr: number | null; blindBestPeriodDays: number | null;
  recoversKnown: boolean; recoversAtOperatingThreshold: boolean;
}

function main(): void {
  const metas = loadManifest();
  const stars = loadStars();
  console.log(`P95 unified bounded catalogue: ${metas.length} committed real SPOC hosts. seed=${seed}, injectP=${injPeriod}d, depths=[${depthsPpm}]ppm, perCurve=${perCurve}. Offline, deterministic. discoveryClaim false.`);

  const curves: { meta: CurveMeta; lc: LightCurve }[] = [];
  for (const meta of metas) {
    const raw = readCurve(meta.file);
    if (!raw) continue;
    curves.push({ meta, lc: preprocess(raw, 0.5) });
  }
  if (curves.length < 4) { console.log(`only ${curves.length} usable committed curves. VERDICT: INSUFFICIENT-FIXTURES`); return; }

  const rows: CatRow[] = [];
  const injected: Tce[] = [];
  const scrambled: Tce[] = [];

  for (let c = 0; c < curves.length; c++) {
    const { meta, lc } = curves[c]!;
    const star = stars[meta.host] ?? null;

    // Known-planet recovery: blind BLS argmax on the host's OWN confirmed planets.
    const peak = detectPeak(lc);
    const known = meta.knownPlanetPeriodsDays;
    const recoversKnown = peak != null && known.some((k) => isAliasOf(peak.periodDays, k, 2));

    // Completeness denominator: inject a transit and score at the injected ephemeris.
    for (const d of depthsPpm) {
      const withT = injectTransitInto(lc, { seed: seed * 1000 + c * 97 + d, periodDays: injPeriod, depthFrac: d * 1e-6 });
      const stat = detectAtPeriod(withT, injPeriod);
      injected.push({ targetId: `${meta.host}#inj${d}`, periodDays: injPeriod, stat, injected: true, truthPeriodDays: injPeriod });
    }
    // False-alarm population: time-scramble each real curve.
    for (let k = 0; k < perCurve; k++) {
      const hit = detectPeak(scrambleFlux(lc, { seed: seed + c * 1000 + k * 13, mode: "shuffle" }));
      if (hit) scrambled.push({ targetId: `${meta.host}#scr${k}`, periodDays: hit.periodDays, stat: hit.stat, injected: false });
    }

    rows.push({
      host: meta.host, tic: meta.tic, sectors: meta.sectors,
      teff: star?.Teff ?? null, radius: star?.rad ?? null, mass: star?.mass ?? null, density: star?.rho ?? null,
      knownPlanetPeriodsDays: known, nPoints: lc.points.length,
      blindBestSnr: peak ? peak.stat : null, blindBestPeriodDays: peak ? peak.periodDays : null,
      recoversKnown, recoversAtOperatingThreshold: false, // filled after the operating point is chosen
    });
  }

  // Joint completeness/reliability operating point on the combined pool.
  const pool = [...injected, ...scrambled];
  const sweep = sweepThresholds(pool, THRESHOLDS);
  const best = optimizeThreshold(sweep);
  const thr = best?.threshold ?? 7;
  for (const r of rows) {
    r.recoversAtOperatingThreshold = r.recoversKnown && r.blindBestSnr != null && r.blindBestSnr >= thr;
  }

  const recoveredKnown = rows.filter((r) => r.recoversKnown).length;
  const recoveredAtThr = rows.filter((r) => r.recoversAtOperatingThreshold).length;
  const scramSurv = scrambled.filter((t) => t.stat >= thr).length;
  const C = best?.c ?? completeness(pool, classifyTces(pool, thr));
  const R = best?.rFa ?? falseAlarmReliability(pool, classifyTces(pool, thr));

  console.log(`\n=== P95 SUMMARY (${rows.length} hosts) ===`);
  console.log(`  known-planet recovery: ${recoveredKnown}/${rows.length} (${(100 * recoveredKnown / rows.length).toFixed(1)}%) blind; ${recoveredAtThr}/${rows.length} also clear SNR>=${thr}`);
  console.log(`  joint C/R optimum: SNR>=${thr}  C=${C == null ? "n/a" : (100 * C).toFixed(1)}%  R_FA=${R == null ? "n/a" : (100 * R).toFixed(1)}%  objective=${best?.objective == null ? "n/a" : best.objective.toFixed(3)}`);
  console.log(`  scrambled false alarms clearing the gate: ${scramSurv}/${scrambled.length}`);
  console.log("  threshold | C | R_FA | objective");
  for (const r of sweep) console.log(`     SNR>=${String(r.threshold).padStart(2)} | ${r.c == null ? "n/a" : (100 * r.c).toFixed(1) + "%"} | ${r.rFa == null ? "n/a" : (100 * r.rFa).toFixed(1) + "%"} | ${r.objective == null ? "n/a" : r.objective.toFixed(3)}`);

  const hasOpt = best != null && C != null && R != null;
  const verdict = hasOpt
    ? `CATALOGUE-BOUNDED: a reproducible ${rows.length}-host catalogue on real committed SPOC photometry recovers ${recoveredKnown}/${rows.length} (${(100 * recoveredKnown / rows.length).toFixed(1)}%) of its hosts' own known planets blind; the joint C/R objective sqrt((1-C)^2+(1-R_FA)^2) on THIS sample is minimised at BLS SNR>=${thr} (C=${(100 * (C ?? 0)).toFixed(1)}%, R_FA=${(100 * (R ?? 0)).toFixed(1)}%), the operating gate at which ${recoveredAtThr}/${rows.length} known-planet recoveries still stand. Bounded n=${rows.length} demonstration catalogue -- the SNR is read off THIS sample, not asserted survey-wide; wires nothing; discoveryClaim false.`
    : `INSUFFICIENT-POPULATION: ${injected.length} injections / ${scrambled.length} scrambled TCEs did not support a joint C/R sweep. VERDICT: NEEDS-MORE-CURVES.`;
  console.log(`\nVERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["tests/fixtures/spoc-curves/manifest.json", "tests/fixtures/spoc-curves/stellar-params.json", "src/detect/falseAlarmNull.ts", "src/detect/bls.ts"]),
      generatedBy: "scripts/p95-unified-catalog.ts", nHosts: rows.length, seed, injectPeriodDays: injPeriod,
      depthsPpm, thresholds: THRESHOLDS, blsGrid: GRID, perCurve,
      stellarParamsSource: "tests/fixtures/spoc-curves/stellar-params.json (NASA Exoplanet Archive, via scripts/p94-stellar-params.ts)",
      note: "Bounded, citable catalogue of the committed real SPOC hosts with a data-driven joint completeness/reliability operating point and a real known-planet recovery rate. LEO-Vetter-style sqrt((1-C)^2+(1-R_FA)^2) threshold selection. Measures only; the operating SNR is specific to THIS bounded sample; discoveryClaim false.",
    },
    operatingPoint: { thresholdSnr: thr, completenessC: C, reliabilityRFA: R, jointObjective: best?.objective ?? null },
    recovery: { blindRecoveredKnown: recoveredKnown, recoveredAtOperatingThreshold: recoveredAtThr, nHosts: rows.length },
    falseAlarmNull: { scrambledTces: scrambled.length, survivorsAtOpt: scramSurv },
    sweep,
    catalog: rows,
    verdict: hasOpt ? "CATALOGUE-BOUNDED" : "NEEDS-MORE-CURVES",
    safeToGate: false, discoveryClaim: false,
  };
  writeFileSync("reports/p95-unified-catalog.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P95 bounded unified catalogue and its joint completeness/reliability operating point",
    "",
    `Reproduce: \`npm run p95:unified-catalog -- --perCurve ${perCurve} --seed ${seed} --depths ${depthsPpm.join(",")}\``,
    "",
    `A reproducible, bounded catalogue of **${rows.length} committed byte-exact real TESS-SPOC hosts**, each with its NASA-archive stellar parameters, its known planet periods, the pipeline's blind best BLS SNR/period, and whether a known planet is recovered. The vetting gate is chosen by the field's joint criterion sqrt((1-C)^2+(1-R_FA)^2) measured on this same sample, not by a round number.`,
    "",
    `**Known-planet recovery (real photometry):** ${recoveredKnown}/${rows.length} hosts recover a known confirmed planet blind (${(100 * recoveredKnown / rows.length).toFixed(1)}%); ${recoveredAtThr}/${rows.length} also clear the operating SNR>=${thr}.`,
    `**Joint C/R operating point:** SNR>=${thr} with completeness C=${C == null ? "n/a" : (100 * C).toFixed(1)}%, false-alarm reliability R_FA=${R == null ? "n/a" : (100 * R).toFixed(1)}%, objective ${best?.objective == null ? "n/a" : best.objective.toFixed(3)}. Scrambled false alarms clearing the gate: ${scramSurv}/${scrambled.length}.`,
    "",
    "| host | TIC | sectors | Teff | R* | M* | rho | known P (d) | blind best SNR | best P (d) | recovers known |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.host} | ${r.tic} | ${r.sectors.join(",")} | ${r.teff ?? "-"} | ${r.radius ?? "-"} | ${r.mass ?? "-"} | ${r.density?.toFixed(2) ?? "-"} | ${r.knownPlanetPeriodsDays.map((k) => k.toFixed(2)).join(", ")} | ${r.blindBestSnr?.toFixed(1) ?? "-"} | ${r.blindBestPeriodDays?.toFixed(3) ?? "-"} | ${r.recoversKnown ? "yes" : "no"} |`),
    "",
    "**VERDICT:** " + verdict,
    "",
    "Honest bounds: n=" + rows.length + " is a bounded demonstration catalogue, not an all-sky product; the operating SNR is read off THIS sample; the recovery is a detection statistic on KNOWN planets, not a new-world claim. Nothing is wired into the critic or the money path; discoveryClaim and safeToGate are false.",
  ].join("\n");
  writeFileSync("reports/p95-unified-catalog.md", md + "\n");
  console.log("\nwrote reports/p95-unified-catalog.md and reports/p95-unified-catalog.json");
}

main();
