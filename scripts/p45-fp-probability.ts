// P45: run the reduced false-positive probability on REAL confirmed planets and characterise it.
//
// The module (src/candidate/falsePositiveProbability.ts) turns a measured Gaia neighbour list + an
// observed depth into a blended-eclipsing-binary false-positive probability. Before anyone trusts it,
// we must measure how it behaves on planets we KNOW are real: many genuine planet hosts sit near a
// faint neighbour, so a naive "a neighbour could mimic it -> high P(FP)" rule would wrongly flag true
// planets. This script quantifies exactly that -- the fraction of confirmed planets the crude prior
// elevates -- and states the limitation honestly. It does NOT gate anything; it is a measurement.
//
// Chain (token-free): confirmed planet (ra/dec, depth) --(Gaia cone)--> host + neighbours
//   --(assessFalsePositive)--> P(FP). A source with no Gaia match is skipped; nothing is fabricated.
//
// Usage:
//   npm run p45:fp-probability
//   npm run p45:fp-probability -- --targets 20 --tmag 10 --aperture 21
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchGaiaNeighborhood, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { assessFalsePositive, type BlendNeighbor } from "../src/candidate/falsePositiveProbability.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(argNum("targets", 16));
const tmag = argNum("tmag", 10);
const aperture = argNum("aperture", 21);

function usable(p: ArchivePlanet): boolean {
  return Number.isFinite(p.ra) && Number.isFinite(p.dec) && Number.isFinite(p.pl_trandep) && p.pl_trandep! > 0;
}

