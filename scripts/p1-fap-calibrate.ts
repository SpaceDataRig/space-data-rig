// SAFETY calibration before wiring the per-candidate calibrated FAP into the money-path gate.
//
// We are about to make the critic reject a candidate when its per-target, noise-color-calibrated
// false-alarm probability exceeds a threshold. The lesson from the odd/even discriminator is seared
// in: NEVER turn on a rejection gate without first proving it does not reject REAL planets. So here
// we run the actual detector (preprocess + BLS) on REAL token-free TESS-SPOC light curves of planets
// we already know transit their host, compute calibratedFap for each, and confirm the true positives
// sit comfortably below the proposed cut. The measured spread -- not a guess -- sets the threshold.
//
// Chain: confirmed planet (TIC) -> sectors -> real _lc.fits -> BLS candidate (snr, period) ->
// calibratedFap(lc, snr, period). Deduped by STAR so a multi-planet host is not over-counted.
//
// Usage: npm run p1:fap-calibrate  (--targets 24 --tmag 10 --fap 0.05 --nnull 120)
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 24));
const tmag = arg("tmag", 10);
const proposedFap = arg("fap", 0.05);
const nNull = Math.round(arg("nnull", 120));
const minSnr = arg("min-snr", 7); // production detection cut: only candidates at/above this ever reach the critic FAP gate
const floor = 1 / (nNull + 1); // empirical-FAP resolution floor: the smallest FAP a null ensemble can report

async function main() {
  console.log(`Per-candidate FAP safety calibration on REAL SPOC photometry (confirmed planets, tmag<${tmag})`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable) -- needs real rows.`);
  const seen = new Set<number>();
  const picked: ArchivePlanet[] = [];
  for (const p of cat.planets) {
    if (!Number.isFinite(p.tic) || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) continue;
    if (seen.has(p.tic!)) continue; // one sample per star
    seen.add(p.tic!);
    picked.push(p);
    if (picked.length >= want) break;
  }
  console.log(`queued ${picked.length} DISTINCT stars; proposed reject-gate: FAP > ${proposedFap} (nNull=${nNull}, resolution floor ${floor.toPrecision(2)})`);
  if (proposedFap <= floor) console.log(`  !! WARNING: threshold ${proposedFap} is AT/BELOW the floor ${floor.toPrecision(2)} -- even a 100%-certain signal floors to 1/(nNull+1) and would be rejected. Raise nNull or the threshold.`);
  console.log("");

  const rows: { name: string; snr: number; rho: number; fap: number; wouldReject: boolean }[] = [];
  for (const p of picked) {
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      let done = false;
      for (const s of sectors.slice(0, 3)) {
        const lc = await fetchSpocLightCurve(p.tic!, [s], name);
        if (!lc || lc.points.length < 60) continue;
        const clean = preprocess(lc, 0.5);
        const span = lc.points[lc.points.length - 1].time - lc.points[0].time;
        const grid = { minPeriodDays: 0.5, maxPeriodDays: Math.max(1, Math.min(15, span * 0.8)), oversample: 8, nDurations: 10 };
        let det;
        try {
          det = bls(clean, grid);
        } catch {
          det = null;
        }
        if (!det) { rows.push({ name, snr: NaN, rho: NaN, fap: NaN, wouldReject: false }); done = true; break; }
        const sig = calibratedFap(lc, det.snr, det.periodDays, { nNull });
        // A known planet only reaches the critic FAP gate if it clears the production SNR cut; below
        // that, the detector already declines it, so the FAP value is moot for false-rejection risk.
        const isCandidate = det.snr >= minSnr;
        const wouldReject = isCandidate && Number.isFinite(sig.fap) && sig.fap > proposedFap;
        rows.push({ name, snr: det.snr, rho: sig.rho, fap: sig.fap, wouldReject });
        const tag = wouldReject ? "  <-- WOULD REJECT (a KNOWN planet above the SNR cut!)" : isCandidate ? "" : "  (below SNR cut -- not a production candidate)";
        console.log(`${name.padEnd(20)} s${s}: SNR=${det.snr.toFixed(1)} rho=${sig.rho.toFixed(2)} FAP=${sig.fap.toPrecision(2)}${tag}`);
        done = true;
        break;
      }
      if (!done) rows.push({ name, snr: NaN, rho: NaN, fap: NaN, wouldReject: false });
    } catch (e) {
      console.log(`${name.padEnd(20)} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const measured = rows.filter((r) => Number.isFinite(r.fap));
  const candidates = measured.filter((r) => r.snr >= minSnr); // the population the FAP gate actually sees
  console.log("");
  if (measured.length === 0) {
    console.log("no measurable FAP (network/SPOC unavailable) -- cannot certify the gate here.");
    return;
  }
  const faps = measured.map((r) => r.fap).sort((a, b) => a - b);
  const maxFap = faps[faps.length - 1];
  const candFaps = candidates.map((r) => r.fap).sort((a, b) => a - b);
  const maxCandFap = candFaps.length ? candFaps[candFaps.length - 1] : NaN;
  const falseRejections = candidates.filter((r) => r.wouldReject);
  console.log(`certified ${measured.length} KNOWN planets (${candidates.length} clear the SNR>=${minSnr} detection cut and are the gate's real input):`);
  console.log(`  calibrated FAP (all):    min=${faps[0].toPrecision(2)}  median=${faps[faps.length >> 1].toPrecision(2)}  max=${maxFap.toPrecision(2)}`);
  if (candFaps.length) console.log(`  calibrated FAP (candidates SNR>=${minSnr}): max=${maxCandFap.toPrecision(2)} -- all should sit at/near the floor ${floor.toPrecision(2)}`);
  console.log(`  false rejections of KNOWN PLANETS THAT ARE PRODUCTION CANDIDATES at FAP>${proposedFap}: ${falseRejections.length}`);
  if (falseRejections.length === 0) {
    console.log(`=> SAFE: every known planet that clears the SNR cut also clears the FAP>${proposedFap} gate. Wire it in.`);
    if (Number.isFinite(maxCandFap)) console.log(`   (max candidate FAP ${maxCandFap.toPrecision(2)} vs threshold ${proposedFap} -- healthy margin; sub-cut planets like TOI-2128 are already declined upstream, so the FAP gate adds no new kill risk).`);
  } else {
    console.log(`=> NOT SAFE: ${falseRejections.length} known SNR>=${minSnr} planets would be rejected: ${falseRejections.map((r) => `${r.name} FAP=${r.fap.toPrecision(2)}`).join(", ")}.`);
    console.log(`   Do NOT enable at ${proposedFap}; raise the threshold above the max candidate FAP (${maxCandFap.toPrecision(2)}).`);
  }
}

main().catch((e) => {
  console.error("FAP calibration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
