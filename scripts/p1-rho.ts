// P1 checkpoint: MEASURE the real noise color (lag-1 autocorrelation, AR(1) rho) of TESS photometry.
//
// Why: the completeness/purity ROC (npm run p1:roc) reports two operating curves -- white noise and
// an AR(1) stress at rho=0.5 -- and under red noise the false-alarm rate at our SNR>=7 cut jumps a
// lot. But is rho=0.5 realistic, or a pessimism bound? We must NOT set a money-path detection
// threshold from a synthetic assumption (same discipline that kept the odd/even discriminator off the
// gate until real calibration). So we measure rho directly from REAL, token-free TESS-SPOC PDCSAP
// light curves and let the data pick the noise color -- and hence the honest threshold.
//
// Chain (all token-free): confirmed planet (TIC, ra/dec) --(TESScut)--> sectors --(SPOC _lc.fits)-->
// real PDCSAP flux --(estimateRho: moving-median detrend + MAD clip + lag-1 autocorr)--> rho.
// Nothing is fabricated; a target with no SPOC product 404s and is skipped.
//
// Usage:
//   npm run p1:rho                          (sample of bright TIC planets)
//   npm run p1:rho -- --targets 16 --tmag 9.5
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { estimateRho } from "../src/sim/redNoise.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 10));
const tmag = arg("tmag", 10);

function hasTicCoord(p: ArchivePlanet): boolean {
  return Number.isFinite(p.tic) && Number.isFinite(p.ra) && Number.isFinite(p.dec);
}

async function main() {
  console.log(`P1 noise-color measurement on REAL TESS-SPOC photometry (sample of confirmed planets, tmag<${tmag})`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") {
    console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable) -- this check needs real rows.`);
  }
  const picked = cat.planets.filter(hasTicCoord).slice(0, want);
  console.log(`queued ${picked.length} TIC planets from ${cat.planets.length} catalog rows`);
  console.log("");

  const rhos: { name: string; tic: number; sector: number; rho: number; n: number }[] = [];
  const skipped: { name: string; why: string }[] = [];
  const measuredStars = new Set<number>(); // ONE rho per distinct light curve (star), not per planet:
  // multi-planet systems share a single host light curve, so counting each planet would over-weight
  // whichever star happens to host several known planets and bias the distribution.

  for (const p of picked) {
    if (measuredStars.has(p.tic!)) continue;
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      let done = false;
      for (const s of sectors.slice(0, 3)) {
        const lc = await fetchSpocLightCurve(p.tic!, [s], name);
        if (!lc) continue;
        const flux = lc.points.map((pt) => pt.flux);
        const rho = estimateRho(flux);
        if (!Number.isFinite(rho)) {
          skipped.push({ name, why: `sector ${s}: too few usable cadences after detrend/clip (${flux.length} raw)` });
          done = true;
          break;
        }
        rhos.push({ name, tic: p.tic!, sector: s, rho, n: flux.length });
        measuredStars.add(p.tic!);
        console.log(`${name.padEnd(20)} TIC ${p.tic} s${s}: rho=${rho.toFixed(3)} (n=${flux.length} cadences)`);
        done = true;
        break;
      }
      if (!done) skipped.push({ name, why: "no SPOC light-curve product in any covering sector" });
    } catch (e) {
      skipped.push({ name, why: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("");
  if (rhos.length === 0) {
    console.log("no measurable rho (network/SPOC unavailable) -- cannot characterize noise color here.");
    return;
  }

  const xs = rhos.map((r) => r.rho).sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const med = q(xs, 0.5);
  const mx = xs[xs.length - 1];
  console.log(`measured residual lag-1 autocorrelation on ${xs.length} DISTINCT real SPOC light curves (deduped by star):`);
  console.log(`  rho: min=${xs[0].toFixed(3)}  median=${med.toFixed(3)}  p90=${q(xs, 0.9).toFixed(3)}  max=${mx.toFixed(3)}  mean=${mean.toFixed(3)}`);

  // Interpret against the ROC benchmark's AR(1) stress (rho=0.5), distinguishing TYPICAL from WORST.
  const stress = 0.5;
  console.log("");
  if (med <= 0.1) {
    console.log(`=> TYPICAL real PDCSAP light curves are near-WHITE (median rho=${med.toFixed(2)}): the white-noise FAR is a fair`);
    console.log(`   description for quiet, old hosts -- SNR>=7 is defensible there.`);
  } else {
    console.log(`=> TYPICAL real light curves ARE correlated (median rho=${med.toFixed(2)}): quote the operating curve at that color, not white.`);
  }
  if (mx >= 0.3) {
    console.log(`=> But the WORST hosts reach rho=${mx.toFixed(2)} (young/active stars with genuine variability + systematics) -- there the`);
    console.log(`   white-noise FAR IS optimistic; a red-noise cut (SNR>=~9 at rho~${stress}) applies. One global threshold is imperfect:`);
    console.log(`   noise color varies star-to-star, so the principled fix is per-candidate (estimate rho from each target's own light curve).`);
  } else {
    console.log(`=> Worst host in this sample is only rho=${mx.toFixed(2)}; the rho=${stress} stress ROC is a conservative upper bound here.`);
  }
  console.log("(next: feed this measured rho back into runRoc so the published completeness/purity uses real noise color, not a guess.)");
  if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.name} (${s.why})`).join("; ")}${skipped.length > 5 ? " ..." : ""}`);
}

main().catch((e) => {
  console.error("rho measurement failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
