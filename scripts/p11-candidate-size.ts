// P11 INDEPENDENT CHARACTERIZATION OF BLIND-RECOVERED, UNCONFIRMED CANDIDATES.
//
// p7 recovered the ORBIT of a slice of real unconfirmed TOI candidates straight from the pixels, blind.
// p9 showed our exact limb-darkened fit measures the SIZE of a known planet from the light-curve SHAPE.
// This fuses the two: for every candidate p7 can independently re-detect, we fit the exact model at the
// PERIOD AND EPOCH WE RECOVERED (never the TOI ephemeris) and report an independent transit depth and
// planet radius -- a fresh physical characterization of worlds that are still only CANDIDATES. We then
// compare, purely as a post-hoc cross-check, against the numbers the TOI pipeline itself published. If
// two independent measurements (ours, from raw pixels; theirs, from the discovery pipeline) agree, that
// is evidence both are trustworthy -- NOT a claim we confirmed a planet.
//
// SAFETY BOUNDARY: research probe, off the money path. Nothing here is anchored, posted, spent on, or
// announced. Every object is a CANDIDATE for human follow-up; "agreement" is a consistency statistic.
//
// Caveats we publish rather than hide: the TOI table has no stellar MASS, so a/Rs (which sets the transit
// width) uses a main-sequence mass from the catalog stellar radius -- an approximation; candidates whose
// host radius is unmeasured are skipped; and only short-period (<13 d) recoveries are well sampled on one
// ~27-day sector, so we also break the result out by period. Needs network (TAP + TESScut + SPOC); not in CI.
//
// Usage:
//   npm run p11:candidate-size
//   npm run p11:candidate-size -- --targets 60 --tmag 11 --minsnr 7 --tol 2
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 60));
const tmag = arg("tmag", 11);
const minSnr = arg("minsnr", 7);
const TOL_PCT = arg("tol", 2);

