// Per-detection parameter uncertainty on REAL photometry: bootstrap error bars on the period.
//
// Closes the roadmap "parameter uncertainty" gap (P0). The pipeline reports a point period; a survey
// result needs an error bar. For each confirmed-planet host we fetch its REAL SPOC light curve, run the
// detector, then bootstrap (residual circular-block resampling, which preserves the target's own noise
// color) to get a 16/50/84 percentile interval on the period. We also show the catalog value so the
// reader can see the true period falls inside the interval -- an honest, self-consistent uncertainty.
//
// Benchmark script (network + CPU); never part of the runtime pipeline or the bundle hash.
// Usage: npm run p1:uncertainty  (--targets 12 --tmag 10 --boot 150)
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";
import { bootstrapUncertainty } from "../src/detect/uncertainty.ts";
import { periodMatched } from "../src/sim/injectInto.ts";
import type { TransitCandidate } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 12));
const tmag = arg("tmag", 10);
const bootstraps = Math.round(arg("boot", 150));

async function main() {
  console.log(`Bootstrap period uncertainty on REAL SPOC photometry (confirmed planets, tmag<${tmag}, B=${bootstraps})`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} -- needs real rows.`);
  const seen = new Set<number>();
  let done = 0;
  for (const p of cat.planets) {
    if (done >= want) break;
    if (!Number.isFinite(p.tic) || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) continue;
    if (seen.has(p.tic!)) continue;
    seen.add(p.tic!);
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      for (const s of sectors.slice(0, 3)) {
        const lc = await fetchSpocLightCurve(p.tic!, [s], name);
        if (!lc || lc.points.length < 120) continue;
        const clean = preprocess(lc, 0.5);
        const span = lc.points[lc.points.length - 1].time - lc.points[0].time;
        const grid = { minPeriodDays: 0.5, maxPeriodDays: Math.max(1, Math.min(15, span * 0.8)), oversample: 8, nDurations: 10 };
        const r = bls(clean, grid);
        const cand: TransitCandidate = {
          targetId: lc.targetId,
          periodDays: r.periodDays,
          epochBjd: r.epochBjd,
          durationHours: r.durationDays * 24,
          depthPpt: r.depth * 1000,
          depthFrac: r.depth,
          snr: r.snr,
          power: r.power,
          nPointsInTransit: 0,
        };
        const u = bootstrapUncertainty(lc, cand, { bootstraps });
        const catP = p.pl_orbper;
        const matched = Number.isFinite(catP) && periodMatched(r.periodDays, catP!, 2);
        const covers = Number.isFinite(catP) && u.periodCI[0] <= catP! && catP! <= u.periodCI[1];
        console.log(`${name.padEnd(18)} SNR=${r.snr.toFixed(1)} P=${r.periodDays.toFixed(4)} +/- ${u.periodSigma.toFixed(4)}d [${u.periodCI[0].toFixed(4)}, ${u.periodCI[1].toFixed(4)}]  catalog=${Number.isFinite(catP) ? catP!.toFixed(4) : "?"}${matched ? (covers ? "  [catalog inside CI]" : "  [detected, CI narrow]") : "  (period not catalog-matched)"}`);
        done++;
        break;
      }
    } catch (e) {
      console.log(`${name.padEnd(18)} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("");
  console.log(`period error bars are the 16/84 percentile of a residual circular-block bootstrap of the`);
  console.log(`REAL light curve -- they inherit each star's own noise color, so active stars get wider`);
  console.log(`bars than quiet ones at the same SNR. This is the per-detection uncertainty layer.`);
}

main().catch((e) => {
  console.error("uncertainty run failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
