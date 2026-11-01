// P104 (discovery roadmap: an HONEST capability audit of the two gate corroboration axes still un-fed).
// p101/p102/p103 fed cross-sector, shape and significance with real measured values, but two corroboration
// bars in the frozen protocol -- gaiaBlendRuledOut and psfOrDiffImagingClear -- were still left conservative
// (false). R38 asks the honest question: can those two be fed from the committed REAL measurements we already
// hold? It measures, per axis, exactly how much decisive evidence the data actually carries, rather than
// promoting a discriminator that has not earned it.
//
// Two committed real sources are used, fully OFFLINE and deterministic:
//   - tests/fixtures/live-gaia-rv.json  (Gaia DR3 TAP: two-body orbit + RV + non-single-star, graded by the
//     calibrated src/data/gaiaRv.ts rvAstrometryVsCandidate at capture time)
//   - tests/fixtures/scaled/centroid.jsonl (the pixel-centroid F-test at alpha=0.001, per src/... centroidFtest,
//     produced by scripts/p82-scaled-validation.ts on 500 labelled real sources)
//
// The honest finding is a NEGATIVE / capability-boundary result, NOT a promotion: on this committed data Gaia
// returns "unknown" for every host with data (no orbit at the candidate period -> it can neither rule out nor
// corroborate a blend), and the centroid F-test CATCHES 0 of the 392 labelled blends (the p77/p84 asymmetry at
// scale), so wiring centroid into psfOrDiffImagingClear would declare most real blends "clear" -- a rubber stamp.
// The gate therefore must keep both axes conservative; promoting either would weaken, not strengthen, a claim.
// Nothing is gated, anchored, claimed or deployed; discoveryClaim/safeToGate stay false.
//
// Usage: npm run p104:corroboration-capability
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { evaluateDiscoveryGate, type CandidateEvidence, type DiscoveryProtocol } from "../src/discover/discoveryGate.ts";

const GAIA_FIXTURE = "tests/fixtures/live-gaia-rv.json"; // forward-slash literals (buildStamp + git ls-files cross-platform)
const CENTROID_FIXTURE = "tests/fixtures/scaled/centroid.jsonl";
const PROTOCOL_PATH = "discovery-protocol.json";
const ALPHA = 0.001; // the centroid catch bar scripts/p82-scaled-validation.ts wrote these rows with

interface GaiaCase { plName: string; tic: number; periodDays: number; ebExclusion: "excluded" | "supported" | "unknown"; blendCorroborated: boolean; periodMatched: boolean; }
interface CentroidRow { tic: number; toi: string; label: string; testable: boolean; pTarget: number; viableNeighbours: number; bestNeighbourP: number; falseReject: boolean; caught: boolean; }

/** psfOrDiffImagingClear as the centroid F-test defines it: the flux is consistent with the TARGET (not an
 *  off-target blend) when the source is testable AND the target p-value is above the catch bar. */
function centroidClears(r: CentroidRow): boolean { return r.testable && r.pTarget >= ALPHA; }

