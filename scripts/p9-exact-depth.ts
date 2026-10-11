// P9 EXACT-TRANSIT DEPTH CROSS-VALIDATION: on REAL confirmed planets, does fitting the exact
// limb-darkened transit model recover the catalog depth better than the BLS box depth does?
//
// The blind TOI survey (p7) honestly reported that the BLS box DEPTH is a crude proxy -- a median
// ~26% off the reported depth -- and that "depth needs the exact-transit model fit, a separate
// step." This script IS that step, and it validates the upgrade against ground truth. For each
// confirmed transiting planet with a token-free TESS-SPOC light curve AND a measured stellar radius
// (so a/Rs follows from Kepler):
//   1. fold the REAL photometry at the catalog period and epoch;
//   2. fit the exact quadratic limb-darkened occultation model (src/detect/transitFit.ts) over
//      (radius ratio p, impact parameter b, a small timing offset), with a/Rs fixed from Kepler;
//   3. compare the fitted depth to the catalog pl_trandep;
//   4. run BLS on a narrow grid AT the same period and compare the box depth the same way.
// Both estimators see the same curve, so the comparison is apples-to-apples. The catalog depth is
// used ONLY as a post-hoc reference to score the estimator -- it never enters the fit.
//
// SAFETY BOUNDARY: research probe, not an announcement machine. Nothing is anchored, posted, spent
// on, or claimed. This validates a measurement METHOD on planets that are already confirmed.
//
// Needs network (Archive TAP + TESScut + SPOC); not in CI. Offline it degrades to the labeled
// fallback and says so.
//
// Usage:
//   npm run p9:exact-depth
//   npm run p9:exact-depth -- --targets 24 --tmag 9.5
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import type { ArchivePlanet, LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 24));
const tmag = arg("tmag", 9.5);

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function usable(p: ArchivePlanet): boolean {
  return (
    Number.isFinite(p.tic!) && Number.isFinite(p.ra) && Number.isFinite(p.dec) &&
    Number.isFinite(p.pl_orbper!) && p.pl_orbper! > 0 &&
    Number.isFinite(p.pl_tranmid!) && Number.isFinite(p.pl_trandep!) && p.pl_trandep! > 0 &&
    Number.isFinite(p.st_rad!) && p.st_rad! > 0
  );
}

interface Row {
  name: string;
  period: number;
  catDepthPpm: number;
  exactDepthPpm: number;
  boxDepthPpm: number;
  aOverRs: number;
  impactParam: number;
  nInWindow: number;
  depthSigmaPpm: number; // first-order statistical 1-sigma on the exact-fit depth
  fitErrPct: number; // signed (exact - catalog)/catalog * 100
  boxErrPct: number; // signed (box - catalog)/catalog * 100
}

