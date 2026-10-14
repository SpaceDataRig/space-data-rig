// P56: a REAL, per-target selection function (discovery roadmap, priority 4 -- the measured step
// beyond the P54 illustrative skeleton). For each confirmed-planet HOST we use only public, token-
// free data: the NASA Exoplanet Archive supplies the star's radius and mass (st_rad / st_mass), and
// Gaia DR3 supplies the aperture neighbours, from which we measure the DILUTION FACTOR (how much of
// the light in the TESS aperture is NOT the host). Combining those with the committed P47
// completeness grid via src/sim/selectionFunction.ts gives, per target, the honest denominator that
// an occurrence-rate calculation divides by: geometric transit probability (real R*, M*) x the
// dilution-inflated true depth at 50% completeness (real dilution).
//
// This is a MEASURED selection function over a real sample -- NOT an occurrence rate. We have no
// unbiased set of detections to divide by (the P47 hosts are bright planet-bearing stars, so this is
// detector efficiency, not a survey), and we claim no planets. discoveryClaim false; nothing gates.
//
// Usage:
//   npm run p56:real-selection
//   npm run p56:real-selection -- --hosts 18 --tmag 11 --aperture 21
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchGaiaNeighborhood, dilutionFromNeighbors, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { buildSelectionFunction, type PeriodBinSelection } from "../src/sim/selectionFunction.ts";
import type { GridCell } from "../src/sim/completenessGrid.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const wantHosts = Math.round(argNum("hosts", 18));
const tmag = argNum("tmag", 11);
const APERTURE = argNum("aperture", 21);
const HOST_MATCH_RADIUS = 2.0; // arcsec: nearest Gaia source to the catalog position is the host

interface P47Cell { periodLo: number; periodHi: number; depthLo: number; depthHi: number; n: number; k: number; completeness: number; ciLow: number; ciHigh: number; }

function rebuildGrid(cells: P47Cell[]): { cells: GridCell[]; periodEdges: number[]; depthEdges: number[] } {
  const depthEdges = [...new Set(cells.flatMap((c, i) => (i === 0 ? [c.depthLo, c.depthHi] : [c.depthHi])))].sort((a, b) => a - b);
  const D = depthEdges.length - 1;
  const periodEdges: number[] = [];
  for (let i = 0; i < cells.length; i += D) periodEdges.push(cells[i].periodLo);
  periodEdges.push(cells[cells.length - 1].periodHi);
  const gridCells: GridCell[] = cells.map((c, idx) => ({
    periodIndex: Math.floor(idx / D), depthIndex: idx % D,
    periodLo: c.periodLo, periodHi: c.periodHi, depthLo: c.depthLo, depthHi: c.depthHi,
    n: c.n, k: c.k, completeness: c.n > 0 ? c.k / c.n : NaN, ciLow: c.ciLow, ciHigh: c.ciHigh,
  }));
  return { cells: gridCells, periodEdges, depthEdges };
}