function main() {
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  const gaia = JSON.parse(readFileSync(GAIA_FIXTURE, "utf8")) as { considered: number; withGaiaData: number; cases: GaiaCase[] };
  const rows = readFileSync(CENTROID_FIXTURE, "utf8").replace(/\r/g, "").trim().split("\n").map((l) => JSON.parse(l) as CentroidRow);

  // Gaia decisive coverage
  const ruledOut = gaia.cases.filter((c) => c.ebExclusion === "excluded").length;
  const corroborated = gaia.cases.filter((c) => c.ebExclusion === "supported").length;
  const unknown = gaia.cases.filter((c) => c.ebExclusion === "unknown").length;
  const gaiaDecisive = ruledOut + corroborated;

  // Centroid discrimination
  const blends = rows.filter((r) => r.label === "blend");
  const planets = rows.filter((r) => r.label === "planet");
  const blendsTestable = blends.filter((r) => r.testable);
  const planetsTestable = planets.filter((r) => r.testable);
  const caught = blendsTestable.filter((r) => r.caught).length;               // real blends the test rejects
  const falseReject = planetsTestable.filter((r) => r.falseReject).length;    // real planets wrongly rejected
  const blendWouldClear = blendsTestable.filter((r) => centroidClears(r)).length; // real blends the test would call CLEAR (the rubber-stamp count)
  const planetWouldClear = planetsTestable.filter((r) => centroidClears(r)).length;
  const blendCatchRate = blendsTestable.length ? caught / blendsTestable.length : 0;

  // The gate, fed the two axes for real, on the 3 hosts both sources cover -- and the honest refusal that follows.
  const byTic = new Map<number, CentroidRow>(rows.map((r) => [r.tic, r]));
  const overlap = gaia.cases.map((c) => c.tic).filter((t) => byTic.has(t));
  const gateRows: { tic: number; pl: string; gaiaBlendRuledOut: boolean; psfClear: boolean; centroidTestable: boolean; tier: string; unmetCount: number }[] = [];
  for (const tic of overlap) {
    const gc = gaia.cases.find((c) => c.tic === tic)!;
    const cr = byTic.get(tic)!;
    const gaiaBlendRuledOut = gc.ebExclusion === "excluded";
    const psfClear = centroidClears(cr);
    const evidence: CandidateEvidence = {
      novelty: { inConfirmed: true, inToi: true, confirmedScanned: 5200, toiScanned: 4100 }, // catalogued TOI planets
      corroboration: {
        crossSectorEphemerisCoherentSectors: 0, catalogDuplicate: true, gaiaBlendRuledOut, psfOrDiffImagingClear: psfClear,
        harmonicAliasFpp: Number.NaN, oddEvenAsymmetryFrac: Number.NaN,
      },
      significance: { snr: Number.NaN, ar1FalseAlarmProb: Number.NaN }, // not measured on these hosts -> conservative
      prospective: null, signoff: null,
    };
    const g = evaluateDiscoveryGate(evidence, proto);
    gateRows.push({ tic, pl: gc.plName, gaiaBlendRuledOut, psfClear, centroidTestable: cr.testable, tier: g.tier, unmetCount: g.unmet.length });
  }
  const allNone = gateRows.length > 0 && gateRows.every((r) => r.tier === "none");
  // Counterfactual DANGER: if psfOrDiffImagingClear were wired from centroid, how many REAL blends pass the PSF bar?
  const verdict = `P104-CORROBORATION-CAPABILITY (both remaining gate axes measured on committed real data, offline): Gaia carries a DECISIVE ruling on ${gaiaDecisive}/${gaia.cases.length} hosts with data (${ruledOut} blend-ruled-out, ${corroborated} blend-corroborated, ${unknown} unknown) -> it can feed NO favourable blend evidence here. The pixel-centroid F-test at alpha=${ALPHA} catches ${caught}/${blendsTestable.length} real blends (catch rate ${(blendCatchRate * 100).toFixed(1)}%) while wrongly rejecting ${falseReject}/${planetsTestable.length} real planets; run as psfOrDiffImagingClear it would declare ${blendWouldClear}/${blendsTestable.length} genuine blends "clear" -- a rubber stamp, so it must NOT be promoted. Feeding both axes their honest measured values to the gate, every one of the ${gateRows.length} hosts covered by BOTH sources still lands tier none (${allNone ? "verified" : "CHECK"}). The two bars stay conservative on committed data; the real unlock is external (Gaia orbits AT the candidate period; centroid precision/WCS), not a code change. No claim, no gate.`;
  console.log(`  gaia: considered ${gaia.considered}, withData ${gaia.withGaiaData}, decisive ${gaiaDecisive} (excluded ${ruledOut}, supported ${corroborated}, unknown ${unknown})`);
  console.log(`  centroid: ${rows.length} rows, blends ${blends.length} (testable ${blendsTestable.length}, caught ${caught}, wouldClear ${blendWouldClear}), planets ${planets.length} (testable ${planetsTestable.length}, falseReject ${falseReject}, wouldClear ${planetWouldClear})`);
  for (const r of gateRows) console.log(`  host ${r.tic} (${r.pl}) gaiaRuledOut=${r.gaiaBlendRuledOut} psfClear=${r.psfClear} testable=${r.centroidTestable}  tier=${r.tier} (unmet ${r.unmetCount})`);
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p104-corroboration-capability.ts", PROTOCOL_PATH, GAIA_FIXTURE, CENTROID_FIXTURE]),
      generatedBy: "scripts/p104-corroboration-capability.ts", module: "src/discover/discoveryGate.ts + src/data/gaiaRv.ts + centroidFtest",
      data: "committed REAL Gaia DR3 RV/orbit census + REAL pixel-centroid F-test checkpoint (500 labelled sources). Fully offline, deterministic.",
      note: "honest capability audit: the two remaining gate corroboration axes cannot be favourably fed from committed data. discoveryClaim false, safeToGate false.",
    },
    alpha: ALPHA,
    gaia: { considered: gaia.considered, withData: gaia.withGaiaData, decisive: gaiaDecisive, ruledOut, corroborated, unknown },
    centroid: { total: rows.length, blends: blends.length, blendsTestable: blendsTestable.length, caught, blendWouldClear, blendCatchRate, planets: planets.length, planetsTestable: planetsTestable.length, falseReject, planetWouldClear },
    gateOverlapHosts: gateRows.length, allNone, rows: gateRows, verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p104-corroboration-capability.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P104 - Corroboration capability audit (can the last two gate axes be fed honestly from committed real data?)",
    "",
    "Generated by `scripts/p104-corroboration-capability.ts`. Fully offline over two committed REAL sources:",
    "the Gaia DR3 RV/orbit census (`tests/fixtures/live-gaia-rv.json`, graded by `src/data/gaiaRv.ts`) and the",
    "pixel-centroid F-test checkpoint (`tests/fixtures/scaled/centroid.jsonl`, alpha=0.001, from",
    "`scripts/p82-scaled-validation.ts`). This is a capability-boundary (negative) result, not a promotion.",
    "",
    `Reproduce: \`npm run p104:corroboration-capability\``,
    "",
    `- Gaia: ${gaia.withGaiaData} hosts with data, decisive rulings ${gaiaDecisive} (blend-ruled-out ${ruledOut}, blend-corroborated ${corroborated}, unknown ${unknown}).`,
    `- Centroid: of ${blendsTestable.length} testable labelled blends it CAUGHT ${caught} (${(blendCatchRate * 100).toFixed(1)}%) and would call ${blendWouldClear} "clear"; of ${planetsTestable.length} testable planets it wrongly rejected ${falseReject}.`,
    `- Gate fed both axes for real: all ${gateRows.length} hosts covered by BOTH sources -> tier none (${allNone ? "verified" : "CHECK"}).`,
    "",
    "| host (tic) | pl | gaia blend ruled out | centroid psf clear | centroid testable | tier |",
    "|---|---|---|---|---|---|",
    ...gateRows.map((r) => `| ${r.tic} | ${r.pl} | ${r.gaiaBlendRuledOut} | ${r.psfClear} | ${r.centroidTestable} | ${r.tier} |`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: retiring a NaN placeholder only helps if the real measurement is DECISIVE. Here neither axis",
    "is -- Gaia has no orbit at the candidate period, and the centroid test does not discriminate blends from planets",
    "on this data -- so the gate must keep both bars conservative rather than count a rubber stamp as corroboration.",
    "Research-only; nothing gated, anchored, claimed, or deployed.",
    "`safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p104-corroboration-capability.md", md);
  console.log("\nwrote reports/p104-corroboration-capability.md and .json");
}

main();
