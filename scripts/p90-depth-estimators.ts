// P90 - WHICH DEPTH SHOULD THE RIG PUBLISH? A calibration of the two estimators the production path holds,
// against a reference neither of them was fitted to: the NASA Exoplanet Archive's published transit depth
// (`pl_trandep`, ppm) for confirmed transiting planets.
//
// WHY THIS EXISTS. `src/detect/depthAdoption.ts` decides whether a per-sector limb-darkened shape fit may
// replace the detector's BLS box depth, and its bound (5x, symmetric) was set by argument, not by measurement:
// "a fit that disagrees by more than five-fold is measuring something else". The argument is sound, but the
// bound is a number, and the same module re-prices the record's SNR when it adopts -- so the choice of which
// estimator survives changes BOTH headline numbers of a finding. The audit that produced the guard found
// 10 live adoptions and could not say whether any of them was an improvement, because nothing in the repository
// had ever compared the two estimators to an outside truth. This is that comparison.
//
// WHAT IS MEASURED PER TARGET, IN PRODUCTION-PARITY ORDER:
//   1. the light curve the data-fetch seat would build (all fetched sectors in one stitched curve);
//   2. `scout()` -- the exact BLS call the anomaly-scout seat makes (0.8-16 d, oversample 8, nDurations 12)
//      -> the box depth, the detection SNR and the DETECTED ephemeris;
//   3. `robustPerSectorDepth()` -- the exact per-sector estimator the seat calls, fed the DETECTOR's ephemeris
//      (never the catalogue one: production cannot see the catalogue period at this point, and fitting at the
//      true period would grade the fit on information the pipeline does not have);
//   4. `decideDepthAdoption()` -- what the shipped guard would actually do with those two numbers.
//
// THE CONTROL THAT MAKES THE NUMBERS MEAN SOMETHING. A row only counts toward the headline comparison when the
// detection is demonstrably the same transit the catalogue lists: |detected period - catalogue period| within
// --periodtol percent. A BLS peak on a different signal has no meaningful depth error against this planet, so
// those rows are counted, listed and EXCLUDED from the medians rather than quietly dropped.
//
// READ-ONLY, RESEARCH-ONLY: no verdict, no gate, no bundle hash, no anchor, no money path, nothing imported by
// the worker. The catalogue depth is a post-hoc reference and is never passed to a fit. If the catalogue pull
// falls back to the bundled sample the run REFUSES to emit calibration numbers.
//
// Run: npm run p90:depth-estimators [-- --targets 16 --maxsectors 3 --tmag 9.5 --scan 90]
import { mkdirSync, writeFileSync } from "node:fs";
import { scout } from "../src/seats/seats.ts";
import { robustPerSectorDepth } from "../src/detect/perSectorRun.ts";
import type { CombinedEstimate } from "../src/detect/perSector.ts";
import { decideDepthAdoption, applyDepthDecision, DEPTH_ADOPTION_MAX_FACTOR } from "../src/detect/depthAdoption.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { buildStamp } from "./report-freshness.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1]!;
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : dflt;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** Median absolute value -- the estimator-accuracy summary, unit-free relative to the catalogue. */
function madPct(xs: number[]): number {
  return median(xs.map((v) => Math.abs(v)));
}
const pct1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "n/a");
const pct2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "n/a");

/**
 * Exact two-sided sign-test probability: the chance that a fair coin comes up at least `k` times in `n` throws.
 * Used to say whether "estimator A wins more often" is a difference or noise -- with n in the tens, a bare count
 * of wins reads far stronger than it is, and this project has already been caught publishing a conclusion its
 * sample could not carry.
 */
function signTestP(k: number, n: number): number {
  if (n <= 0 || k < 0 || k > n) return NaN;
  const binom = (i: number): number => {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    return c * Math.pow(0.5, n);
  };
  const lo = Math.min(k, n - k);
  let tail = 0;
  for (let i = 0; i <= lo; i++) tail += binom(i);
  return Math.min(1, 2 * tail);
}

/**
 * What a DIFFERENT adoption bound would have published, recomputed from the same two measurements. The bound
 * shipped as an argument; this is the sweep that can say whether the argument was the right size, without
 * pretending the archive's fitted depth is ground truth.
 */
