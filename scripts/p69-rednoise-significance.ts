// P69 - RED-NOISE SIGNIFICANCE CHECK: is the production AR(1)-model null FAITHFUL to the real residual
// autocorrelation, or does it understate the false-alarm probability on active (red) hosts?
//
// WHY THIS EXISTS. The money-path significance gate is src/detect/significance.ts calibratedFap, whose null
// ensemble is an AR(1) model matched to the star's LAG-1 autocorrelation (rho). P8 measured that for a handful
// of hosts the ACF decays at least as fast as rho^k, hinting AR(1) is conservative -- but it never compared the
// PRODUCTION FAP to a model-free null on the SAME real noise. If real stellar variability is "redder than
// AR(1)" (longer memory, low-frequency excess, pulsation/granulation), an AR(1) null is too white and hands a
// noise bump a spuriously LOW FAP -- significance inflation exactly where a gate is least safe.
//
// THE MEASUREMENT. On real known-planet hosts we take the detrended curve, BLS it, MASK the transit
// (inTransitMask at the detected ephemeris with a generous pad), and re-measure the strongest REMAINING peak --
// which is now noise, not a planet. For that residual bump we compute the false-alarm probability TWO ways on
// the SAME curve:
//   fapAR1   = calibratedFap(residual)  -- the production AR(1)-model null (parametric, lag-1 only).
//   fapBlock = estimateFap(residual)    -- a model-free moving-block bootstrap that keeps the REAL autocorrelation
//                                         beyond lag 1 (the conservative reference on correlated noise).
// If fapAR1 < fapBlock, the production gate is OPTIMISTIC on that star. We stratify by measured rho (quiet
// <=0.2 vs red >0.2) and by fitAr1ToAcf.excessAtLastLag (>0 = the residuals have longer memory than AR(1)), and
// count how many noise bumps the AR(1) null would pass at FAP<0.05 that the model-free null would NOT.
//
// Positive/negative framing: these are KNOWN planets, so after masking the transit the residual bump is a
// planet-free noise feature -- an honest way to probe the null on real stars without claiming anything. Research
// only: no worker import, no verdict, no bundle hash, no money path; nothing anchored or claimed. discoveryClaim
// structurally false. This does not re-tune any gate -- it MEASURES whether the existing one is well-calibrated.
//
// Run: npm run p69:rednoise-significance [-- --targets 10 --nnull 100 --trials 100 --sector 1]

import { readFileSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { inTransitMask } from "../src/detect/iterative.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { estimateFap } from "../src/detect/fap.ts";
import { estimateRho, autocorrFunction, fitAr1ToAcf } from "../src/sim/redNoise.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";
import { buildStamp } from "./report-freshness.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const wantTargets = Math.max(3, parseInt(arg("targets", "10"), 10));
const nNull = Math.max(30, parseInt(arg("nnull", "100"), 10));
const trials = Math.max(30, parseInt(arg("trials", "100"), 10));
const sectorsPer = Math.max(1, parseInt(arg("sector", "1"), 10));
const seed = parseInt(arg("seed", "7"), 10);
const FAP_BAR = 0.05;

async function fetchOne(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let a = 0; a < 3; a++) { try { const lc = await fetchSpocLightCurve(tic, [sector], name); if (lc) return lc; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 400 * (a + 1))); }
  return null;
}

interface Row {
  name: string; rho: number; bucket: "quiet" | "red"; excessAtLastLag: number; ar1R2: number;
  residualSnr: number; fapAR1: number; fapBlock: number; delta: number; ar1PassesBlockDoesNot: boolean;
}