function q(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

interface Row {
  name: string;
  depthPpm: number;
  hostGmag: number;
  nNeighbours: number;
  nViable: number;
  pBlend: number;
  pFalsePositive: number;
}

const MODULE = "src/candidate/falsePositiveProbability.ts";
const PRIORS = "literature (ebFraction 0.11, geoProb 0.3, onTarget 0.02)";
interface Skipped { name: string; why: string; }

/** The PURE aggregate. Every published figure is a deterministic function of the per-planet rows -- the P(FP)
 *  quantiles via sort + integer-index selection over the stored full-precision values, and the with-viable /
 *  high-FP counts via thresholds. The same code path runs whether the rows came from a live Gaia measurement or
 *  the frozen fixture, so the report is re-DERIVED, not copied (the p41/p71/p65 discipline). */
function derive(rows: Row[]) {
  const pfp = rows.map((r) => r.pFalsePositive).sort((a, b) => a - b);
  const withViableBlend = rows.filter((r) => r.nViable > 0).length;
  const highFpCount = rows.filter((r) => r.pFalsePositive > 0.5).length;
  return {
    n: rows.length,
    pfp,
    pFalsePositive: { min: pfp[0], p50: q(pfp, 0.5), p90: q(pfp, 0.9), max: pfp[pfp.length - 1] },
    withViableBlend,
    highFpCount,
    highFpFraction: highFpCount / rows.length,
  };
}

/** LIVE measurement: fetch the catalog + a Gaia cone per planet, run assessFalsePositive. */
async function measureLive(): Promise<{ rows: Row[]; skipped: Skipped[] }> {
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable)`);
  const picked = cat.planets.filter(usable).slice(0, want);
  console.log(`queued ${picked.length} planets from ${cat.planets.length} catalog rows\n`);

  const rows: Row[] = [];
  const skipped: Skipped[] = [];
  for (const p of picked) {
    const name = p.pl_name ?? p.hostname ?? `planet ${p.tic ?? "?"}`;
    try {
      const sources = await fetchGaiaNeighborhood(p.ra!, p.dec!, { radiusDeg: (aperture + 5) / 3600 });
      if (sources.length === 0) {
        skipped.push({ name, why: "no Gaia sources returned" });
        continue;
      }
      // host = nearest Gaia source to the catalog position (within 2"); everything else is a neighbour
      let hostIdx = -1;
      let hostSep = Infinity;
      for (let i = 0; i < sources.length; i++) {
        const sep = angularSepArcsec(p.ra!, p.dec!, sources[i].ra, sources[i].dec);
        if (sep < hostSep) {
          hostSep = sep;
          hostIdx = i;
        }
      }
      if (hostIdx < 0 || hostSep > 2) {
        skipped.push({ name, why: `no Gaia host within 2" (nearest ${hostSep.toFixed(2)}")` });
        continue;
      }
      const hostGmag = sources[hostIdx].gmag;
      const neighbours: BlendNeighbor[] = [];
      for (let i = 0; i < sources.length; i++) {
        if (i === hostIdx) continue;
        const sep = angularSepArcsec(p.ra!, p.dec!, sources[i].ra, sources[i].dec);
        if (sep <= aperture) neighbours.push({ gmag: sources[i].gmag, sepArcsec: sep });
      }
      const a = assessFalsePositive(p.pl_trandep! / 1e6, hostGmag, neighbours, {
        ebFraction: 0.11,
        eclipseGeoProb: 0.3,
        ebDepthMin: 0.01,
        ebDepthMax: 0.9,
        onTargetEbPrior: 0.02,
        apertureArcsec: aperture,
        source: "literature priors; neighbours measured from Gaia DR3",
      });
      rows.push({ name, depthPpm: p.pl_trandep!, hostGmag, nNeighbours: neighbours.length, nViable: a.viableBlends.length, pBlend: a.pBlend, pFalsePositive: a.pFalsePositive });
      console.log(`${name.padEnd(20)} G=${hostGmag.toFixed(1)} depth=${p.pl_trandep!.toFixed(0)}ppm nbrs=${neighbours.length} viable=${a.viableBlends.length} P(FP)=${a.pFalsePositive.toFixed(3)}`);
    } catch (e) {
      skipped.push({ name, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return { rows, skipped };
}

async function main() {
  // FROZEN DATA SOURCE -- the p41/p71/p65 precedent, applied here. p45 measures against LIVE Gaia cones; a plain
  // re-run re-fetches and can move a P(FP) (the p90 drift lesson). The per-planet measurements are therefore frozen
  // into reports/fixtures/p45-frozen-rows.json (a committed snapshot, dated at measurement) and the DEFAULT
  // re-DERIVES every quantile/count OFFLINE from those rows through the same deterministic formulas. `--live`
  // (or `--from-json=`) is the deliberate re-measure.
  const FROZEN = "reports/fixtures/p45-frozen-rows.json";
  const live = process.argv.includes("--live");
  const fromArg = (process.argv.find((a) => a.startsWith("--from-json=")) || "").split("=")[1];
  const REPLAY = live ? "" : (fromArg !== undefined ? fromArg : FROZEN);

  console.log(`P45 false-positive probability on confirmed planets (tmag<${tmag}, aperture ${aperture}")`);
  let rows: Row[];
  let skipped: Skipped[];
  let measuredAt: string;
  if (REPLAY && existsSync(REPLAY)) {
    const j = JSON.parse(readFileSync(REPLAY, "utf8")) as { rows: Row[]; skipped?: Skipped[]; measuredAt?: string };
    rows = j.rows;
    skipped = j.skipped ?? [];
    measuredAt = j.measuredAt ?? "unknown";
    console.log(`P45 OFFLINE REPLAY from ${REPLAY}: ${rows.length} stored planets, original measurement ${measuredAt}. No network, no re-fetch.`);
  } else {
    const m = await measureLive();
    rows = m.rows;
    skipped = m.skipped;
    measuredAt = new Date().toISOString();
  }

  console.log("");
  if (rows.length === 0) {
    console.log("no measurable rows (Gaia/network unavailable) -- cannot characterise in this environment.");
    return;
  }

  const d = derive(rows);
  console.log(`characterised ${d.n} confirmed planets (all are REAL planets, so a low P(FP) is expected):`);
  console.log(`  P(FP): min=${d.pfp[0].toFixed(3)} p50=${q(d.pfp, 0.5).toFixed(3)} p90=${q(d.pfp, 0.9).toFixed(3)} max=${d.pfp[d.pfp.length - 1].toFixed(3)}`);
  console.log(`  ${d.withViableBlend}/${d.n} have >=1 neighbour that COULD be a diluted blend; ${d.highFpCount}/${d.n} get P(FP)>0.5 despite being real.`);
  console.log(`  VERDICT: P45-CHARACTERISED (on this bright, isolated confirmed-planet sample the blend prior flags ${d.highFpCount}/${d.n} real planets above 0.5; ${d.highFpCount === 0 ? "a clean no-false-alarm sanity check, but these uncrowded hosts do not exercise the crowded-field regime, so discrimination is untested here" : "the crude prior over-flags real planets -> prior-dependent"}) -> P(FP) ranks, it does not validate`);

  const json = {
    meta: {
      // Replay stamps the SCRIPT + the FROZEN rows (both tracked -> a clean checkout re-hashes them -> verified), NOT the
      // Gaia/archive modules, so a catalog or Gaia update cannot mark this cited report stale and force a drift-inducing
      // re-fetch; `--live` stamps the modules because there they really produced the numbers (p75 discipline).
      ...buildStamp(REPLAY
        ? ["scripts/p45-fp-probability.ts", FROZEN]
        : ["src/data/exoplanetArchive.ts", "src/data/gaiaDilution.ts", "src/candidate/falsePositiveProbability.ts", "scripts/p45-fp-probability.ts"]),
      generatedBy: "scripts/p45-fp-probability.ts", tmag, aperture,
      module: MODULE, priors: PRIORS,
      measuredAt,
      data: REPLAY
        ? "FROZEN snapshot of real Gaia DR3 neighbour measurements of confirmed planets, replayed offline -- the live run as measured, not re-fetched"
        : "real Gaia DR3 neighbours of confirmed planets",
    },
    n: d.n,
    pFalsePositive: d.pFalsePositive,
    withViableBlend: d.withViableBlend,
    highFpCount: d.highFpCount,
    highFpFraction: d.highFpFraction,
    safeToGate: false,
    discoveryClaim: false,
    rows,
    skipped,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p45-fp-probability.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P45 false-positive probability characterised on confirmed planets",
    "",
    `Reproduce: \`npm run p45:fp-probability -- --targets ${want} --tmag ${tmag} --aperture ${aperture}\``,
    "Data: real Gaia DR3 neighbours of confirmed planets. Module: `src/candidate/falsePositiveProbability.ts`.",
    REPLAY
      ? `OFFLINE REPLAY: figures re-DERIVED from \`reports/fixtures/p45-frozen-rows.json\` (a committed snapshot of the live Gaia measurements, taken ${measuredAt}); \`--live\` re-measures.`
      : `LIVE re-measure: real Gaia DR3 cones run through the module at run time (${measuredAt}).`,
    "Every row here is a REAL planet, so the honest question is how often the blended-EB prior wrongly",
    "elevates P(FP).",
    "",
    `Characterised **${d.n}** confirmed planets:`,
    "",
    "| P(FP) | min | p50 | p90 | max |",
    "|---|---|---|---|---|",
    `| across real planets | ${d.pfp[0].toFixed(3)} | ${q(d.pfp, 0.5).toFixed(3)} | ${q(d.pfp, 0.9).toFixed(3)} | ${d.pfp[d.pfp.length - 1].toFixed(3)} |`,
    "",
    `- **${d.withViableBlend}/${d.n}** real planets have at least one Gaia neighbour that *could* be a diluted blend.`,
    `- **${d.highFpCount}/${d.n}** real planets were pushed above P(FP) > 0.5 by that neighbour + a literature EB prior.`,
    "",
    "Honest conclusion: P(FP) here is a **prior-dependent ranking / triage** quantity, NOT a validation and NOT",
    "safe to gate. A neighbour existing does not mean it is an eclipsing binary; these uncrowded bright hosts do",
    "not exercise the crowded-field regime where the blended-EB impostor actually bites, so the discriminating test",
    "is on blind / crowded candidates (future work). A discovery-grade version needs a measured EB depth function",
    "and resolved-photometry contrast limits, not order-of-magnitude priors. `safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p45-fp-probability.md", md);
  console.log("\nwrote reports/p45-fp-probability.md and reports/p45-fp-probability.json");
}

main().catch((e) => {
  console.error("p45 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
