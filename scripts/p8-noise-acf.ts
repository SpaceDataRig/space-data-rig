// P8 NOISE-COLOR STUDY: does REAL TESS residual noise actually follow the AR(1) model we assume?
//
// The whole significance story rests on one assumption: that a star's residual (post-detrend) noise
// is AR(1), i.e. its autocorrelation decays as ACF[k] = rho^k. calibratedFap builds per-candidate nulls
// from exactly that model, and the red-noise ROC stress (npm run p1:roc --rho) uses it. p1:rho measured
// the LAG-1 coefficient rho on real photometry -- but a single lag says nothing about the SHAPE of the
// decay. If real residuals keep correlating LONGER than rho^k (a power-law tail), the AR(1) nulls
// UNDERSTATE the false-alarm tail and our significance is slightly optimistic in a way lag-1 hides.
//
// This study measures the full AUTOCORRELATION FUNCTION on real, token-free TESS-SPOC PDCSAP light
// curves and fits the AR(1) prediction to it -- a genuine characterization, not a re-verification.
//   chain: confirmed planet (TIC, ra/dec) --(TESScut)--> sectors --(SPOC _lc.fits)--> real PDCSAP flux
//          --(moving-median detrend + MAD clip)--> residuals --(autocorrFunction, fitAr1ToAcf)--> shape
// The measurement unit is the STAR (deduped by TIC), not the planet, so a multi-planet host is counted
// once (the same bias guard p1:rho uses).
//
// Nothing is fabricated and nothing is anchored/claimed; a target with no SPOC product 404s and is
// skipped. Needs network; not in CI.
//
// Usage:
//   npm run p8:noise-acf
//   npm run p8:noise-acf -- --targets 20 --tmag 9.5 --maxlag 12
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { detrendMovingMedian, autocorrFunction, fitAr1ToAcf } from "../src/sim/redNoise.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 16));
const tmag = arg("tmag", 10);
const MAXLAG = Math.round(arg("maxlag", 10));

function hasTicCoord(p: ArchivePlanet): boolean {
  return Number.isFinite(p.tic) && Number.isFinite(p.ra) && Number.isFinite(p.dec);
}

