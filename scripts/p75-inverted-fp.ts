// P75 - INVERTED-CURVE EMPIRICAL FALSE-ALARM RATE (borrowed from eumemic/exoplanets' EXO_INVERT null): a
// model-free read on whether the production AR(1) significance gate is calibrated, answering P69's caveat.
//
// WHY THIS EXISTS. P69 found the production AR(1)-model null is a touch too PERMISSIVE vs a model-free block
// bootstrap on transit-masked residuals -- but it flagged that masked multi-planet residuals keep real sibling
// bumps (max res SNR 1172), so that head-to-head was contaminated. The external project's cleaner trick: INVERT
// the light curve (flux -> 2*median - flux) so every transit becomes a bump; the pipeline then hunts bumps that
// CAN only be noise/systematics (there are no real dips). Running the significance gate on inverted curves gives
// a MODEL-FREE empirical false-alarm rate -- the direct calibration the AR(1) gate needs, on real photometry.
//
// THE MEASUREMENT. On real TESS-SPOC curves (single sector keeps the ephemeris exact, so masking is clean):
// detrend, INVERT, then MASK every catalogued planet on that host (ground-truth period+epoch+duration, window
// widened by padFrac). Inversion means a real transit would be a bump at the SAME ephemeris, so masking removes
// every planet's feature. We keep only a POSITIVE (transit-like) dip as the sample -- a transit gate never reports
// a residual bump, so those hosts are skipped. The surviving positive dip can ONLY be noise/systematics, a genuine
// false-alarm candidate. For it compute the false-alarm probability
// TWO ways on the SAME inverted bump:
//   fapAR1   = calibratedFap  -- the production AR(1)-model null (parametric, lag-1).
//   fapBlock = estimateFap    -- a model-free moving-block bootstrap that keeps the real autocorrelation.
// A noise bump with FAP < 0.05 is a FALSE ALARM of that null. The empirical FP rate of each null, and how many
// bumps the AR(1) gate signs off but the model-free null rejects, is the honest recalibration P69 asked for --
// now on a planet-free (inverted) null, not a masked residual. Stratified by measured rho (quiet vs red).
//
// Research only: no worker import, no verdict, no bundle hash, no money path; this MEASURES the existing gate's
// calibration and changes no threshold. Positive/negative framing: inverted curves are a null by construction.
// discoveryClaim structurally false.
//
// Run: npm run p75:inverted-fp [-- --targets 20 --nnull 100 --trials 120 --seed 7 --maxsectors 4]

import { preprocess } from "../src/detect/detrend.ts";
import { invertCurve, maskKnownTransits } from "../src/detect/invertedNull.ts";
import { bls } from "../src/detect/bls.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { estimateFap } from "../src/detect/fap.ts";
import { estimateRho } from "../src/sim/redNoise.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";
import { buildStamp } from "./report-freshness.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const wantTargets = Math.max(4, parseInt(arg("targets", "20"), 10));
const nNull = Math.max(30, parseInt(arg("nnull", "100"), 10));
const trials = Math.max(40, parseInt(arg("trials", "120"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "1"), 10)); // 1 sector keeps the ephemeris exact so masking is clean
const seed = parseInt(arg("seed", "7"), 10);
const FAP_BAR = 0.05;
const SEARCH_MAX = Number(arg("maxperiod", "40")); // upper period (d) searched for the residual noise bump
const padFrac = Number(arg("pad", "0.5")); // widen each masked planet's transit window so wings go too

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let a = 0; a < 3; a++) { try { const lc = await fetchSpocLightCurve(tic, [sector], name); if (lc) return lc; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 400 * (a + 1))); }
  return null;
}

/** Fetch up to `maxSectors` single-sector SPOC curves and stitch them into one longer-baseline curve. */
async function fetchStitched(tic: number, sectors: number[], name: string): Promise<LightCurve | null> {
  const parts: LightCurve[] = [];
  for (const s of sectors.slice(0, maxSectors)) {
    const lc = await fetchSectorCurve(tic, s, name);
    if (lc && lc.points.length >= 60) parts.push(lc);
  }
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return stitchLightCurves(parts) ?? parts[0];
}

// invert + planet-masking now live in the reusable src/detect/invertedNull.ts (audit-10 #6); this study imports them.

