// P1 benchmark: completeness / purity operating characteristics of the detector.
//
// Runs the seeded injection-recovery ROC (see src/sim/roc.ts) at a size too big for the
// unit tests, and prints:
//   - a threshold sweep: completeness, false-alarm rate and purity at each BLS-SNR cut;
//   - the noise peak-SNR distribution (quantiles) -- what "nothing is there" still throws;
//   - the recovered true-positive SNR floor.
// This is the honest operating-characteristic statement a real survey reports: not "we found
// a dip" but "at SNR>=T this pipeline recovers C% of planets with an F% false-alarm rate".
//
// Usage:
//   npm run p1:roc                                  (default 150 injections + 150 noise curves)
//   npm run p1:roc -- --inj 300 --noise 300 --baseline 27 --cadence 120 --seed 5 --rho 0.5
import { runRoc, formatRoc, empiricalFap } from "../src/sim/roc.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const nInj = Math.round(arg("inj", 150));
const nNoise = Math.round(arg("noise", 150));
const baseline = arg("baseline", 27);
const cadence = arg("cadence", 120);
const noisePpm = arg("noise-ppm", 200);
const seed = Math.round(arg("seed", 20260011));

console.log(
  `P1 completeness/purity ROC  (nInj=${nInj}, nNoise=${nNoise}, baseline=${baseline}d, cadence=${cadence}s, noise=${noisePpm}ppm, seed=${seed})`,
);
console.log("");

const t0 = Date.now();
const r = runRoc({
  nInjections: nInj,
  nNoise,
  baselineDays: baseline,
  cadenceSec: cadence,
  noisePpm,
  seed,
});

console.log(formatRoc(r));
console.log("");

const sortedNoise = [...r.noiseSnr].sort((a, b) => a - b);
const q = (p: number) => sortedNoise[Math.min(sortedNoise.length - 1, Math.floor(p * sortedNoise.length))];
console.log(
  `zero-injection peak-SNR quantiles: p50=${q(0.5).toFixed(1)} p90=${q(0.9).toFixed(1)} p95=${q(0.95).toFixed(1)} p99=${q(0.99).toFixed(1)} max=${sortedNoise[sortedNoise.length - 1].toFixed(1)}`,
);
const matched = r.injections.filter((x) => x.matched);
console.log(`period-matched injections: ${matched.length}/${nInj} (threshold-independent); their SNR range ${matched.length ? Math.min(...matched.map((m) => m.snr)).toFixed(1) + ".." + Math.max(...matched.map((m) => m.snr)).toFixed(1) : "n/a"}`);
const fap7 = empiricalFap(r.noiseSnr, 7);
console.log(`empirical FAP at the production cut SNR>=7 (from the noise ensemble, no per-candidate surrogates): ${fap7.fap.toPrecision(2)} (${fap7.exceedances}/${fap7.n} noise curves reached 7)`);

// Red-noise reality check: TESS PDCSAP carries time-CORRELATED (red) noise, which inflates the BLS
// peak on planet-free light. Re-run the SAME benchmark under AR(1) rho=0.5 to show how the operating
// point moves -- a white-noise false-alarm rate is OPTIMISTIC, so the honest curve must be quoted
// with its noise color, not as a single number.
const redRho = Math.min(0.95, Math.max(0, arg("rho", 0.5)));
const rr = runRoc({ nInjections: nInj, nNoise, baselineDays: baseline, cadenceSec: cadence, noisePpm, seed, rho: redRho });
const at = (x: typeof r, t: number) => x.points.find((p) => p.thresholdSnr >= t);
const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
const redMax = Math.max(...rr.noiseSnr);
const wMax = sortedNoise[sortedNoise.length - 1];
console.log(`red-noise comparison (AR1 rho=${redRho}) -- same injections/nulls, correlated instead of white noise:`);
console.log(`threshold   white comp / FAR       red comp / FAR`);
for (const t of [5, 7, 9]) {
  const wp = at(r, t);
  const rp = at(rr, t);
  if (wp && rp) console.log(`SNR>=${t}      ${pc(wp.completeness).padStart(5)} / ${pc(wp.falseAlarmRate).padStart(5)}         ${pc(rp.completeness).padStart(5)} / ${pc(rp.falseAlarmRate).padStart(5)}`);
}
console.log(`max false-alarm SNR rose ${wMax.toFixed(2)} (white) -> ${redMax.toFixed(2)} (red): correlated noise inflates the statistic -- quote the operating point WITH its noise color.`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
