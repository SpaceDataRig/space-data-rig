// TRANSIT-DEPTH CALIBRATION for the Stage-2 false-positive screen (discovery roadmap, Stage 2).
//
// WHY THIS EXISTS. Stage 1's blind search (p19) used an ARBITRARY depth band (200-30000 ppm) and a
// crude ">5% = EB" line to separate planets from eclipsing binaries. Before that heuristic can gate
// anything we MEASURE the real distribution: pull the live confirmed transiting-planet catalog and
// report empirical percentiles of transit depth. The planetary-depth ceiling we adopt downstream is
// then "beyond N% of every planet humans have confirmed," not a made-up number. This is the same
// measure-before-gate discipline that rejected the odd/even + secondary-eclipse discriminators (they
// mis-killed true positives on real single-sector data); transit depth is one of the few 1D measures
// that IS safe to classify on, and only once it is calibrated.
//
// READ-ONLY + RESEARCH-ONLY. No verdict, no bundle hash, no money path, not imported by the worker.
// Requires the network; if the catalog pull falls back to the bundled 9-row sample it REFUSES to emit
// calibration numbers (a 9-row distribution cannot set a population ceiling).
//
// Run:  npm run p21:depth-calibrate  [-- --limit 6000 --maxtmag 15]

import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

/** Linear-interpolated percentile on an ALREADY-SORTED ascending array; q in [0,100]. */
function pct(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

async function main(): Promise<void> {
  const limit = Math.max(1, parseInt(arg("limit", "6000"), 10));
  const maxTmag = parseFloat(arg("maxtmag", "15"));
  console.log(`[p21] pulling confirmed TRANSITING planets (limit ${limit}, sy_tmag<${maxTmag}) to calibrate the depth distribution...`);

  const res = await fetchConfirmedPlanets({ limit, maxTmag });
  if (res.source !== "nasa-tap") {
    console.log(`[p21] catalog pull source = ${res.source} (${res.error ?? "no error string"}).`);
    console.log(`[p21] REFUSING to emit calibration from the bundled fallback sample (too few, not a population).`);
    console.log(`\nVERDICT: INCONCLUSIVE-CATALOG`);
    return;
  }

  const depths = res.planets.map((p) => p.pl_trandep).filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
  depths.sort((a, b) => a - b);
  const n = depths.length;
  console.log(`[p21] got ${res.planets.length} planets; ${n} carry a positive transit depth (ppm).`);
  if (n < 200) {
    console.log(`[p21] only ${n} usable depths -- too few to fix a population ceiling honestly.`);
    console.log(`\nVERDICT: INCONCLUSIVE-CATALOG`);
    return;
  }

  console.log(`\n[p21] empirical confirmed-planet transit-depth distribution (ppm):`);
  const marks = [50, 90, 95, 99, 99.5, 99.9, 100];
  for (const m of marks) console.log(`  p${String(m).padEnd(5)} ${pct(depths, m).toFixed(0).padStart(9)} ppm`);

  console.log(`\n[p21] cumulative counts above candidate ceilings (what a 'too deep to be a planet' line would exclude):`);
  for (const ceil of [10000, 20000, 30000, 50000, 100000]) {
    const above = depths.filter((d) => d > ceil).length;
    console.log(`  > ${String(ceil).padStart(6)} ppm (${(ceil / 1e4).toFixed(1)}%): ${above} of ${n} (${((above / n) * 100).toFixed(2)}%)`);
  }

  const p995 = pct(depths, 99.5);
  const p999 = pct(depths, 99.9);
  const dmax = depths[n - 1];
  console.log(`\n[p21] RECOMMENDED planetary-plausible ceiling: round up beyond p99.5=${p995.toFixed(0)} ppm; p99.9=${p999.toFixed(0)} ppm; observed max=${dmax.toFixed(0)} ppm.`);
  console.log(`[p21] context: Stage-1's arbitrary 30000 ppm top-of-band and the 272639 ppm (27%) EB-like signal from p17/p19 relative to this.`);
  console.log(`[p21] NOTE the largest confirmed 'planets' near the ceiling are hot Jupiters grazing the brown-dwarf regime; anything far above is an eclipsing binary or blend, NOT a planet candidate.`);
  console.log(`\nVERDICT: CALIBRATED (n=${n})`);
}

main().catch((e) => {
  console.error(`[p21] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
