// P47: a 2-D (period x depth) detection-efficiency completeness MAP from injection-recovery on REAL
// light curves, with honest per-cell confidence intervals and a 50% threshold curve -- plus an
// explicit, documented target SELECTION function (validation roadmap, priority 4).
//
// This upgrades scripts/p1-real-completeness.ts, which measured completeness only MARGINALLY (vs
// depth, vs period, separately). Occurrence-rate work needs the JOINT efficiency surface and its
// error bars, so we bin every injection trial into a period x depth grid (src/sim/completenessGrid.ts,
// Wilson intervals) and report the depth at which each period bin reaches 50% completeness.
//
// HONEST SCOPING. (1) The target sample is drawn by a stated selection function (unique TIC hosts,
// Tmag <= limit, >= minPoints SPOC points, first available of up to 3 sectors). These hosts come from
// the confirmed-planet catalog, so they are biased bright and planet-bearing -- we SAY SO and treat the
// map as a detector-efficiency measurement on real photometry, not an unbiased survey selection.
// (2) Long-period bins are coverage-limited by the ~27d single-sector baseline: cells with too few
// injections report n and a wide interval rather than a fake number. Positive control only; nothing
// gated, anchored, claimed, or deployed. discoveryClaim false.
//
// Run:  npm run p47:completeness-grid  [-- --targets 20 --tmag 11 --trials 2 --min-snr 7]

import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";
import { binCompleteness, thresholdDepthAt, type Trial } from "../src/sim/completenessGrid.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return Number(hit.split("=")[1]);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 20));
const tmag = arg("tmag", 11);
const minSnr = arg("min-snr", 7);
const trialsPerPoint = Math.round(arg("trials", 2));
const minPoints = 200;

// ascending bin edges; trials land in the bin whose centre we inject at
const periodEdges = [1, 2, 4, 6.5, 9.5, 13];
const depthEdges = [200, 400, 700, 1200, 2500, 5000, 9000];
const periodCentres = periodEdges.slice(0, -1).map((lo, i) => (lo + periodEdges[i + 1]) / 2);
const depthCentres = depthEdges.slice(0, -1).map((lo, i) => (lo + depthEdges[i + 1]) / 2);

const selectionFunction =
  `unique TIC hosts from the confirmed-planet catalog at Tmag<=${tmag}, first SPOC light curve with ` +
  `>=${minPoints} points among up to 3 sectors containing the coordinate; injection grid ` +
  `period=[${periodCentres.join(",")}]d x depth=[${depthCentres.join(",")}]ppm x ${trialsPerPoint} trials, ` +
  `recovered = BLS(SNR>=${minSnr}) period matched within 2%. NOTE: hosts are planet-bearing and bright, ` +
  `so this is detector efficiency on real photometry, not an unbiased survey selection.`;