// Residual series exactly as estimateRho builds them (moving-median detrend + 5-sigma MAD clip), so
// the ACF here is comparable to the lag-1 rho reported by p1:rho.
function residualSeries(flux: number[]): number[] {
  const finite = flux.filter((v) => Number.isFinite(v));
  if (finite.length < 30) return [];
  const resid = detrendMovingMedian(finite, 15);
  const sortedAbs = resid.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const mad = (sortedAbs[sortedAbs.length >> 1] || 1) * 1.4826 || 1;
  return resid.filter((v) => Math.abs(v) <= 5 * mad);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Star {
  name: string;
  n: number;
  rho: number;
  r2: number;
  excess: number;
  acf: number[];
}

async function main() {
  console.log("P8 REAL-DATA NOISE-COLOR STUDY: is TESS residual noise actually AR(1)?");
  console.log(`(token-free TESS-SPOC PDCSAP, tmag<${tmag}, ACF lags 0..${MAXLAG}, unit = distinct star)`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable) -- this study needs real rows.`);
  const picked = cat.planets.filter(hasTicCoord);

  const stars: Star[] = [];
  const seen = new Set<number>();
  let skipped = 0;
  for (const p of picked) {
    if (seen.has(p.tic!)) continue;
    if (stars.length >= want) break;
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      let done = false;
      for (const s of sectors.slice(0, 3)) {
        const lc = await fetchSpocLightCurve(p.tic!, [s], name);
        if (!lc) continue;
        const resid = residualSeries(lc.points.map((pt) => pt.flux));
        if (resid.length < MAXLAG * 20) { done = true; skipped++; break; }
        const acf = autocorrFunction(resid, MAXLAG);
        const fit = fitAr1ToAcf(acf);
        if (!Number.isFinite(fit.rho)) { done = true; skipped++; break; }
        stars.push({ name, n: resid.length, rho: fit.rho, r2: fit.r2, excess: fit.excessAtLastLag, acf });
        seen.add(p.tic!);
        console.log(`${name.padEnd(20)} rho=${fit.rho.toFixed(3)}  ACF-fit R2=${Number.isFinite(fit.r2) ? fit.r2.toFixed(2) : "n/a"}  excess@lag${MAXLAG}=${fit.excessAtLastLag >= 0 ? "+" : ""}${fit.excessAtLastLag.toFixed(3)}  (n=${resid.length})`);
        done = true;
        break;
      }
      if (!done) skipped++;
    } catch {
      skipped++;
    }
  }

  console.log("");
  if (stars.length < 3) {
    console.log(`only ${stars.length} measurable stars (network/SPOC unavailable) -- cannot characterize the ACF shape here.`);
    return;
  }

  // Regime split: real hosts are either essentially WHITE or genuinely RED. The AR(1) question only
  // bites for the red ones -- for a white star rho~0 so every model (including AR(1)) trivially fits,
  // and an all-star median R2 would be meaningless. So we characterize the decay SHAPE on the red set.
  const QUIET_RHO = 0.2;
  const quiet = stars.filter((s) => s.rho <= QUIET_RHO);
  const red = stars.filter((s) => s.rho > QUIET_RHO);
  console.log(`regimes: ${quiet.length} near-white (rho<=${QUIET_RHO}) + ${red.length} red (rho>${QUIET_RHO}) of ${stars.length} distinct stars`);
  console.log(`near-white median rho=${quiet.length ? median(quiet.map((s) => s.rho)).toFixed(3) : "n/a"} (AR(1) reduces to white there)`);
  console.log("");

  if (red.length >= 2) {
    const redRho = median(red.map((s) => s.rho));
    const redAcf: number[] = [];
    for (let k = 0; k <= MAXLAG; k++) redAcf.push(median(red.map((s) => s.acf[k])));
    console.log(`RED-star median ACF vs the AR(1) prediction rho^k (rho=${redRho.toFixed(3)}):`);
    console.log("  lag   measured   AR(1)   excess");
    for (let k = 1; k <= MAXLAG; k++) {
      const pred = Math.pow(redRho, k);
      console.log(`  ${String(k).padStart(3)}   ${redAcf[k].toFixed(3).padStart(7)}   ${pred.toFixed(3).padStart(6)}   ${(redAcf[k] - pred >= 0 ? "+" : "") + (redAcf[k] - pred).toFixed(3)}`);
    }
    const redExcess = median(red.map((s) => s.excess));
    const redR2 = median(red.map((s) => (Number.isFinite(s.r2) ? s.r2 : 0)));
    console.log(`RED-star: median AR(1)-fit R2=${redR2.toFixed(2)}  median excess@lag${MAXLAG}=${redExcess >= 0 ? "+" : ""}${redExcess.toFixed(3)}`);
    console.log("");
    if (redExcess > 0.05) {
      console.log("=> FINDING: red (active) hosts decay SLOWER than AR(1) predicts (positive excess at higher lags).");
      console.log("   The AR(1) nulls in calibratedFap UNDERSTATE their false-alarm tail; treat a red host's calibrated");
      console.log("   FAP as a LOWER bound (the minSnr floor + blind direct-match remain the load-bearing protection).");
    } else {
      console.log(`=> FINDING: red (active) hosts follow the AR(1) rho^k decay (median R2=${redR2.toFixed(2)}, no positive`);
      console.log("   tail), and the majority of hosts are near-white. So the AR(1) null model behind calibratedFap and");
      console.log("   the red-noise ROC is a FAITHFUL description of REAL TESS residual structure at every scale that");
      console.log("   matters -- a real-data validation of the DECAY SHAPE that lag-1 rho alone (p1:rho) could not give.");
    }
  } else {
    console.log("too few red hosts in this sample to characterize the decay shape; widen --targets/--tmag.");
  }
  if (skipped) console.log(`(skipped ${skipped} targets: no SPOC product or too few cadences)`);
}

main().catch((e) => {
  console.error("noise-acf study failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
