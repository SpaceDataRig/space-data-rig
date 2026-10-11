// P2 checkpoint: EMPIRICALLY calibrate the critic's pixel vetting threshold.
//
// The critic rejects a candidate when the in-transit photocenter shift exceeds a fixed
// arcsec cut. To set that cut defensibly we measure the shift distribution for planets we
// ALREADY KNOW transit their host star (confirmed NASA Archive planets): their photocenters
// should cluster near zero, and the spread of that distribution -- not a guess -- defines the
// rejection threshold (we recommend a multiple of the p99).
//
// Chain (all token-free, same as the pipeline tiers):
//   confirmed planet (TIC, ra/dec, catalog ephemeris) --(TESScut)--> sectors
//     --(TESS-SPOC public S3 _tp.fits)--> 14x14 target-pixel cube
//     --(centroidShift vs the CATALOG period/T0/duration)--> shift in arcsec.
// A target not in SPOC 404s and is skipped; nothing here fabricates data or costs a token.
//
// Usage:
//   npm run p2:vet-calibrate                       (sample of bright TIC planets)
//   npm run p2:vet-calibrate -- --targets 12 --tmag 9.5
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels, centroidShift } from "../src/data/mastS3Pixels.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 8));
const tmag = arg("tmag", 10);

function hasEphemeris(p: ArchivePlanet): boolean {
  return Number.isFinite(p.tic) && Number.isFinite(p.ra) && Number.isFinite(p.dec) &&
    Number.isFinite(p.pl_orbper) && Number.isFinite(p.pl_tranmid) && Number.isFinite(p.pl_trandur);
}

async function main() {
  console.log(`P2 vetting threshold calibration (sample of confirmed planets, tmag<${tmag})`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") {
    console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable) -- calibration needs real rows.`);
  }
  const picked = cat.planets.filter(hasEphemeris).slice(0, want);
  console.log(`queued ${picked.length} TIC planets from ${cat.planets.length} catalog rows`);
  console.log("");

  const shifts: { name: string; tic: number; sector: number; shiftArcsec: number; inN: number; outN: number }[] = [];
  const skipped: { name: string; why: string }[] = [];

  for (const p of picked) {
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      let done = false;
      for (const s of sectors.slice(0, 3)) {
        // only fetch target pixels for targets that DO have SPOC light curves (same gate as the pipeline)
        const lc = await fetchSpocLightCurve(p.tic!, [s], name);
        if (!lc) continue;
        const cube = await fetchSpocTargetPixels(p.tic!, s, lc.targetId);
        if (!cube) continue;
        const cs = centroidShift(cube, p.pl_tranmid!, p.pl_orbper!, p.pl_trandur!);
        if (cs.inCount < 2 || cs.outCount < 2) {
          skipped.push({ name, why: `too few in/out cadences (${cs.inCount}/${cs.outCount})` });
          done = true;
          break;
        }
        shifts.push({ name, tic: p.tic!, sector: s, shiftArcsec: cs.shiftArcsec, inN: cs.inCount, outN: cs.outCount });
        console.log(`${name.padEnd(20)} TIC ${p.tic} s${s}: shift ${cs.shiftArcsec.toFixed(2)} arcsec (${cs.inCount} in / ${cs.outCount} out)`);
        done = true;
        break;
      }
      if (!done) skipped.push({ name, why: "no SPOC target-pixel product in any covering sector" });
    } catch (e) {
      skipped.push({ name, why: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("");
  if (shifts.length === 0) {
    console.log("no measurable shifts (network/SPOC unavailable) -- cannot calibrate in this environment.");
    return;
  }

  const xs = shifts.map((s) => s.shiftArcsec).sort((a, b) => a - b);
  const q = (f: number) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
  console.log(`measured ${xs.length} confirmed-planet photocenter shifts (all should be near zero):`);
  console.log(`  min=${xs[0].toFixed(2)}  p50=${q(0.5).toFixed(2)}  p90=${q(0.9).toFixed(2)}  p99=${q(0.99).toFixed(2)}  max=${xs[xs.length - 1].toFixed(2)} arcsec`);
  // Suggested reject threshold: comfortably above the true-planet spread so we never drop a
  // real on-target planet, but far below the multi-arcsec blend signature (off-target by
  // several pixels = tens of arcsec). Use 3x the observed max as a conservative floor of 1".
  const suggested = Math.max(1.0, Math.ceil(xs[xs.length - 1] * 3));
  console.log(`suggested VET centroid-shift reject threshold: ${suggested.toFixed(1)} arcsec`);
  console.log("  (true planets cluster near 0; background EB / blends shift by several arcsec or more)");
}

main().catch((e) => {
  console.error("calibration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
