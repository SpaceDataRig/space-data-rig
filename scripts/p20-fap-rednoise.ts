// FAP RED-NOISE CALIBRATION PROBE (audit issue #3).
//
// CLAIM UNDER TEST. A per-point TIME-JITTER surrogate (what src/detect/fap.ts estimateFap does) scrambles
// the time ordering, which DESTROYS the AR(1) autocorrelation of a red-noise host -- so its null ensemble
// is whiter than the real data, and the empirical FAP comes out too LOW (optimistic) exactly on the active
// stars where over-confidence is most dangerous. Our own p8 work showed red noise lifts the white-noise
// false-alarm rate from 0% toward ~30%. Meanwhile the PRODUCTION gate (src/detect/significance.ts
// calibratedFap) draws nulls from an AR(1) MODEL at the star's OWN measured rho, so it should stay calibrated.
//
// This probe measures, per noise color rho, the empirical FALSE-ALARM RATE (fraction of PLANET-FREE curves
// that get FAP < 0.05) from BOTH methods on the SAME synthetic curves. Nominal FAR is 5%. A method whose FAR
// climbs well above 5% as rho grows is optimistic. Deterministic + offline (fixed seeds); a benchmark, so it
// is NOT in npm test.
//
// Run:  npm run p20:fap-rednoise

import { estimateFap } from "../src/detect/fap.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { bls } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";

const RHO = [0, 0.3, 0.6, 0.8];
const N = 12; // curves per color (keep modest: each curve runs a full null ensemble)
const NOISE_PPM = 300;
const CADENCE = 120; // sec
const BASELINE = 10; // days (shorter -> fewer points -> a faster probe)
const TRIALS = 40; // surrogate/null ensemble size per curve
const MAXPTS = 700; // bin the AR(1) null ensemble to keep the probe fast (downsample fix keeps it calibrated)
const THRESHOLD = 0.05;

function planetFree(rho: number, i: number): LightCurve {
  return makeRedNoiseLightCurve({
    seed: 1000 + i,
    periodDays: 5, // irrelevant at depthFrac 0; just centers the sampler's grid
    depthFrac: 0,
    noisePpm: NOISE_PPM,
    rho,
    cadenceSec: CADENCE,
    baselineDays: BASELINE,
    dutyCycle: 0.9,
    targetIdLabel: `NULL-${rho}-${i}`,
  });
}

function pct(n: number): string {
  return `${(100 * n).toFixed(1)}%`;
}

function main(): void {
  console.log(`[p20] FAP red-noise calibration: ${N} planet-free curves per color, threshold FAP<${THRESHOLD} (nominal FAR 5%)`);
  console.log("  rho    time-jitter FAR   AR(1)-model FAR   (each: fraction of nulls that pass the gate)");
  for (const rho of RHO) {
    let jitterFar = 0;
    let arFar = 0;
    for (let i = 0; i < N; i++) {
      const lc = planetFree(rho, i);
      // the detector's own peak on this planet-free curve is the "observed" statistic
      const det = bls(lc);
      const j = estimateFap(lc, { trials: TRIALS, seed: 5000 + i });
      if (j.fap < THRESHOLD) jitterFar++;
      const c = calibratedFap(lc, det.snr, det.periodDays, { nNull: TRIALS, seed: 9000 + i, maxPoints: MAXPTS });
      if (c.fap < THRESHOLD) arFar++;
    }
    console.log(`  ${rho.toFixed(2)}   ${pct(jitterFar / N).padStart(12)}   ${pct(arFar / N).padStart(14)}`);
  }
  console.log(`\n[p20] read: a column climbing well above 5% as rho grows is optimistic on red-noise hosts.`);
  console.log(`[p20] NOTE: production gating uses calibratedFap (AR(1) model nulls), NOT estimateFap's time-jitter.`);
}

main();