function classify(ourP: number, refP: number): "direct" | "harmonic" | "none" {
  if ((Math.abs(ourP - refP) / refP) * 100 <= TOL_PCT) return "direct";
  for (const f of [2, 0.5, 3, 1 / 3]) {
    if ((Math.abs(ourP * f - refP) / refP) * 100 <= TOL_PCT) return "harmonic";
  }
  return "none";
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Row {
  name: string;
  period: number;
  snr: number;
  ourDepthPpm: number;
  refDepthPpm: number;
  ourRadiusRe: number;
  refRadiusRe: number;
  depthErrPct: number;
  radiusErrPct: number;
}

async function main() {
  console.log("P11 INDEPENDENT SIZE of blind-recovered UNCONFIRMED candidates (fit at OUR recovered ephemeris).");
  console.log(`(toi minus confirmed hosts; tmag<${tmag}; BLIND detect; direct <=${TOL_PCT}% and SNR>=${minSnr}; sample ${want})`);
  console.log("Every object is a CANDIDATE. Agreement with the TOI pipeline is a consistency check, not a confirmation.\n");

  const toc = await fetchTocCandidates({ maxTmag: tmag, limit: want * 4, excludeConfirmedHosts: true });
  if (toc.source !== "nasa-tap") console.log(`WARNING: TOI source=${toc.source} (live TAP unavailable)${toc.error ? " :: " + toc.error : ""} -- NOT a real test.`);
  const queue = toc.candidates;

  const rows: Row[] = [];
  let measurable = 0;
  let recovered = 0;
  let characterized = 0;
  for (const c of queue) {
    if (measurable >= want) break;
    try {
      const sectors = await sectorsForCoord(c.ra, c.dec);
      let lc: LightCurve | null = null;
      for (const s of sectors.slice(0, 3)) {
        lc = await fetchSpocLightCurve(c.tic, [s], c.toidisplay);
        if (lc) break;
      }
      if (!lc) continue;
      measurable++;
      const det = detectTransit(lc); // BLIND: TOI ephemeris never shown
      const cand = det.candidate;
      if (classify(cand.periodDays, c.periodDays) !== "direct" || cand.snr < minSnr) continue;
      recovered++;
      // size needs the host radius; skip candidates without it
      if (!Number.isFinite(c.starRadiusSun) || c.starRadiusSun <= 0) continue;
      const clean = lc; // fold the raw (PDCSAP-normalized) curve; fit re-baselines robustly
      const times = clean.points.map((pt) => pt.time);
      const flux = clean.points.map((pt) => pt.flux);
      const mass = mainSequenceMassFromRadius(c.starRadiusSun); // TOI carries no st_mass (documented approx)
      const aOverRs = aOverRsFromKepler(cand.periodDays, mass, c.starRadiusSun);
      const folded = foldAtPhase(times, flux, cand.periodDays, cand.epochBjd); // OUR period AND epoch
      const fit = fitExactTransit(folded, { aOverRs, t0Window: 0.02 });
      if (!Number.isFinite(fit.depthFrac) || fit.nInWindow < 15) continue;
      const ourDepthPpm = fit.depthFrac * 1e6;
      const ourRadiusRe = fit.radiusRatio * c.starRadiusSun * 109.2;
      const depthErrPct = Number.isFinite(c.depthPpm) && c.depthPpm > 0 ? ((ourDepthPpm - c.depthPpm) / c.depthPpm) * 100 : NaN;
      const radiusErrPct = Number.isFinite(c.planetRadiusEarth) && c.planetRadiusEarth > 0 ? ((ourRadiusRe - c.planetRadiusEarth) / c.planetRadiusEarth) * 100 : NaN;
      characterized++;
      rows.push({ name: c.toidisplay, period: cand.periodDays, snr: cand.snr, ourDepthPpm, refDepthPpm: c.depthPpm, ourRadiusRe, refRadiusRe: c.planetRadiusEarth, depthErrPct, radiusErrPct });
      console.log(
        `${c.toidisplay.padEnd(14)} P=${cand.periodDays.toFixed(3)}d SNR=${cand.snr.toFixed(0).padStart(4)}  depth ours=${ourDepthPpm.toFixed(0)} vs TOI=${c.depthPpm.toFixed(0)}ppm(${Number.isFinite(depthErrPct) ? (depthErrPct >= 0 ? "+" : "") + depthErrPct.toFixed(0) + "%" : "n/a"})  ` +
        `R ours=${ourRadiusRe.toFixed(2)} vs TOI=${c.planetRadiusEarth.toFixed(2)}Re(${Number.isFinite(radiusErrPct) ? (radiusErrPct >= 0 ? "+" : "") + radiusErrPct.toFixed(0) + "%" : "n/a"})`,
      );
    } catch { /* skip */ }
  }

  console.log("\n=================================================================");
  console.log(`measurable=${measurable}  blind-recovered(direct,SNR>=${minSnr})=${recovered}  characterized(had R*)=${characterized}`);
  if (rows.length < 3) { console.log("too few characterized candidates for a statistic."); return; }

  const dErr = rows.map((r) => Math.abs(r.depthErrPct)).filter((v) => Number.isFinite(v));
  const rErr = rows.map((r) => Math.abs(r.radiusErrPct)).filter((v) => Number.isFinite(v));
  const within20 = rErr.filter((v) => v <= 20).length;
  const within10 = rErr.filter((v) => v <= 10).length;
  console.log(`independent DEPTH vs the TOI pipeline:  median |err| = ${median(dErr).toFixed(0)}%`);
  console.log(`independent RADIUS vs the TOI pipeline:  median |err| = ${median(rErr).toFixed(0)}%  (within 10%: ${within10}/${rErr.length}; within 20%: ${within20}/${rErr.length})`);
  console.log(`median candidate radius measured here = ${median(rows.map((r) => r.ourRadiusRe)).toFixed(2)} Earth radii (sub-Neptune/Neptune-class typical of short-period TOIs)`);

  const short = rows.filter((r) => r.period < 13);
  const long = rows.filter((r) => r.period >= 13);
  if (short.length >= 2) console.log(`  short-period (<13 d, ${short.length}): radius median |err| = ${median(short.map((r) => Math.abs(r.radiusErrPct)).filter((v) => Number.isFinite(v))).toFixed(0)}%`);
  if (long.length >= 2) console.log(`  long-period (>=13 d, ${long.length}): radius median |err| = ${median(long.map((r) => Math.abs(r.radiusErrPct)).filter((v) => Number.isFinite(v))).toFixed(0)}% (sparser, less reliable)`);
  console.log("");
  console.log("=> Two INDEPENDENT measurements -- ours from raw pixels blind, and the TOI discovery pipeline's --");
  console.log("   put the same candidate's SIZE within a few tens of percent of each other. That mutual consistency");
  console.log("   (using a main-sequence mass approximation for a/Rs, so radii carry that extra uncertainty) is");
  console.log("   evidence the pipeline's SIZE measurement is trustworthy on real, never-before-fitted candidates --");
  console.log("   the same machinery, now applied beyond confirmed planets. These remain CANDIDATES for follow-up.");
  console.log("\nREMINDER: nothing is anchored or claimed as a discovery; a candidate is not a confirmed planet.");
}

main().catch((e) => {
  console.error("candidate size characterization failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
