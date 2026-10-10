// P0 acceptance benchmark: prove the detection pipeline recovers KNOWN transits.
// Run: npm run p0:benchmark
// Success criterion: high recovery rate for bright (>=1000 ppm) planets and
// sub-percent median period error. This is the "does it really work" gate.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInjectionRecovery } from "../src/sim/injectionRecovery.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "../out");
mkdirSync(outDir, { recursive: true });

const nTrials = Number(process.argv[2] ?? 80);
console.log(`\n=== Space Data Rig :: P0 Injection-Recovery Benchmark ===`);
console.log(`Trials: ${nTrials}  (TESS-like: 2-min cadence, 27-day baseline, 200 ppm noise)\n`);

const t0 = Date.now();
const { trials, summary } = runInjectionRecovery({ nTrials, seed: 20261010 });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`Recovery rate:      ${(summary.recoveryRate * 100).toFixed(1)}%  (${summary.nRecovered}/${summary.nTrials})  [alias-resolved]`);
console.log(`Recovery rate (raw):${(summary.recoveryRateRaw * 100).toFixed(1)}%  (${summary.nRecoveredRaw}/${summary.nTrials})  [exact period]`);
console.log(`Median period err:  ${summary.medianPeriodErrorPct.toFixed(3)} %`);
console.log(`Median depth err:   ${summary.medianDepthErrorPct.toFixed(1)} %  (box vs limb-darkened central depth)`);
console.log(`Median SNR:         ${summary.medianSnr.toFixed(1)}`);
console.log(`Wall time:          ${elapsed}s\n`);

console.log(`Recovery by injected depth:`);
console.log(`  ${"depth".padEnd(12)}${"n".padStart(4)}${"recovered".padStart(11)}${"rate".padStart(9)}`);
for (const b of summary.byDepthBin) {
  console.log(`  ${b.bin.padEnd(12)}${String(b.n).padStart(4)}${String(b.recovered).padStart(11)}${(b.rate * 100).toFixed(0).padStart(8)}%`);
}

// a few concrete examples
console.log(`\nSample recovered trials:`);
const rec = trials.filter((t) => t.recovered).slice(0, 5);
for (const t of rec) {
  console.log(
    `  P_inj=${t.injectedPeriod.toFixed(3)}d  P_rec=${t.recoveredPeriod?.toFixed(3)}d  ` +
      `depth=${t.injectedDepthPpm.toFixed(0)}ppm  SNR=${t.snr?.toFixed(1)}  alias=x${t.aliasFactor}`,
  );
}

const bright = summary.byDepthBin.filter((b) => parseInt(b.bin) >= 1000);
const brightRate = bright.length ? bright.reduce((a, b) => a + b.recovered, 0) / bright.reduce((a, b) => a + b.n, 0) : 0;
const PASS = brightRate >= 0.8 && summary.medianPeriodErrorPct < 1;
console.log(`\nBright-planet (>=1000ppm) recovery: ${(brightRate * 100).toFixed(0)}%`);
console.log(PASS ? `✅ P0 PASS: pipeline demonstrably recovers known transits.` : `⚠️  P0 borderline: tune detector before proceeding.`);

writeFileSync(
  resolve(outDir, "p0-benchmark.json"),
  JSON.stringify({ summary, trials, elapsedSec: Number(elapsed), pass: PASS }, null, 2),
);
console.log(`\nWrote out/p0-benchmark.json`);
