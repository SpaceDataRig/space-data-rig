// P54: demonstrate the selection-function skeleton (discovery roadmap, priority 4) on the REAL
// committed P47 completeness grid. This is an ILLUSTRATIVE composition, not a measured occurrence
// rate: it shows what the eta_earth denominator (geometry x dilution x completeness) looks like once
// you combine the pieces, using the real 2-D completeness map from reports/p47 and a sweep of
// DILUTION FACTORS that are clearly labelled as illustrative scenarios (not per-target Gaia
// measurements), and a SOLAR-TWIN star (R* = M* = 1) as a documented assumption because the P47 grid
// does not carry per-host radii/masses. No number here is a detection or a rate; discoveryClaim is
// false and safeToGate does not apply (nothing gates).
//
// Usage:
//   npm run p54:selection-function
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { buildSelectionFunction, type PeriodBinSelection } from "../src/sim/selectionFunction.ts";
import type { GridCell } from "../src/sim/completenessGrid.ts";

interface P47Cell { periodLo: number; periodHi: number; depthLo: number; depthHi: number; n: number; k: number; completeness: number; ciLow: number; ciHigh: number; }

function rebuildGrid(cells: P47Cell[]): { cells: GridCell[]; periodEdges: number[]; depthEdges: number[] } {
  if (cells.length === 0) throw new Error("no cells");
  // cells are ordered periodIndex-major, depthIndex-minor (from binCompleteness).
  const depthEdgesSet: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (i === 0) depthEdgesSet.push(cells[i].depthLo);
    depthEdgesSet.push(cells[i].depthHi);
  }
  // unique ascending depth edges
  const depthEdges = [...new Set(depthEdgesSet)].sort((a, b) => a - b);
  const D = depthEdges.length - 1;
  const periodEdges: number[] = [];
  for (let i = 0; i < cells.length; i += D) periodEdges.push(cells[i].periodLo);
  periodEdges.push(cells[cells.length - 1].periodHi);
  const gridCells: GridCell[] = cells.map((c, idx) => ({
    periodIndex: Math.floor(idx / D),
    depthIndex: idx % D,
    periodLo: c.periodLo,
    periodHi: c.periodHi,
    depthLo: c.depthLo,
    depthHi: c.depthHi,
    n: c.n,
    k: c.k,
    completeness: c.n > 0 ? c.k / c.n : NaN,
    ciLow: c.ciLow,
    ciHigh: c.ciHigh,
  }));
  return { cells: gridCells, periodEdges, depthEdges };
}

const DILUTIONS = [1.0, 0.9, 0.7]; // clean / mild / strong dilution scenarios (illustrative)
const STAR = { starRadiusSolar: 1, starMassSolar: 1 }; // documented solar-twin assumption

function fmt(x: number | null, d = 0): string {
  return x == null || !Number.isFinite(x) ? "-" : x.toFixed(d);
}