async function main() {
  console.log("P9 EXACT-TRANSIT DEPTH CROSS-VALIDATION on real confirmed planets.");
  console.log(`(token-free TESS-SPOC; a/Rs from Kepler + catalog R*/M*; exact-model fit vs BLS box vs catalog depth)`);
  console.log(`sample ${want} planets, tmag<${tmag}. Catalog depth is a POST-HOC reference only -- never shown to the fit.\n`);

  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") {
    console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable) -- using labeled fallback; NOT a real cross-validation.`);
  }
  const picked = cat.planets.filter(usable);

  const lcCache = new Map<number, LightCurve | null>();
  async function lcFor(p: ArchivePlanet): Promise<LightCurve | null> {
    const tic = p.tic!;
    if (lcCache.has(tic)) return lcCache.get(tic)!;
    let lc: LightCurve | null = null;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      for (const s of sectors.slice(0, 3)) {
        lc = await fetchSpocLightCurve(tic, [s], p.pl_name ?? p.hostname ?? `TIC ${tic}`);
        if (lc) break;
      }
    } catch { /* leave null */ }
    lcCache.set(tic, lc);
    return lc;
  }

  const rows: Row[] = [];
  let tried = 0;
  let skipped = 0;
  for (const p of picked) {
    if (tried >= want) break;
    const lc = await lcFor(p);
    if (!lc) { skipped++; continue; }
    tried++;
    const period = p.pl_orbper!;
    const clean = preprocess(lc, 0.5);
    const times = clean.points.map((pt) => pt.time);
    const flux = clean.points.map((pt) => pt.flux);

    const mass = Number.isFinite(p.st_mass!) ? p.st_mass! : mainSequenceMassFromRadius(p.st_rad!);
    const aOverRs = aOverRsFromKepler(period, mass, p.st_rad!);
    if (!Number.isFinite(aOverRs) || aOverRs <= 1) { skipped++; continue; }

    // exact-model fit at the catalog ephemeris (timing offset absorbs small epoch error)
    const folded = foldAtPhase(times, flux, period, p.pl_tranmid!);
    const fit = fitExactTransit(folded, { aOverRs, t0Window: 0.02 });
    if (!Number.isFinite(fit.depthFrac)) { skipped++; continue; }

    // BLS box depth on a NARROW grid at the same true period -- the estimator p7 actually shipped
    const narrow = bls(clean, { minPeriodDays: period * 0.97, maxPeriodDays: period * 1.03, oversample: 12, nDurations: 10 });

    const catFrac = p.pl_trandep! / 1e6;
    const exactPpm = fit.depthFrac * 1e6;
    const boxPpm = narrow.depth * 1e6;
    const fitErrPct = ((fit.depthFrac - catFrac) / catFrac) * 100;
    const boxErrPct = ((narrow.depth - catFrac) / catFrac) * 100;
    rows.push({
      name: p.pl_name ?? `TIC ${p.tic}`, period, catDepthPpm: p.pl_trandep!,
      exactDepthPpm: exactPpm, boxDepthPpm: boxPpm, aOverRs, impactParam: fit.impactParam,
      nInWindow: fit.nInWindow, depthSigmaPpm: fit.depthSigma * 1e6, fitErrPct, boxErrPct,
    });
    console.log(
      `${(p.pl_name ?? `TIC ${p.tic}`).padEnd(16)} P=${period.toFixed(4)}d a/Rs=${aOverRs.toFixed(1)} b=${fit.impactParam.toFixed(2)} nin=${fit.nInWindow}  ` +
      `catalog=${p.pl_trandep!.toFixed(0)}ppm exact=${exactPpm.toFixed(0)}+-${(fit.depthSigma * 1e6).toFixed(0)}(${fitErrPct >= 0 ? "+" : ""}${fitErrPct.toFixed(0)}%) ` +
      `box=${boxPpm.toFixed(0)}(${boxErrPct >= 0 ? "+" : ""}${boxErrPct.toFixed(0)}%)`,
    );
  }

  console.log("\n=================================================================");
  if (rows.length < 3) {
    console.log(`only ${rows.length} measurable planets (network/SPOC/params) -- cannot compare estimators here.`);
    return;
  }
  const absFit = rows.map((r) => Math.abs(r.fitErrPct));
  const absBox = rows.map((r) => Math.abs(r.boxErrPct));
  const medAbsFit = median(absFit);
  const medAbsBox = median(absBox);
  const biasFit = median(rows.map((r) => r.fitErrPct));
  const biasBox = median(rows.map((r) => r.boxErrPct));
  console.log(`measurable: ${rows.length} confirmed planets   (skipped, unmeasurable: ${skipped})`);
  console.log(`EXACT-model depth vs catalog:  median |error| = ${medAbsFit.toFixed(1)}%   median signed = ${biasFit >= 0 ? "+" : ""}${biasFit.toFixed(1)}%`);
  console.log(`BLS box      depth vs catalog:  median |error| = ${medAbsBox.toFixed(1)}%   median signed = ${biasBox >= 0 ? "+" : ""}${biasBox.toFixed(1)}%`);
  // how often does the exact fit beat the box on the SAME planet?
  const wins = rows.filter((r) => Math.abs(r.fitErrPct) < Math.abs(r.boxErrPct)).length;
  console.log(`exact fit closer than box on ${wins}/${rows.length} planets (${((wins / rows.length) * 100).toFixed(0)}%)`);
  // the box can return an unphysical non-positive depth when it latches onto noise on sparse signals
  const boxUnphysical = rows.filter((r) => r.boxDepthPpm <= 0).length;
  const exactUnphysical = rows.filter((r) => r.exactDepthPpm <= 0).length;
  console.log(`unphysical (<=0 ppm) depths: box ${boxUnphysical}, exact-model ${exactUnphysical} (the forward model is bounded >= 0)`);
  // empirical coverage: how often does the catalog depth land inside the fit's statistical +/-1sigma
  // (and +/-2sigma)? A well-calibrated POINT error would contain ~68% at 1sigma; a shortfall means the
  // statistical sigma UNDERSTATES the true error -- i.e. systematics (limb darkening, ephemeris, stellar
  // variability) dominate the residual, an honest caveat we publish rather than hide.
  const cov1 = rows.filter((r) => Math.abs(r.exactDepthPpm - r.catDepthPpm) <= r.depthSigmaPpm).length;
  const cov2 = rows.filter((r) => Math.abs(r.exactDepthPpm - r.catDepthPpm) <= 2 * r.depthSigmaPpm).length;
  const medSigFrac = median(rows.map((r) => (r.depthSigmaPpm / r.catDepthPpm) * 100));
  console.log(`depth 1-sigma coverage: ${cov1}/${rows.length} = ${((cov1 / rows.length) * 100).toFixed(0)}% (calibrated ~68%); 2-sigma: ${cov2}/${rows.length} = ${((cov2 / rows.length) * 100).toFixed(0)}% (calibrated ~95%)`);
  console.log(`median statistical sigma = ${medSigFrac.toFixed(1)}% of depth`);
  // split by period: short periods fold many transits per sector (shape well-constrained), long periods
  // see one or two (p-b shape degenerate, blending/activity dominates) -- the same single-sector cliff p7 hit.
  const shortP = rows.filter((r) => r.period < 13);
  const longP = rows.filter((r) => r.period >= 13);
  if (shortP.length >= 2) {
    console.log(`\nshort-period (<13 d, ${shortP.length} planets, many transits per sector):`);
    console.log(`  exact median |err| = ${median(shortP.map((r) => Math.abs(r.fitErrPct))).toFixed(1)}%   box median |err| = ${median(shortP.map((r) => Math.abs(r.boxErrPct))).toFixed(1)}%`);
  }
  if (longP.length >= 2) {
    console.log(`long-period (>=13 d, ${longP.length} planets, one/two transits per sector):`);
    console.log(`  exact median |err| = ${median(longP.map((r) => Math.abs(r.fitErrPct))).toFixed(1)}%   box median |err| = ${median(longP.map((r) => Math.abs(r.boxErrPct))).toFixed(1)}%  (both degrade: sparse shape + activity/blending)`);
  }
  console.log("");
  if (medAbsFit < medAbsBox) {
    console.log(`=> FINDING: the exact limb-darkened fit recovers the catalog depth more faithfully than the`);
    console.log(`   BLS box (median |error| ${medAbsFit.toFixed(1)}% vs ${medAbsBox.toFixed(1)}%), and the box's`);
    console.log(`   signed median (${biasBox >= 0 ? "+" : ""}${biasBox.toFixed(1)}%) shows the dilution bias a box average`);
    console.log(`   introduces -- exactly the crude-proxy limit p7 flagged, now quantified and repaired by a method`);
    console.log(`   that models the transit SHAPE. Depth is the validated quantity; the fitted impact parameter b`);
    console.log(`   is reported for shape context (we did not fetch catalog b, so it is NOT scored here).`);
    console.log(`   HONEST LIMIT: on long-period (>=13 d) and/or magnetically active hosts both estimators degrade`);
    console.log(`   badly (one/two transits per sector leave the p-b shape degenerate; flares/spots/blends corrupt`);
    console.log(`   the fold) -- the exact fit wins on the median but is NOT trustworthy in that regime.`);
  } else {
    console.log(`=> FINDING: on this sample the box and exact-fit depths are comparable (median |error| `);
    console.log(`   ${medAbsFit.toFixed(1)}% vs ${medAbsBox.toFixed(1)}%); the box is not systematically worse here.`);
    console.log(`   Report as-is: the exact fit adds a shape (b) constraint but did not beat the box on depth.`);
  }
  console.log("\nREMINDER: this validates a measurement METHOD on already-confirmed planets. Nothing is anchored or claimed as a discovery.");
}

main().catch((e) => {
  console.error("exact-depth cross-validation failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
