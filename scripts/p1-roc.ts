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
//   npm run p1:roc -- --inj 300 --noise 300 --baseline 27 --cadence 120 --seed 5
import { runRoc, formatRoc } from "../src/sim/roc.ts";

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
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