interface Row {
  name: string; rho: number; bucket: "quiet" | "red"; bumpSnr: number; bumpPeriod: number; nPlanetsMasked: number; searchMax: number;
  fapAR1: number; fapBlock: number; delta: number; ar1FalseAlarm: boolean; blockFalseAlarm: boolean; flip: boolean;
}

/**
 * The LIVE measurement path -- only reached with `--live`. Fetches bright, well-covered hosts from the LIVE NASA
 * Exoplanet Archive, resolves sectors, pulls token-free TESS-SPOC curves, INVERTS each and MASKS every catalogued
 * planet, then scores the surviving positive residual dip under BOTH the AR(1) gate and a model-free block bootstrap.
 */
async function measureLive(): Promise<Row[]> {
  console.log(`P75 INVERTED-CURVE FALSE-ALARMS: model-free empirical FP rate for the AR(1) significance gate (answers P69's masked-residual caveat). targets=${wantTargets}, nNull=${nNull}, trials=${trials}, seed=${seed}, FAP bar ${FAP_BAR}. Token-free real SPOC; inverted by construction; no discovery claim.`);

  // Bright, well-covered hosts. For each: INVERT, then MASK every catalogued planet (ground-truth ephemeris,
  // window widened by padFrac). What survives is noise/systematics ONLY -- a genuine false-alarm sample. Its
  // significance is scored under BOTH the production AR(1) gate and a model-free block bootstrap.
  const planets = (await fetchConfirmedPlanets({ maxTmag: 11, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.tic != null && p.ra != null && p.dec != null && p.pl_orbper != null);
  interface Mask { period: number; epoch: number; durDays: number }
  const byHost = new Map<string, Mask[]>();
  const coordByHost = new Map<string, { tic: number; ra: number; dec: number }>();
  for (const p of planets) {
    const h = p.hostname || `TIC ${p.tic}`;
    if (!byHost.has(h)) { byHost.set(h, []); coordByHost.set(h, { tic: p.tic!, ra: p.ra!, dec: p.dec! }); }
    if (Number.isFinite(p.pl_tranmid!) && Number.isFinite(p.pl_trandur!))
      byHost.get(h)!.push({ period: p.pl_orbper!, epoch: p.pl_tranmid!, durDays: p.pl_trandur! / 24 });
  }
  const seen = new Set<string>();
  const cands: { name: string; tic: number; ra: number; dec: number; masks: Mask[] }[] = [];
  for (const p of planets) {
    const h = p.hostname || `TIC ${p.tic}`;
    if (seen.has(h)) continue; seen.add(h);
    if (!(p.pl_orbper! >= 1 && p.pl_orbper! <= 13)) continue; // a short, well-measured planet implies good coverage
    const masks = byHost.get(h)!;
    if (!masks.length) continue;
    cands.push({ name: p.pl_name ?? h, ...coordByHost.get(h)!, masks });
    if (cands.length >= wantTargets * 4) break;
  }

  const rows: Row[] = [];
  for (const c of cands) {
    if (rows.length >= wantTargets) break;
    let sectors: number[]; try { sectors = await sectorsForCoord(c.ra, c.dec); } catch { continue; }
    if (!sectors.length) continue;
    const lc = await fetchStitched(c.tic, sectors, c.name);
    if (!lc || lc.points.length < 150) continue;
    const times = lc.points.map((q) => q.time).filter((v) => Number.isFinite(v));
    const baseline = Math.max(...times) - Math.min(...times);
    const searchMax = Math.min(baseline / 3, SEARCH_MAX); // need >= ~3 transits to test a fold
    if (!(searchMax > 1.5)) { console.log(`  ${c.name.padEnd(18)} baseline too short to search (${baseline.toFixed(0)}d)`); continue; }

    const inv = invertCurve(preprocess(lc, 0.5));
    const residual = maskKnownTransits(inv, c.masks, padFrac);
    if (residual.points.length < 120) { console.log(`  ${c.name.padEnd(18)} too few cadences after masking`); continue; }
    let b; try { b = bls(residual, { minPeriodDays: 1.5, maxPeriodDays: searchMax }); } catch { continue; }
    // Only a POSITIVE (transit-like) dip is a candidate the gate could sign off; a negative peak is a residual
    // BUMP (a mirror the mask left, or stellar variability), which the transit gate never reports -- so skip it.
    if (!Number.isFinite(b.snr) || !Number.isFinite(b.periodDays) || b.snr <= 0) { console.log(`  ${c.name.padEnd(18)} no transit-like residual dip (peak snr ${Number.isFinite(b?.snr) ? b.snr.toFixed(1) : "n/a"})`); continue; }

    const flux = residual.points.map((q) => q.flux).filter((v) => Number.isFinite(v));
    const rho = estimateRho(flux);
    const fapAR1 = calibratedFap(residual, b.snr, b.periodDays, { nNull, seed }).fap;
    const fapBlock = estimateFap(residual, { trials, seed, bls: { minPeriodDays: Math.max(1, b.periodDays * 0.7), maxPeriodDays: b.periodDays * 1.5 } }).fap;
    const delta = fapBlock - fapAR1;
    const ar1FalseAlarm = fapAR1 < FAP_BAR;
    const blockFalseAlarm = fapBlock < FAP_BAR;
    const flip = ar1FalseAlarm && !blockFalseAlarm;
    rows.push({ name: c.name, rho: Number.isFinite(rho) ? rho : 0, bucket: (Number.isFinite(rho) && rho > 0.2) ? "red" : "quiet", bumpSnr: b.snr, bumpPeriod: b.periodDays, nPlanetsMasked: c.masks.length, searchMax, fapAR1, fapBlock, delta, ar1FalseAlarm, blockFalseAlarm, flip });
    console.log(`  ${c.name.padEnd(18)} rho ${rows[rows.length - 1].rho.toFixed(2)} [${rows[rows.length - 1].bucket}]  bumpSnr ${b.snr.toFixed(1)} P ${b.periodDays.toFixed(2)}d (masked ${c.masks.length}, search<${searchMax.toFixed(0)})  fapAR1 ${fapAR1.toFixed(3)}${ar1FalseAlarm ? " <FALSE>" : ""}  fapBlock ${fapBlock.toFixed(3)}${blockFalseAlarm ? " <FALSE>" : ""}  delta ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}${flip ? "  AR1-OVERCALLS" : ""}`);
  }

  return rows;
}

async function main(): Promise<void> {
  // FROZEN DATA SOURCE -- the p90 precedent, applied to the project's most-cited number. p75 measures against the LIVE
  // Archive + S3, so a plain re-fetch re-MEASURES and can silently move the published false-alarm rate the way p90's
  // depth error bar moved when the Archive added planets. A number cited in the figures, research.json and the report
  // library must be reproducible, not a lottery on when inverted-fp-scale.yml happened to run. The 200 measured rows
  // are therefore frozen into reports/fixtures/p75-frozen-rows.json (a committed, immutable snapshot of what the live
  // run actually gathered), and the DEFAULT replays every statistic from them OFFLINE and deterministically. `--live`
  // (or `--from-json=`) is the deliberate re-measure path.
  const FROZEN = "reports/fixtures/p75-frozen-rows.json";
  const REPLAY = arg("from-json", process.argv.includes("--live") ? "" : FROZEN);
  let rows: Row[] = [];
  // Params shown in the report come from the run that gathered the rows, so a replay never describes a sampling it
  // did not use.
  let shownNNull = nNull, shownTrials = trials, shownMaxSectors = maxSectors, shownSeed = seed, shownSearchMax = SEARCH_MAX, shownPad = padFrac;
  let measuredAt = new Date().toISOString();
  if (REPLAY) {
    const j = JSON.parse(readFileSync(REPLAY, "utf8")) as {
      rows: Row[];
      measuredAt?: string;
      meta?: { nNull?: number; trials?: number; maxSectors?: number; seed?: number; searchMaxDays?: number; padFrac?: number; generatedAt?: string };
    };
    rows = j.rows;
    shownNNull = j.meta?.nNull ?? nNull;
    shownTrials = j.meta?.trials ?? trials;
    shownMaxSectors = j.meta?.maxSectors ?? maxSectors;
    shownSeed = j.meta?.seed ?? seed;
    shownSearchMax = j.meta?.searchMaxDays ?? SEARCH_MAX;
    shownPad = j.meta?.padFrac ?? padFrac;
    measuredAt = j.measuredAt ?? j.meta?.generatedAt ?? "unknown";
    console.log(`[p75] REPLAY from ${REPLAY}: ${rows.length} stored rows, original measurement ${measuredAt}. No network, no new measurement.`);
  } else {
    rows = await measureLive();
  }

  if (rows.length < 4) { console.log(`\nonly ${rows.length} planet-free bumps resolved. VERDICT: INSUFFICIENT-DATA`); process.exitCode = 0; return; }

  const n = rows.length;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const ar1Fp = rows.filter((r) => r.ar1FalseAlarm).length;
  const blockFp = rows.filter((r) => r.blockFalseAlarm).length;
  const flips = rows.filter((r) => r.flip).length;
  const red = rows.filter((r) => r.bucket === "red"), quiet = rows.filter((r) => r.bucket === "quiet");
  const redFlips = red.filter((r) => r.flip).length, quietFlips = quiet.filter((r) => r.flip).length;
  const meanDelta = mean(rows.map((r) => r.delta));

  console.log(`\n=== P75 SUMMARY (${n} inverted curves: ${quiet.length} quiet, ${red.length} red) ===`);
  console.log(`  EMPIRICAL false-alarm rate at FAP<${FAP_BAR} (a planet-free bump the gate signs off on):`);
  console.log(`    AR(1)-model gate : ${ar1Fp}/${n} = ${(100 * ar1Fp / n).toFixed(0)}%   (nominal 5%)`);
  console.log(`    model-free block : ${blockFp}/${n} = ${(100 * blockFp / n).toFixed(0)}%`);
  console.log(`  AR(1) passes but model-free rejects (gate optimism): ${flips}/${n}  (red ${redFlips}/${red.length}, quiet ${quietFlips}/${quiet.length})`);
  console.log(`  mean FAP delta (block - AR1) = ${meanDelta.toFixed(4)}  (>0: AR(1) is more optimistic than model-free)`);

  const ar1Over = flips >= 2 && ar1Fp > blockFp;
  const bothPermissive = ar1Fp / n > 0.25;
  const verdict = ar1Over && bothPermissive
    ? `GATE-OPTIMISTIC-ON-REAL-NOISE: on inverted (planet-free) curves the production AR(1) gate signs off ${ar1Fp}/${n} noise bumps as significant at FAP<${FAP_BAR} -- ${(100 * ar1Fp / n).toFixed(0)}% >> the nominal 5% -- and the model-free block bootstrap rejects ${flips} of them; real systematics have tails AR(1) under-states (recovers P69's finding on a CLEAN null). Measured only; threshold unchanged.`
    : ar1Over
      ? `MILD-AR1-OPTIMISM: the AR(1) gate false-alarms ${ar1Fp}/${n} vs the model-free ${blockFp}/${n} (${flips} bumps AR1 passes and block does not, mean delta ${meanDelta.toFixed(3)}) -- a small, real but not severe calibration gap; consistent with a mildly permissive AR(1) null.`
      : `GATE-CALIBRATED: on inverted planet-free curves the AR(1) gate and the model-free null agree (FP ${ar1Fp}/${n} vs ${blockFp}/${n}, ${flips} flips, mean delta ${meanDelta.toFixed(3)}) -- the AR(1) significance null tracks the empirical false-alarm rate on this real noise; no recalibration warranted.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  measure-before-gate: quantifies the existing gate's FP calibration on a model-free null; changes no threshold, touches no money path. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: REPLAY ? `scripts/p75-inverted-fp.ts --from-json=${REPLAY} (offline replay of frozen rows)` : "scripts/p75-inverted-fp.ts (live measurement)",
      n, nNull: shownNNull, trials: shownTrials, maxSectors: shownMaxSectors, seed: shownSeed, fapBar: FAP_BAR, searchMaxDays: shownSearchMax, padFrac: shownPad,
      measuredAt,
      data: REPLAY
        ? "FROZEN snapshot of real TESS-SPOC INVERTED light curves (flux reflected about median), all catalogued planets masked, single sector (exact ephemeris), token-free public S3 -- the live sample as measured, replayed offline"
        : "real TESS-SPOC INVERTED light curves (flux reflected about median), all catalogued planets masked, single sector (exact ephemeris), token-free public S3",
      note: "curves are inverted AND every catalogued planet is masked with its ground-truth ephemeris, so the strongest residual fold can only be noise/systematics -- a false-alarm sample; AR(1)-model gate FP rate vs model-free block-bootstrap FP rate on the SAME residual bumps; recovers P69 on a clean null; discoveryClaim false.",
      // Replay stamps the SCRIPT + the FROZEN rows (both tracked, so any clean checkout re-hashes them -> verified) --
      // deliberately NOT the live-catalog modules, so a NASA Archive update cannot mark this cited report stale and
      // force a re-measure that would move the number (the exact p90 failure mode). `--live` stamps the algorithm +
      // data modules instead, because there the live fetch IS the measurement.
      ...(REPLAY
        ? buildStamp(["scripts/p75-inverted-fp.ts", FROZEN])
        : buildStamp(["scripts/p75-inverted-fp.ts", "src/detect/invertedNull.ts", "src/detect/significance.ts", "src/detect/fap.ts", "src/detect/bls.ts", "src/detect/detrend.ts", "src/sim/redNoise.ts", "src/data/exoplanetArchive.ts", "src/data/mastS3.ts"])),
    },
    summary: { ar1FalseAlarms: ar1Fp, blockFalseAlarms: blockFp, n, ar1FpRate: ar1Fp / n, blockFpRate: blockFp / n, flips, meanDeltaFap: meanDelta, quiet: quiet.length, red: red.length, redFlips, quietFlips },
    verdict: ar1Over && bothPermissive ? "GATE-OPTIMISTIC-ON-REAL-NOISE" : ar1Over ? "MILD-AR1-OPTIMISM" : "GATE-CALIBRATED",
    safeToGate: false, discoveryClaim: false, rows,
  };
  writeFileSync("reports/p75-inverted-fp.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P75 inverted-curve false alarms: an empirical, model-free check on the AR(1) gate",
    "",
    REPLAY
      ? `Reproduce: \`npm run p75:inverted-fp\` replays the frozen rows offline; \`npm run p75:inverted-fp -- --live\` re-measures against the live Archive/S3 (and may move the numbers).`
      : `Reproduce: \`npm run p75:inverted-fp -- --targets ${wantTargets} --nnull ${shownNNull} --trials ${shownTrials} --maxsectors ${shownMaxSectors} --seed ${shownSeed}\``,
    REPLAY ? `This report is an OFFLINE REPLAY of the ${n} rows frozen on ${measuredAt}; the false-alarm rate is byte-stable across runs.` : "",
    "",
    "P69 flagged that its masked-residual comparison kept real sibling bumps. This study uses the external",
    "project's cleaner null: on a real TESS-SPOC sector INVERT the curve (dips become bumps), then MASK every",
    "catalogued planet (ground-truth ephemeris, window widened). Only a POSITIVE transit-like residual dip is",
    "kept -- a transit gate never reports a leftover bump -- so each sample is a pure-noise false-transit",
    "candidate, scored under the production AR(1) gate and a model-free block bootstrap on the SAME dip.",
    "",
    `| null | false alarms at FAP<${FAP_BAR} | rate |`,
    "|---|---|---|",
    `| AR(1)-model gate | ${ar1Fp}/${n} | ${(100 * ar1Fp / n).toFixed(0)}% (nominal 5%) |`,
    `| model-free block | ${blockFp}/${n} | ${(100 * blockFp / n).toFixed(0)}% |`,
    "",
    `AR(1) passes but model-free rejects: ${flips}/${n} (red ${redFlips}/${red.length}, quiet ${quietFlips}/${quiet.length}); mean FAP delta (block-AR1) ${meanDelta.toFixed(4)}.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Quantifies the existing gate's calibration on a model-free null; changes no threshold, touches no money path; discoveryClaim false.",
    "",
  ].join("\n");
  writeFileSync("reports/p75-inverted-fp.md", md);
  console.log("\nwrote reports/p75-inverted-fp.md and reports/p75-inverted-fp.json");
}

main().catch((e) => { console.error(`[p75] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