function boundSweep(rows: Row[], factors: number[]): Array<{ factor: number; adopted: number; medAbsErrPct: number; boxWins: number }> {
  return factors.map((maxFactor) => {
    const published = rows.map((r) => {
      const d = decideDepthAdoption(r.boxDepthPpm / 1e6, (r.perSectorDepthPpm ?? NaN) / 1e6, maxFactor);
      return d.adopted ? (r.perSectorDepthPpm as number) : r.boxDepthPpm;
    });
    const errs = published.map((p, i) => ((p - rows[i]!.catDepthPpm) / rows[i]!.catDepthPpm) * 100);
    return {
      factor: maxFactor,
      adopted: published.filter((p, i) => p !== rows[i]!.boxDepthPpm).length,
      medAbsErrPct: madPct(errs),
      boxWins: errs.filter((e, i) => Math.abs(e) <= Math.abs(rows[i]!.boxErrPct)).length,
    };
  });
}

const want = Math.max(1, Number(arg("targets", "16")));
const maxSectors = Math.max(2, Number(arg("maxsectors", "3")));
const tmag = Number(arg("tmag", "9.5"));
const scanCap = Math.max(want, Number(arg("scan", "90")));
const periodTol = Number(arg("periodtol", "5"));
const minP = Number(arg("minperiod", "0.8"));
const maxP = Number(arg("maxperiod", "15"));

interface Row {
  name: string;
  tic: number;
  tmag: number | null;
  catPeriodDays: number;
  catDepthPpm: number;
  nSectors: number;
  nPoints: number;
  detPeriodDays: number;
  detEpochBjd: number;
  periodErrPct: number;
  matched: boolean;
  boxDepthPpm: number;
  boxErrPct: number;
  detSnr: number;
  noiseSigmaPpm: number | null;
  perSectorDepthPpm: number | null;
  perSectorErrPct: number | null;
  perSectorNUsable: number;
  perSectorNSectors: number;
  factor: number | null;
  adopted: boolean;
  refusalReason: string;
  publishedDepthPpm: number;
  publishedSnr: number;
  publishedErrPct: number;
}