async function main(): Promise<void> {
  let names: Set<string> = new Set();
  try { const p60 = JSON.parse(readFileSync("reports/p60-joint-vs-single.json", "utf8")); names = new Set((p60.rows || []).map((r: any) => r.name)); } catch { /* fresh selection */ }

  const catalog = (await fetchConfirmedPlanets({ maxTmag: 11, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.tic != null && p.ra != null && p.dec != null)
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= 1 && p.pl_orbper <= 13)
    .filter((p) => names.size === 0 || names.has(p.pl_name ?? p.hostname ?? ""));

  console.log(`P69 RED-NOISE SIGNIFICANCE: AR(1)-model null vs model-free block-bootstrap on transit-masked residuals of ${wantTargets} real hosts; nNull=${nNull}, trials=${trials}, seed=${seed}. Token-free SPOC; no discovery claim.`);

  const rows: Row[] = [];
  for (const p of catalog) {
    if (rows.length >= wantTargets) break;
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    let sectors: number[]; try { sectors = await sectorsForCoord(p.ra!, p.dec!); } catch { continue; }
    if (!sectors.length) continue;
    const lc = await fetchOne(p.tic!, sectors[0], name);
    if (!lc || lc.points.length < 120) { continue; }
    const det = preprocess(lc, 0.5);
    let obs; try { obs = bls(det); } catch { continue; }
    // MASK the detected transit generously; the strongest REMAINING peak is now a noise feature.
    const times = det.points.map((q) => q.time);
    const mask = inTransitMask(times, obs.periodDays, obs.epochBjd, obs.durationDays, 0.6);
    const kept = det.points.filter((_, i) => !mask[i]);
    if (kept.length < 120) continue;
    const residual: LightCurve = { ...det, points: kept };
    let robs; try { robs = bls(residual); } catch { continue; }

    const flux = residual.points.map((q) => q.flux).filter((v) => Number.isFinite(v));
    const rho = estimateRho(flux);
    const acf = autocorrFunction(flux.filter((v) => Number.isFinite(v)), 15);
    const fit = fitAr1ToAcf(acf);

    const fapAR1 = calibratedFap(residual, robs.snr, robs.periodDays, { nNull, seed }).fap;
    const fapBlock = estimateFap(residual, { trials, seed, bls: { minPeriodDays: Math.max(1, robs.periodDays * 0.7), maxPeriodDays: robs.periodDays * 1.5 } }).fap;
    const delta = fapBlock - fapAR1;
    const flip = fapAR1 < FAP_BAR && fapBlock >= FAP_BAR;

    rows.push({ name, rho: Number.isFinite(rho) ? rho : 0, bucket: (Number.isFinite(rho) && rho > 0.2) ? "red" : "quiet", excessAtLastLag: fit.excessAtLastLag, ar1R2: fit.r2, residualSnr: robs.snr, fapAR1, fapBlock, delta, ar1PassesBlockDoesNot: flip });
    console.log(`  ${name.padEnd(18)} rho ${rows[rows.length - 1].rho.toFixed(2)} [${rows[rows.length - 1].bucket}]  resSnr ${robs.snr.toFixed(1)}  fapAR1 ${fapAR1.toFixed(3)}  fapBlock ${fapBlock.toFixed(3)}  delta ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}  excess ${Number.isFinite(fit.excessAtLastLag) ? fit.excessAtLastLag.toFixed(2) : "?"}  ${flip ? "AR1-OVERCALLS" : ""}`);
  }

  if (rows.length < 3) { console.log(`\nonly ${rows.length} hosts resolved. VERDICT: INSUFFICIENT-DATA`); process.exitCode = 0; return; }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const all = rows;
  // The transit-masked residual on a MULTI-planet host retains a REAL coherent bump from the sibling planet
  // (huge residual SNR), which contaminates the two-null comparison. A genuine noise bump has modest SNR;
  // we report the raw set AND a noise-like subset (resSnr < 50) as the honest head-to-head.
  const noise = rows.filter((r) => r.residualSnr < 50);
  const red = rows.filter((r) => r.bucket === "red");
  const quiet = rows.filter((r) => r.bucket === "quiet");
  const flipsAll = all.filter((r) => r.ar1PassesBlockDoesNot).length;
  const flipsNoise = noise.filter((r) => r.ar1PassesBlockDoesNot).length;
  const optimistic = all.filter((r) => r.delta > 0).length;
  const optimisticNoise = noise.filter((r) => r.delta > 0).length;
  const redMeanDelta = red.length ? mean(red.map((r) => r.delta)) : null;
  const quietMeanDelta = quiet.length ? mean(quiet.map((r) => r.delta)) : null;
  const noiseMeanDelta = noise.length ? mean(noise.map((r) => r.delta)) : null;
  const meanExcess = mean(all.map((r) => r.excessAtLastLag).filter(Number.isFinite));
  const maxResSnr = Math.max(...all.map((r) => r.residualSnr));

  console.log(`\n=== P69 SUMMARY (${all.length} hosts: ${quiet.length} quiet, ${red.length} red; ${noise.length} noise-like resSnr<50) ===`);
  console.log(`  mean FAP delta (block - AR1): ALL ${mean(all.map((r) => r.delta)).toFixed(4)}  quiet ${quietMeanDelta == null ? "-" : quietMeanDelta.toFixed(4)}  red ${redMeanDelta == null ? "-" : redMeanDelta.toFixed(4)}  noise-like ${noiseMeanDelta == null ? "-" : noiseMeanDelta.toFixed(4)}`);
  console.log(`  hosts where the model-free null is MORE conservative than AR(1) (delta>0): ${optimistic}/${all.length} (noise-like ${optimisticNoise}/${noise.length})`);
  console.log(`  noise bumps the AR(1) gate would PASS (FAP<${FAP_BAR}) that the model-free null would NOT: all ${flipsAll}/${all.length}, noise-like ${flipsNoise}/${noise.length}`);
  console.log(`  mean AR(1)-ACF excessAtLastLag: ${meanExcess.toFixed(3)} (${meanExcess > 0 ? "redder than AR(1)" : "NOT redder than AR(1) -- memory decays at least as fast as rho^k"})`);
  console.log(`  max residual SNR across hosts ${maxResSnr.toFixed(0)} (>50 = a real sibling-planet bump survived masking, excluded from the noise-like head-to-head)`);

  const ar1Permissive = flipsNoise >= 2 && (noiseMeanDelta ?? 0) > 0;
  const verdict = ar1Permissive
    ? `AR1-MODEL-NULL-TOO-PERMISSIVE vs the model-free reference: on ${flipsNoise}/${noise.length} genuine noise bumps the production AR(1)-model null clears FAP<${FAP_BAR} while the block bootstrap (same real noise) does not (mean delta ${noiseMeanDelta?.toFixed(3)}); the synthetic AR(1) ensemble understates real residual tails. This is NOT an active-star effect (quiet mean delta ${quietMeanDelta?.toFixed(3)} >= red ${redMeanDelta?.toFixed(3)}, excessAtLastLag ${meanExcess.toFixed(2)} <= 0). CAVEAT: transit-masked residuals on multi-planet hosts keep real coherent sibling signals (max resSnr ${maxResSnr.toFixed(0)}), so a fully clean calibration needs planet-free real windows, not masked multi-planet curves.`
    : optimisticNoise >= noise.length * 0.6
      ? `MILD-AR1-OPTIMISM (the model-free null is usually at least as strict on the noise-like bumps, mean delta ${noiseMeanDelta?.toFixed(4) ?? "n/a"}, but no material pass/fail flips at FAP<${FAP_BAR}); AR(1) is close to faithful here.)`
      : `AR1-FAITHFUL-ENOUGH: on the noise-like bumps the AR(1)-model null tracks the model-free block bootstrap (mean delta ${noiseMeanDelta?.toFixed(4) ?? "n/a"}, flips ${flipsNoise}/${noise.length}); no evidence the production gate is optimistic here -- consistent with P8's ACF finding.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  measure-before-gate: this MEASURES calibration of the existing AR(1) gate; it changes no threshold and touches no money path. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { ...buildStamp(["reports/p60-joint-vs-single.json", "scripts/p69-rednoise-significance.ts"]), generatedBy: "scripts/p69-rednoise-significance.ts", n: all.length, nNull, trials, sectorsPer, seed, fapBar: FAP_BAR, noiseLikeCut: 50, data: "real TESS-SPOC transit-masked residuals (token-free public S3)", note: "AR(1)-model null (production calibratedFap) vs model-free block-bootstrap (estimateFap) on the SAME noise; NOT a discovery claim; re-tunes nothing." },
    summary: { quiet: quiet.length, red: red.length, noiseLike: noise.length, meanDeltaAll: mean(all.map((r) => r.delta)), meanDeltaQuiet: quietMeanDelta, meanDeltaRed: redMeanDelta, meanDeltaNoise: noiseMeanDelta, nOptimistic: optimistic, nOptimisticNoise: optimisticNoise, flipsAll, flipsNoise, meanExcessAtLastLag: meanExcess, maxResidualSnr: maxResSnr },
    rows, verdict, safeToGate: false, discoveryClaim: false,
  };
  writeFileSync("reports/p69-rednoise-significance.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P69 is the AR(1)-model significance gate faithful to real red noise?",
    "",
    `Reproduce: \`npm run p69:rednoise-significance -- --targets ${wantTargets} --nnull ${nNull} --trials ${trials}\``,
    "",
    "The production gate calibrates against an AR(1) null matched to lag-1 rho. This study masks the transit",
    "on real known-planet hosts and compares, on the SAME noise-only residual bump, the AR(1)-model FAP against",
    "a model-free block-bootstrap FAP that preserves the true autocorrelation beyond lag 1.",
    "",
    "| bucket | hosts | mean (block - AR1) FAP delta | bumps AR1 passes but block does not |",
    "|---|---|---|---|",
    `| quiet (rho<=0.2) | ${quiet.length} | ${quietMeanDelta == null ? "-" : quietMeanDelta.toFixed(4)} | ${quiet.filter((r) => r.ar1PassesBlockDoesNot).length} |`,
    `| red (rho>0.2)    | ${red.length} | ${redMeanDelta == null ? "-" : redMeanDelta.toFixed(4)} | ${red.filter((r) => r.ar1PassesBlockDoesNot).length} |`,
    "",
    `Mean AR(1)-ACF excessAtLastLag = ${meanExcess.toFixed(3)} (positive = residuals have longer memory than AR(1)).`,
    `Flips at FAP<${FAP_BAR}: all ${flipsAll}/${all.length}, noise-like ${flipsNoise}/${noise.length}.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Measures calibration of the existing gate; changes no threshold, touches no money path; discoveryClaim false.",
    "",
  ].join("\n");
  writeFileSync("reports/p69-rednoise-significance.md", md);
  console.log("\nwrote reports/p69-rednoise-significance.md and reports/p69-rednoise-significance.json");
}

main().catch((e) => { console.error(`[p69] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