async function main(): Promise<void> {
  console.log(`P47 2-D completeness grid on real light curves. Selection: ${selectionFunction}`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} -- needs real rows.`);

  const seen = new Set<number>();
  const hosts: { name: string; lc: LightCurve }[] = [];
  for (const p of cat.planets) {
    if (hosts.length >= want) break;
    if (!Number.isFinite(p.tic) || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) continue;
    if (seen.has(p.tic!)) continue;
    seen.add(p.tic!);
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      for (const s of sectors.slice(0, 3)) {
        const lc = await fetchSpocLightCurve(p.tic!, [s], name);
        if (lc && lc.points.length >= minPoints) { hosts.push({ name, lc }); break; }
      }
    } catch { /* skip */ }
  }
  console.log(`got ${hosts.length} real light curves; ${hosts.length * periodCentres.length * depthCentres.length * trialsPerPoint} planned injections (minus coverage skips)`);

  const trials: Trial[] = [];
  let seed = 1000;
  for (const host of hosts) {
    const span = host.lc.points[host.lc.points.length - 1].time - host.lc.points[0].time;
    for (const P of periodCentres) {
      if (P * 2.5 > span) continue; // need >=2 transits in the baseline to be measurable
      for (const d of depthCentres) {
        for (let t = 0; t < trialsPerPoint; t++) {
          seed++;
          const inj = injectTransitInto(host.lc, { seed, periodDays: P, depthFrac: d * 1e-6 });
          let recovered = false;
          try {
            const grid = { minPeriodDays: Math.max(0.5, P * 0.6), maxPeriodDays: P * 1.7, oversample: 6, nDurations: 8 };
            const r = bls(preprocess(inj, 0.5), grid);
            recovered = r.snr >= minSnr && periodMatched(r.periodDays, P, 2);
          } catch { recovered = false; }
          trials.push({ periodDays: P, depthPpm: d, recovered });
        }
      }
    }
  }

  const grid = binCompleteness(trials, periodEdges, depthEdges);
  const thresholds = thresholdDepthAt(grid, 0.5);

  // render the grid as a matrix keyed by [periodIndex][depthIndex]
  const D = depthEdges.length - 1;
  const cellAt = (pi: number, di: number) => grid.cells[pi * D + di];
  const fmt = (pi: number, di: number) => {
    const c = cellAt(pi, di);
    if (c.n === 0) return "   --  ";
    return `${String(Math.round(100 * c.completeness)).padStart(3)}%/${String(c.n).padStart(2)}`;
  };

  console.log("\n=== P47 COMPLETENESS GRID (period rows x depth cols; recovery% / trials) ===");
  console.log("  P(d)   " + depthCentres.map((d) => `${String(Math.round(d)).padStart(7)}ppm`).join(""));
  for (let pi = 0; pi < periodEdges.length - 1; pi++) {
    const row = periodCentres[pi].toFixed(1).padStart(5) + "  " + Array.from({ length: D }, (_, di) => fmt(pi, di).padStart(7)).join("");
    console.log(row);
  }
  console.log("\n50% completeness depth threshold per period bin:");
  for (const th of thresholds) {
    console.log(`  ${periodCentres[th.periodIndex].toFixed(1)}d  ->  ${th.depthPpm == null ? "not reached in-baseline" : th.depthPpm.toFixed(0) + " ppm"}`);
  }

  const totalN = grid.used;
  const reached50 = thresholds.filter((t) => t.depthPpm != null).length;
  console.log(`\ntotal injections binned: ${totalN}; period bins reaching 50%: ${reached50}/${thresholds.length}`);

  const json = {
    meta: {
      generatedBy: "scripts/p47-completeness-grid.ts",
      selectionFunction,
      tmag, minSnr, trialsPerPoint, minPoints,
      nHosts: hosts.length,
      periodEdges, depthEdges,
      data: "real TESS-SPOC light curves; injected transits; same preprocess+BLS detector as production",
    },
    totalInjections: totalN,
    outsideBins: grid.outside,
    cells: grid.cells.map((c) => ({
      periodLo: c.periodLo, periodHi: c.periodHi, depthLo: c.depthLo, depthHi: c.depthHi,
      n: c.n, k: c.k,
      completeness: Number.isFinite(c.completeness) ? +c.completeness.toFixed(4) : null,
      ciLow: Number.isFinite(c.ciLow) ? +c.ciLow.toFixed(4) : null,
      ciHigh: Number.isFinite(c.ciHigh) ? +c.ciHigh.toFixed(4) : null,
    })),
    thresholdDepth50: thresholds.map((t) => ({
      periodLo: t.periodLo, periodHi: t.periodHi,
      depthPpm: t.depthPpm == null ? null : +t.depthPpm.toFixed(0),
    })),
    periodBinsReaching50: reached50,
    discoveryClaim: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p47-completeness-grid.json", JSON.stringify(json, null, 2) + "\n");

  const mdLines: string[] = [
    "# P47 two-dimensional completeness map (period x depth) on real light curves",
    "",
    `Reproduce: \`npm run p47:completeness-grid -- --targets ${want} --tmag ${tmag} --trials ${trialsPerPoint} --min-snr ${minSnr}\``,
    "",
    "**Target selection function (stated a priori):** " + selectionFunction,
    "",
    `Measured by injecting **${totalN}** transits into **${hosts.length}** real TESS-SPOC light curves and running the`,
    "same detector the pipeline uses. Cells show `recovery% / trials`; `--` = no injections landed there (long-period",
    "bins are coverage-limited by the ~27-day single-sector baseline).",
    "",
    "| period (d) \\\\ depth (ppm) | " + depthCentres.map((d) => Math.round(d)).join(" | ") + " |",
    "|---|" + depthCentres.map(() => "---|").join(""),
  ];
  for (let pi = 0; pi < periodEdges.length - 1; pi++) {
    const row = `| ${periodCentres[pi].toFixed(1)} | ` + Array.from({ length: D }, (_, di) => {
      const c = cellAt(pi, di);
      return c.n === 0 ? "--" : `${Math.round(100 * c.completeness)}% (${c.n})`;
    }).join(" | ") + " |";
    mdLines.push(row);
  }
  mdLines.push("", "**50%-completeness depth threshold per period bin** (the detection-limit curve):", "");
  mdLines.push("| period (d) | 50% depth (ppm) |", "|---|---|");
  for (const th of thresholds) {
    mdLines.push(`| ${periodCentres[th.periodIndex].toFixed(1)} | ${th.depthPpm == null ? "not reached" : th.depthPpm.toFixed(0)} |`);
  }
  mdLines.push(
    "",
    `**${reached50}/${thresholds.length}** period bins reach 50% completeness within the injected depth range;`,
    "each cell carries a Wilson 95% interval in the JSON (`ciLow`/`ciHigh`) so thin cells are not over-read.",
    "",
    "Honest limits: the host sample is bright and planet-bearing (catalog-derived), so this is detector",
    "efficiency on real photometry, not an unbiased survey selection function; long-period cells are empty",
    "because a single sector cannot hold two of their transits. Positive control only; nothing gated,",
    "anchored, claimed, or deployed. `discoveryClaim: false`.",
    "",
  );
  writeFileSync("reports/p47-completeness-grid.md", mdLines.join("\n"));
  console.log("\nwrote reports/p47-completeness-grid.md and reports/p47-completeness-grid.json");
}

main().catch((e) => {
  console.error("p47 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