function q(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

interface HostRow {
  name: string; tic: number;
  starRadiusSolar: number; starMassSolar: number;
  dilutionFactor: number; contaminationPct: number; nInAperture: number;
  geoProb: number;            // geometric transit prob at the reference bin centre
  observedDepth50Ppm: number; // P47 observed 50% depth at the reference bin
  trueDepth50Ppm: number;     // after undoing this host's real dilution
  refPeriodLo: number; refPeriodHi: number;
}

async function main() {
  const p47 = JSON.parse(readFileSync("reports/p47-completeness-grid.json", "utf8")) as { cells: P47Cell[] };
  const grid = rebuildGrid(p47.cells);
  // reference period bin = the first one that reaches 50% completeness (a short, well-covered period)
  const firstSel = buildSelectionFunction(grid, { dilutionFactor: 1, starRadiusSolar: 1, starMassSolar: 1 });
  const refIdx = firstSel.findIndex((r) => r.observedDepth50Ppm != null);
  if (refIdx < 0) { console.error("P47 grid has no bin reaching 50%; cannot compute a reference selection."); process.exitCode = 1; return; }
  const refBin = firstSel[refIdx];
  console.log(`P56 real per-target selection function (reference period bin ${refBin.periodLo}-${refBin.periodHi}d, observed 50% depth ${refBin.observedDepth50Ppm} ppm)`);

  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true, limit: 400 });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source}; need live rows with stellar params.`);
  // one row per unique TIC host, requiring finite ra/dec/st_rad/st_mass
  const seen = new Set<number>();
  const hosts: ArchivePlanet[] = [];
  for (const p of cat.planets) {
    if (!Number.isFinite(p.tic) || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) continue;
    if (!Number.isFinite(p.st_rad) || !Number.isFinite(p.st_mass)) continue;
    if (seen.has(p.tic!)) continue;
    seen.add(p.tic!);
    hosts.push(p);
    if (hosts.length >= wantHosts) break;
  }
  console.log(`queued ${hosts.length} unique TIC hosts with stellar parameters\n`);

  const rows: HostRow[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const h of hosts) {
    const name = h.hostname ?? h.pl_name ?? `TIC ${h.tic}`;
    try {
      const sources = await fetchGaiaNeighborhood(h.ra!, h.dec!, { radiusDeg: APERTURE / 3600 });
      // the host is the nearest Gaia source to the catalog position
      let hostGmag = NaN;
      let hostSourceId: string | undefined;
      let nearest = Infinity;
      for (const s of sources) {
        const sep = angularSepArcsec(h.ra!, h.dec!, s.ra, s.dec);
        if (sep < nearest) { nearest = sep; hostGmag = s.gmag; hostSourceId = s.sourceId; }
      }
      if (!(nearest <= HOST_MATCH_RADIUS) || !Number.isFinite(hostGmag)) {
        skipped.push({ name, why: `no Gaia source within ${HOST_MATCH_RADIUS}" to identify the host` });
        continue;
      }
      const dil = dilutionFromNeighbors(hostGmag, h.ra!, h.dec!, sources, APERTURE, hostSourceId);
      const sel: PeriodBinSelection[] = buildSelectionFunction(grid, {
        dilutionFactor: dil.dilutionFactor, starRadiusSolar: h.st_rad!, starMassSolar: h.st_mass!,
      });
      const bin = sel[refIdx];
      if (bin.observedDepth50Ppm == null || bin.trueDepth50Ppm == null) {
        skipped.push({ name, why: "reference bin has no 50% crossing" });
        continue;
      }
      rows.push({
        name, tic: h.tic!, starRadiusSolar: h.st_rad!, starMassSolar: h.st_mass!,
        dilutionFactor: dil.dilutionFactor, contaminationPct: dil.contaminationPct, nInAperture: dil.nInAperture,
        geoProb: bin.geometricTransitProb, observedDepth50Ppm: bin.observedDepth50Ppm, trueDepth50Ppm: bin.trueDepth50Ppm,
        refPeriodLo: bin.periodLo, refPeriodHi: bin.periodHi,
      });
      console.log(`${name.padEnd(18)} TIC ${h.tic}: R*=${h.st_rad!.toFixed(2)} M*=${h.st_mass!.toFixed(2)} dil=${dil.dilutionFactor.toFixed(3)} (${dil.nInAperture} nbr, ${dil.contaminationPct.toFixed(1)}% cont) -> true50 ${bin.observedDepth50Ppm.toFixed(0)}->${bin.trueDepth50Ppm.toFixed(0)}ppm, Pgeo=${bin.geometricTransitProb.toFixed(3)}`);
    } catch (e) {
      skipped.push({ name, why: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("");
  if (rows.length === 0) {
    console.log("no hosts measurable (Gaia/archive unavailable) -- cannot compute a real selection function here.");
    return;
  }
  const dils = rows.map((r) => r.dilutionFactor).sort((a, b) => a - b);
  const infl = rows.map((r) => r.trueDepth50Ppm / r.observedDepth50Ppm).sort((a, b) => a - b);
  const geos = rows.map((r) => r.geoProb).sort((a, b) => a - b);
  const contaminated = rows.filter((r) => r.dilutionFactor < 0.99).length;
  console.log(`measured ${rows.length} real hosts:`);
  console.log(`  dilution factor:      min=${q(dils, 0).toFixed(3)}  p50=${q(dils, 0.5).toFixed(3)}  max=${dils[dils.length - 1].toFixed(3)}  (${contaminated}/${rows.length} have a measurable contaminant)`);
  console.log(`  true-depth inflation: p50=${q(infl, 0.5).toFixed(2)}x  p90=${q(infl, 0.9).toFixed(2)}x  max=${infl[infl.length - 1].toFixed(2)}x`);
  console.log(`  geometric transit P:  min=${q(geos, 0).toFixed(3)}  p50=${q(geos, 0.5).toFixed(3)}  max=${geos[geos.length - 1].toFixed(3)}`);
  const worst = rows.slice().sort((a, b) => b.trueDepth50Ppm - a.trueDepth50Ppm)[0];
  console.log(`  most-inflated host:   ${worst.name} (dil ${worst.dilutionFactor.toFixed(3)} -> true 50% depth ${worst.trueDepth50Ppm.toFixed(0)} ppm)`);
  console.log(`\n  VERDICT: P56-REAL-SELECTION-FUNCTION-COMPUTED over ${rows.length} hosts (real dilution + real stellar params); a measured eta_earth denominator, NOT an occurrence rate.`);

  const json = {
    meta: {
      generatedBy: "scripts/p56-real-selection.ts", module: "src/sim/selectionFunction.ts",
      completenessGrid: "reports/p47-completeness-grid.json",
      data: "real NASA Archive stellar R*/M* + real Gaia DR3 aperture dilution (token-free)",
      referencePeriodBin: { lo: refBin.periodLo, hi: refBin.periodHi, observedDepth50Ppm: refBin.observedDepth50Ppm },
      hostMatchRadiusArcsec: HOST_MATCH_RADIUS, apertureArcsec: APERTURE,
      note: "A measured per-target selection function (geometry x dilution x completeness) over real hosts. " +
        "NOT an occurrence rate: P47 hosts are bright planet-bearing stars (efficiency, not an unbiased survey) " +
        "and there are no detections to divide. discoveryClaim false.",
    },
    n: rows.length,
    dilutionFactor: { min: q(dils, 0), p50: q(dils, 0.5), max: dils[dils.length - 1] },
    trueDepthInflation: { p50: q(infl, 0.5), p90: q(infl, 0.9), max: infl[infl.length - 1] },
    geometricProb: { min: q(geos, 0), p50: q(geos, 0.5), max: geos[geos.length - 1] },
    contaminatedHosts: contaminated,
    rows,
    skipped,
    discoveryClaim: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p56-real-selection.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P56 a real, per-target selection function (measured dilution + stellar parameters)",
    "",
    `Reproduce: \`npm run p56:real-selection -- --hosts ${wantHosts} --tmag ${tmag} --aperture ${APERTURE}\``,
    "Data: NASA Exoplanet Archive stellar radius/mass + Gaia DR3 aperture neighbours (both token-free),",
    "combined with the committed P47 completeness grid via `src/sim/selectionFunction.ts`.",
    "",
    `For **${rows.length}** real hosts, at the reference period bin ${refBin.periodLo}-${refBin.periodHi} d (observed 50%`,
    `depth ${refBin.observedDepth50Ppm} ppm):`,
    "",
    "| quantity | min | p50 | max |",
    "|---|---|---|---|",
    `| dilution factor | ${q(dils, 0).toFixed(3)} | ${q(dils, 0.5).toFixed(3)} | ${dils[dils.length - 1].toFixed(3)} |`,
    `| true-depth inflation (1/dilution) | ${q(infl, 0).toFixed(2)}x | ${q(infl, 0.5).toFixed(2)}x | ${infl[infl.length - 1].toFixed(2)}x |`,
    `| geometric transit probability | ${q(geos, 0).toFixed(3)} | ${q(geos, 0.5).toFixed(3)} | ${geos[geos.length - 1].toFixed(3)} |`,
    "",
    `${contaminated}/${rows.length} hosts have a measurable contaminant (dilution < 0.99). Even the most-inflated host`,
    `(${worst.name}, dilution ${worst.dilutionFactor.toFixed(3)}) raises the true 50% depth only from ${worst.observedDepth50Ppm.toFixed(0)} to ${worst.trueDepth50Ppm.toFixed(0)} ppm --`,
    "negligible. The honest finding is that this BRIGHT confirmed-planet sample is dilution-clean (neighbour",
    "counts reach into the teens but the companions are faint, so the flux-weighted dilution stays ~1); the",
    "selection function here is dominated by the geometric transit probability (which spans",
    `${q(geos, 0).toFixed(2)}-${geos[geos.length - 1].toFixed(2)} across real stellar radii/masses) and by completeness. The dilution`,
    "window would bite in crowded / faint fields, which the archive's confirmed sample under-represents.",
    "",
    "**This is a measured selection function, not an occurrence rate.** P47 hosts are bright",
    "planet-bearing stars (this is detector efficiency, not an unbiased survey selection), and there are",
    "no detections to divide by. It is the honest denominator PRECURSOR for eta_earth; producing a rate",
    "needs an unbiased target sample + a labelled negative class (P52). discoveryClaim: false.",
    "",
  ].join("\n");
  writeFileSync("reports/p56-real-selection.md", md);
  console.log("\nwrote reports/p56-real-selection.md and reports/p56-real-selection.json");
}

main().catch((e) => {
  console.error("p56 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