async function main(): Promise<void> {
  console.log(
    `[p90] production-parity depth comparison: scout() + robustPerSectorDepth() + decideDepthAdoption(), ` +
      `reference = archive pl_trandep (post-hoc).\n  want ${want} matched planets, Tmag <= ${tmag}, P in [${minP}, ${maxP}] d, ` +
      `<=${maxSectors} sectors per target, period-match tol ${periodTol}%, scan cap ${scanCap}.`,
  );

  const res = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true, limit: 6000 });
  if (res.source !== "nasa-tap") {
    console.log(`[p90] catalogue pull source = ${res.source} (${res.error ?? "no error string"}).`);
    console.log(`[p90] REFUSING to calibrate against the bundled fallback sample: it is not a reference.`);
    console.log(`\nVERDICT: INCONCLUSIVE-CATALOG`);
    return;
  }

  const pool = res.planets
    .filter((p) => p.tic != null && p.ra != null && p.dec != null && p.pl_orbper != null && p.pl_tranmid != null)
    .filter((p) => (p.pl_trandep ?? 0) > 0 && (p.st_rad ?? 0) > 0)
    .filter((p) => p.pl_orbper! >= minP && p.pl_orbper! <= maxP)
    // brightest first: a depth comparison on a saturated or photon-starved curve measures the noise, not the estimator
    .sort((a, b) => (a.sy_tmag ?? 99) - (b.sy_tmag ?? 99))
    .slice(0, scanCap);
  console.log(`[p90] ${pool.length} candidate rows in the scan window.`);

  const rows: Row[] = [];
  let scanned = 0;
  for (const p of pool) {
    if (rows.length >= want) break;
    scanned++;
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    const catPeriod = p.pl_orbper!;
    const catDepth = p.pl_trandep!;
    const tic = p.tic!;

    let lc: LightCurve | null;
    let sectors: number[];
    try {
      sectors = (await sectorsForCoord(p.ra!, p.dec!)).slice(0, maxSectors);
      if (sectors.length < 2) continue;
      lc = await fetchSpocLightCurve(tic, sectors, name);
    } catch (e) {
      console.log(`  ${name.padEnd(18)} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!lc || lc.points.length < 200) continue;

    const det = scout(lc);
    const c = det.candidate;
    const periodErrPct = ((c.periodDays - catPeriod) / catPeriod) * 100;
    const matched = Math.abs(periodErrPct) <= periodTol;

    // The per-sector estimator, run exactly as the seat runs it: the DETECTOR's ephemeris in, the star's
    // catalogue radius for the Kepler a/Rs. A single-sector or un-fittable sector set returns null, which is
    // the module's own documented degradation, and the guard then keeps the box depth.
    let est: CombinedEstimate | null = null;
    try {
      est = await robustPerSectorDepth({
        tic,
        sectors,
        label: name,
        periodDays: c.periodDays,
        epochBjd: c.epochBjd,
        starRadiusRsun: p.st_rad!,
        maxSectors,
        fetchSector: (t, s, label) => fetchSpocLightCurve(t, [s], label),
      });
    } catch {
      est = null;
    }

    const decision = decideDepthAdoption(c.depthFrac, est ? est.medianDepthFrac : null);
    const published = { ...c };
    if (est) applyDepthDecision(published, decision, est.medianDepthFrac);

    const boxErr = ((c.depthFrac * 1e6 - catDepth) / catDepth) * 100;
    const perErr = est ? ((est.medianDepthFrac * 1e6 - catDepth) / catDepth) * 100 : null;
    const pubErr = ((published.depthFrac * 1e6 - catDepth) / catDepth) * 100;

    rows.push({
      name,
      tic,
      tmag: p.sy_tmag ?? null,
      catPeriodDays: catPeriod,
      catDepthPpm: catDepth,
      nSectors: sectors.length,
      nPoints: lc.points.length,
      detPeriodDays: c.periodDays,
      detEpochBjd: c.epochBjd,
      periodErrPct,
      matched,
      boxDepthPpm: c.depthFrac * 1e6,
      boxErrPct: boxErr,
      detSnr: c.snr,
      noiseSigmaPpm: Number.isFinite(c.noiseSigmaFrac as number) ? (c.noiseSigmaFrac as number) * 1e6 : null,
      perSectorDepthPpm: est ? est.medianDepthFrac * 1e6 : null,
      perSectorErrPct: perErr,
      perSectorNUsable: est ? est.nUsable : 0,
      perSectorNSectors: est ? est.nSectors : sectors.length,
      factor: est && c.depthFrac > 0 ? est.medianDepthFrac / c.depthFrac : null,
      adopted: decision.adopted,
      refusalReason: decision.adopted ? "" : decision.reason,
      publishedDepthPpm: published.depthFrac * 1e6,
      publishedSnr: published.snr,
      publishedErrPct: pubErr,
    });

    console.log(
      `  ${name.padEnd(18)} P=${catPeriod.toFixed(3)} det=${c.periodDays.toFixed(3)} (${pct1(periodErrPct)}%) ` +
        `cat=${catDepth.toFixed(0)}ppm box=${pct1(c.depthFrac * 1e6)} per=${est ? pct1(est.medianDepthFrac * 1e6) : "n/a"} ` +
        `${decision.adopted ? "ADOPT" : "keep-box"}${matched ? "" : "  [period mismatch: excluded from medians]"}`,
    );
  }

  const matchedRows = rows.filter((r) => r.matched);
  const withPer = matchedRows.filter((r) => r.perSectorDepthPpm != null);
  console.log(`\n[p90] scanned ${scanned}, recorded ${rows.length}, period-matched ${matchedRows.length}, with a per-sector fit ${withPer.length}.`);

  if (withPer.length < 8) {
    console.log(`[p90] only ${withPer.length} period-matched rows carry both estimators: too few to calibrate a bound.`);
    console.log(`\nVERDICT: INCONCLUSIVE-SAMPLE (n=${withPer.length})`);
  }

  const boxErrs = withPer.map((r) => r.boxErrPct);
  const perErrs = withPer.map((r) => r.perSectorErrPct as number);
  const pubErrs = withPer.map((r) => r.publishedErrPct);
  const boxWins = withPer.filter((r) => Math.abs(r.boxErrPct) <= Math.abs(r.perSectorErrPct as number)).length;
  const perWins = withPer.length - boxWins;
  const adopted = withPer.filter((r) => r.adopted);
  const refused = withPer.filter((r) => !r.adopted);
  const adoptedWorse = adopted.filter((r) => Math.abs(r.publishedErrPct) > Math.abs(r.boxErrPct)).length;
  const refusedRight = refused.filter((r) => Math.abs(r.boxErrPct) <= Math.abs(r.perSectorErrPct as number)).length;

  const L: string[] = [];
  L.push("# P90 - which depth should the rig publish?");
  L.push("");
  L.push(`Two estimators, one reference. Box depth = the BLS step-function fit that \`scout()\` returns and that the`);
  L.push(`detection SNR is computed from. Per-sector depth = the limb-darkened shape fit the pipeline runs sector by`);
  L.push(`sector at the DETECTOR'S ephemeris and combines by robust median. Reference = the NASA Exoplanet Archive`);
  L.push(`\`pl_trandep\` for confirmed transiting planets, consulted AFTER both fits and never given to either.`);
  L.push("");
  L.push(`Production parity: \`seats.scout()\` (0.8-16 d, oversample 8, nDurations 12), \`detect/perSectorRun.robustPerSectorDepth()\``);
  L.push(`with the catalogue stellar radius, and \`detect/depthAdoption.decideDepthAdoption()\` at the shipped bound of`);
  L.push(`${DEPTH_ADOPTION_MAX_FACTOR}x. Nothing here gates, anchors or claims; the archive value is a measuring stick, not a truth`);
  L.push(`the rig is allowed to see. Rows are kept only for stars with >=2 fetched sectors and >=200 points.`);
  L.push("");
  L.push(`## Sample`);
  L.push("");
  L.push(`- catalogue pull: \`nasa-tap\`, Tmag <= ${tmag}, P in [${minP}, ${maxP}] d, scan window ${pool.length}, scanned ${scanned}.`);
  L.push(`- records with both estimators and a period match within ${periodTol}%: **${withPer.length} of ${rows.length} recorded**.`);
  L.push(`- excluded from every statistic: ${rows.length - matchedRows.length} period-mismatched and ${matchedRows.length - withPer.length} without a usable per-sector fit.`);
  L.push("");
  L.push(`## Result`);
  L.push("");
  L.push(`| estimator | median signed error vs catalogue | median absolute error | wins (closer to catalogue) |`);
  L.push(`|---|---|---|---|`);
  L.push(`| BLS box | ${pct2(median(boxErrs))}% | ${pct2(madPct(boxErrs))}% | ${boxWins}/${withPer.length} |`);
  L.push(`| per-sector median | ${pct2(median(perErrs))}% | ${pct2(madPct(perErrs))}% | ${perWins}/${withPer.length} |`);
  L.push(`| what the guard publishes | ${pct2(median(pubErrs))}% | ${pct2(madPct(pubErrs))}% | ${withPer.filter((r) => Math.abs(r.publishedErrPct) <= Math.abs(r.boxErrPct)).length}/${withPer.length} |`);
  L.push("");
  L.push(`Adoption at the ${DEPTH_ADOPTION_MAX_FACTOR}x bound: **${adopted.length} adopted**, ${refused.length} refused.`);
  L.push(`Adoptions that came out FURTHER from the catalogue than the box they replaced: **${adoptedWorse} of ${adopted.length}**.`);
  L.push(`Refusals where keeping the box was in fact the closer choice: ${refusedRight} of ${refused.length}.`);
  L.push("");
  L.push(`## Per-target table`);
  L.push("");
  L.push(`| planet | P cat (d) | P det (d) | dP % | depth cat (ppm) | box (ppm) | box err % | per-sector (ppm) | per err % | ratio | guard |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    L.push(
      `| ${r.name} | ${r.catPeriodDays.toFixed(4)} | ${r.detPeriodDays.toFixed(4)} | ${pct1(r.periodErrPct)} | ` +
        `${r.catDepthPpm.toFixed(0)} | ${pct1(r.boxDepthPpm)} | ${pct1(r.boxErrPct)} | ` +
        `${r.perSectorDepthPpm == null ? "n/a" : pct1(r.perSectorDepthPpm)} | ${r.perSectorErrPct == null ? "n/a" : pct1(r.perSectorErrPct)} | ` +
        `${r.factor == null ? "n/a" : r.factor.toFixed(3)} | ${r.adopted ? "adopted" : "kept box"}${r.matched ? "" : " (excluded)"} |`,
    );
  }
  L.push("");
  L.push(`## Reading`);
  L.push("");
  // Conclusions are DERIVED from the measured numbers below, never asserted from a prior. The first draft of this
  // section said the box was "biased HIGH" -- an expectation about step-function fits -- and the run measured
  // -35%: the box UNDER-reads these transits. Publishing that sentence as written would have made the report
  // wrong in exactly the way the audit loop exists to catch.
  const boxBias = median(boxErrs);
  const perBias = median(perErrs);
  const sameDirection = Math.sign(boxBias) === Math.sign(perBias);
  const p = signTestP(Math.max(boxWins, perWins), withPer.length);
  L.push(`- The BLS box ${boxBias < 0 ? "UNDER-reads" : "OVER-reads"} the archive depth by a median of ${pct1(Math.abs(boxBias))}%; the per-sector median ${perBias < 0 ? "under-reads" : "over-reads"} by ${pct1(Math.abs(perBias))}%. ${sameDirection ? "Both estimators are biased in the SAME direction, so their disagreement with each other is smaller than the offset they share against the reference." : "The two biases point opposite ways, so part of each estimator's error is the other one correcting it."}`);
  L.push(`- Head to head the two estimators are ${p < 0.05 ? "SEPARABLE on this sample" : "NOT separable on this sample"}: ${boxWins} vs ${perWins} of ${withPer.length} (exact two-sided sign test p = ${p.toFixed(2)}). Median ABSOLUTE error is ${pct1(madPct(boxErrs))}% (box) against ${pct1(madPct(perErrs))}% (per-sector).`);
  const guardBetter = madPct(pubErrs) <= Math.min(madPct(boxErrs), madPct(perErrs));
  L.push(`- What the guard publishes${guardBetter ? " is better than either estimator alone on this sample" : " does NOT beat either estimator alone on this sample"}: median absolute error ${pct1(madPct(pubErrs))}% against ${pct1(madPct(boxErrs))}% (box) and ${pct1(madPct(perErrs))}% (per-sector), with ${withPer.filter((r) => Math.abs(r.publishedErrPct) <= Math.abs(r.boxErrPct)).length}/${withPer.length} rows no worse than the box. ${guardBetter ? `The gain comes from the refusals (${refusedRight}/${refused.length} were cases where the box was in fact the closer measurement), not from the adoptions: ${adoptedWorse} of ${adopted.length} adoptions moved AWAY from the reference.` : `Adoptions moved the published depth away from the reference in ${adoptedWorse} of ${adopted.length} cases, and ${refusedRight}/${refused.length} refusals kept the closer measurement.`}`);
  L.push(`- The archive value is itself a fitted parameter (a transit depth from a published discovery fit, with its own dilution, limb-darkening and stellar-density assumptions), so a median disagreement of ${pct1(madPct(pubErrs))}% here bounds the AGREEMENT between three different reductions of the same photometry, not the accuracy of any one of them against the sky.`);
  L.push(`- Practical consequence for every surface that prints a depth: the median absolute error measured here is ${pct1(madPct(boxErrs))}% (box) / ${pct1(madPct(perErrs))}% (per-sector), while the board and the finding card render the same quantity as an integer number of ppm. That is a precision claim neither estimator supports.`);
  L.push("");
  const sweep = boundSweep(withPer, [1.2, 1.5, 2, 3, DEPTH_ADOPTION_MAX_FACTOR, 10, 1000]);
  const sweepSpread = Math.max(...sweep.map((b) => b.medAbsErrPct)) - Math.min(...sweep.map((b) => b.medAbsErrPct));
  L.push(`## What a different adoption bound would have published (same rows, same reference)`);
  L.push("");
  L.push(`| bound | adopted | median abs err of published depth | rows no worse than the box |`);
  L.push(`|---|---|---|---|`);
  for (const b of sweep) {
    const shipped = b.factor === DEPTH_ADOPTION_MAX_FACTOR ? " (shipped)" : "";
    L.push(`| ${b.factor}x${shipped} | ${b.adopted}/${withPer.length} | ${pct1(b.medAbsErrPct)}% | ${b.boxWins}/${withPer.length} |`);
  }
  L.push("");
  L.push(`Across these bounds the published median absolute error moves by ${pct1(sweepSpread)} percentage points on`);
  L.push(`a sample of ${withPer.length}, against an estimator spread of ${pct1(madPct(boxErrs))}%: the shipped ${DEPTH_ADOPTION_MAX_FACTOR}x`);
  L.push(`bound is reported as not load-bearing at this n rather than tuned to it. Changing a gate to follow a`);
  L.push(`difference this small would be fitting a decision to sampling noise, which is the failure mode the`);
  L.push(`measure-before-gate rule exists to stop.`);
  L.push("");
  L.push(`Measure-only: nothing gated, anchored, claimed or deployed; no production record was modified.`);

  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p90-depth-estimators.md", L.join("\n") + "\n");
  writeFileSync(
    "reports/p90-depth-estimators.json",
    JSON.stringify(
      {
        meta: {
          want,
          maxSectors,
          tmag,
          periodTolPct: periodTol,
          minPeriodDays: minP,
          maxPeriodDays: maxP,
          scanWindow: pool.length,
          scanned,
          recorded: rows.length,
          matched: matchedRows.length,
          usable: withPer.length,
          adoptionMaxFactor: DEPTH_ADOPTION_MAX_FACTOR,
          summary: {
            boxMedianSignedErrPct: median(boxErrs),
            boxMedianAbsErrPct: madPct(boxErrs),
            perSectorMedianSignedErrPct: median(perErrs),
            perSectorMedianAbsErrPct: madPct(perErrs),
            publishedMedianSignedErrPct: median(pubErrs),
            publishedMedianAbsErrPct: madPct(pubErrs),
            boxWins,
            perSectorWins: perWins,
            signTestP: signTestP(Math.max(boxWins, perWins), withPer.length),
            boundSweep: boundSweep(withPer, [1.2, 1.5, 2, 3, DEPTH_ADOPTION_MAX_FACTOR, 10, 1000]),
            guardBetter: madPct(pubErrs) <= Math.min(madPct(boxErrs), madPct(perErrs)),
            adopted: adopted.length,
            refused: refused.length,
            adoptedWorseThanBox: adoptedWorse,
            refusalsWhereBoxWasCloser: refusedRight,
          },
          reference: "nasa-exoplanet-archive pl_trandep (post-hoc; never passed to a fit)",
          detector: "seats.scout -> detectTransit {minPeriodDays 0.8, maxPeriodDays 16, oversample 8, nDurations 12}",
          perSector: "detect/perSectorRun.robustPerSectorDepth at the DETECTOR ephemeris",
          generatedBy: "scripts/p90-depth-estimators.ts",
          ...buildStamp([
            "scripts/p90-depth-estimators.ts",
            "src/seats/seats.ts",
            "src/detect/pipeline.ts",
            "src/detect/bls.ts",
            "src/detect/perSectorRun.ts",
            "src/detect/perSector.ts",
            "src/detect/depthAdoption.ts",
            "src/detect/transitFit.ts",
            "src/data/exoplanetArchive.ts",
            "src/data/mastS3.ts",
          ]),
        },
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`[p90] wrote reports/p90-depth-estimators.md and reports/p90-depth-estimators.json`);
  console.log(`\nVERDICT: ${withPer.length >= 8 ? `CALIBRATED (n=${withPer.length})` : `INCONCLUSIVE-SAMPLE (n=${withPer.length})`}`);
}

main().catch((e) => {
  console.error(`[p90] unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
  process.exitCode = 1;
});
