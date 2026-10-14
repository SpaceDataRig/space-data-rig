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
import { writeFileSync, mkdirSync } from "node:fs";
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

async function main() {
  console.log(`P45 false-positive probability on confirmed planets (tmag<${tmag}, aperture ${aperture}")`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable)`);
  const picked = cat.planets.filter(usable).slice(0, want);
  console.log(`queued ${picked.length} planets from ${cat.planets.length} catalog rows\n`);

  const rows: Row[] = [];
  const skipped: { name: string; why: string }[] = [];

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

  console.log("");
  if (rows.length === 0) {
    console.log("no measurable rows (Gaia/network unavailable) -- cannot characterise in this environment.");
    return;
  }

  const pfp = rows.map((r) => r.pFalsePositive).sort((a, b) => a - b);
  const withViable = rows.filter((r) => r.nViable > 0).length;
  const highFP = rows.filter((r) => r.pFalsePositive > 0.5).length;
  console.log(`characterised ${rows.length} confirmed planets (all are REAL planets, so a low P(FP) is expected):`);
  console.log(`  P(FP): min=${pfp[0].toFixed(3)} p50=${q(pfp, 0.5).toFixed(3)} p90=${q(pfp, 0.9).toFixed(3)} max=${pfp[pfp.length - 1].toFixed(3)}`);
  console.log(`  ${withViable}/${rows.length} have >=1 neighbour that COULD be a diluted blend; ${highFP}/${rows.length} get P(FP)>0.5 despite being real.`);
  console.log(`  VERDICT: P45-CHARACTERISED (on this bright, isolated confirmed-planet sample the blend prior flags ${highFP}/${rows.length} real planets above 0.5; ${highFP === 0 ? "a clean no-false-alarm sanity check, but these uncrowded hosts do not exercise the crowded-field regime, so discrimination is untested here" : "the crude prior over-flags real planets -> prior-dependent"}) -> P(FP) ranks, it does not validate`);

  const json = {
    meta: { generatedBy: "scripts/p45-fp-probability.ts", tmag, aperture, data: "real Gaia DR3 neighbours of confirmed planets", module: "src/candidate/falsePositiveProbability.ts", priors: "literature (ebFraction 0.11, geoProb 0.3, onTarget 0.02)" },
    n: rows.length,
    pFalsePositive: { min: pfp[0], p50: q(pfp, 0.5), p90: q(pfp, 0.9), max: pfp[pfp.length - 1] },
    withViableBlend: withViable,
    highFpCount: highFP,
    highFpFraction: highFP / rows.length,
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
    "Every row here is a REAL planet, so the honest question is how often the blended-EB prior wrongly",
    "elevates P(FP).",
    "",
    `Characterised **${rows.length}** confirmed planets:`,
    "",
    "| P(FP) | min | p50 | p90 | max |",
    "|---|---|---|---|---|",
    `| across real planets | ${pfp[0].toFixed(3)} | ${q(pfp, 0.5).toFixed(3)} | ${q(pfp, 0.9).toFixed(3)} | ${pfp[pfp.length - 1].toFixed(3)} |`,
    "",
    `- **${withViable}/${rows.length}** real planets have at least one Gaia neighbour that *could* be a diluted blend.`,
    `- **${highFP}/${rows.length}** real planets were pushed above P(FP) > 0.5 by that neighbour + a literature EB prior.`,
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