async function main() {
  const p47 = JSON.parse(readFileSync("reports/p47-completeness-grid.json", "utf8")) as { cells: P47Cell[] };
  const grid = rebuildGrid(p47.cells);
  console.log(`P54 selection-function demo on the real P47 grid (${grid.cells.length} cells, ${grid.periodEdges.length - 1} period bins)`);

  const tables = DILUTIONS.map((dil) => ({
    dilutionFactor: dil,
    rows: buildSelectionFunction(grid, { dilutionFactor: dil, ...STAR }),
  }));

  const header = tables[0].rows.map((r) => `${r.periodLo}-${r.periodHi}d`).join(" | ");
  console.log(`\nperiod bins: ${header}`);
  console.log(`geometric transit prob (solar twin): ${tables[0].rows.map((r) => fmt(r.geometricTransitProb, 3)).join(" | ")}`);
  for (const t of tables) {
    console.log(`observed 50% depth (ppm) @ dilution ${t.dilutionFactor}: ${t.rows.map((r) => fmt(r.observedDepth50Ppm)).join(" | ")}`);
    console.log(`TRUE 50% depth (ppm)   @ dilution ${t.dilutionFactor}: ${t.rows.map((r) => fmt(r.trueDepth50Ppm)).join(" | ")}`);
  }

  const json = {
    meta: {
      generatedBy: "scripts/p54-selection-function.ts",
      module: "src/sim/selectionFunction.ts",
      completenessGrid: "reports/p47-completeness-grid.json (real detector efficiency on real photometry)",
      illustrative: true,
      note: "Dilution factors and the solar-twin star are DOCUMENTED ASSUMPTIONS for a demonstration, " +
        "not per-target Gaia measurements or stellar parameters. This composes geometry x dilution x " +
        "completeness into the eta_earth denominator skeleton; it is NOT a measured occurrence rate and " +
        "there is nothing to divide (no detections are claimed).",
    },
    dilutions: DILUTIONS,
    star: STAR,
    periodBins: tables[0].rows.map((r) => ({ periodLo: r.periodLo, periodHi: r.periodHi, geometricTransitProb: r.geometricTransitProb })),
    byDilution: tables.map((t) => ({
      dilutionFactor: t.dilutionFactor,
      observedDepth50Ppm: t.rows.map((r) => r.observedDepth50Ppm),
      trueDepth50Ppm: t.rows.map((r) => r.trueDepth50Ppm),
    })),
    discoveryClaim: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p54-selection-function.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P54 selection-function skeleton, composed on the real P47 completeness grid",
    "",
    "Reproduce: `npm run p54:selection-function`",
    "Module: `src/sim/selectionFunction.ts`. Inputs: the REAL 2-D completeness map from `reports/p47`",
    "(period x observed-depth detector efficiency on real TESS-SPOC photometry), composed with a",
    "geometric transit probability and a dilution window.",
    "",
    "**Illustrative, not a rate.** The dilution factors (1.0 / 0.9 / 0.7) and the solar-twin star",
    "(R* = M* = 1) are documented ASSUMPTIONS for a demonstration, not per-target Gaia measurements or",
    "stellar parameters. This shows the SHAPE of the eta_earth denominator; it is not an occurrence",
    "rate and claims no detections.",
    "",
    "## Geometric transit probability (solar twin, per period bin)",
    "",
    "| period bin (d) | geometric P |",
    "|---|---|",
    ...tables[0].rows.map((r) => `| ${r.periodLo}-${r.periodHi} | ${fmt(r.geometricTransitProb, 4)} |`),
    "",
    "## 50%-completeness depth, observed vs TRUE (after undoing dilution)",
    "",
    "| dilution | " + tables[0].rows.map((r) => `${r.periodLo}-${r.periodHi}d obs/true (ppm)`).join(" | ") + " |",
    "|---|" + tables[0].rows.map(() => "---").join("|") + "|",
    ...tables.map((t) => `| ${t.dilutionFactor.toFixed(2)} | ` + t.rows.map((r: PeriodBinSelection) => `${fmt(r.observedDepth50Ppm)} / ${fmt(r.trueDepth50Ppm)}`).join(" | ") + " |"),
    "",
    "Reading: a diluted host (0.7) needs a TRUE transit ~1/0.7 = 1.43x deeper than the observed 50%",
    "threshold to be recovered -- the dilution window inflates the detectable planet radius. Turning this",
    "into eta_earth requires per-target Gaia dilution + stellar radii/masses over an UNBIASED sample",
    "(P47 hosts are bright planet-bearing stars, so this is efficiency, not a survey selection function)",
    "-- that is the honest next step, not run here. discoveryClaim: false.",
    "",
  ].join("\n");
  writeFileSync("reports/p54-selection-function.md", md);
  console.log("\nwrote reports/p54-selection-function.md and reports/p54-selection-function.json");
}

main().catch((e) => {
  console.error("p54 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
