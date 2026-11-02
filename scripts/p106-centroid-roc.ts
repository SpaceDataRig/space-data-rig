// P106 (discovery roadmap: does the pixel-centroid F-test have ANY operating point that actually separates
// blends from planets on the committed REAL labelled data? p104 showed that at alpha=0.001 it catches 0/59 blends,
// so it refused to promote it into the gate. p104 answered "not at that one threshold". p106 answers the harder,
// fairer question: not at ANY threshold?). It sweeps the stored, threshold-independent target p-values (pTarget,
// bestNeighbourP) over the 500 labelled rows and computes a Mann-Whitney AUC -- the probability a real blend has a
// LOWER target p-value than a real planet -- plus the Youden-optimal cut. AUC ~ 0.5 means the axis carries no
// usable signal at all; a high AUC would reveal a band worth pursuing (still NOT promoted without external imaging).
// Fully OFFLINE, deterministic, over committed real data.
//
// The stored pTarget / bestNeighbourP are rounded to 2 significant figures by scripts/p82-scaled-validation.ts;
// ties from that rounding are scored at 0.5 in AUC (standard Mann-Whitney), so the reported AUC is approximate to
// the storage precision and stated as such. Nothing is gated, anchored, claimed or deployed; discoveryClaim and
// safeToGate stay false -- this audits a discriminator's power, it does not announce a finding.
//
// Usage: npm run p106:centroid-roc
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";

const CENTROID_FIXTURE = "tests/fixtures/scaled/centroid.jsonl";
const PROTOCOL_PATH = "discovery-protocol.json";
const DEFAULT_ALPHA = 0.001; // the operating point p104 / scripts/p82 used

interface Row { label: string; testable: boolean; pTarget: number; bestNeighbourP: number; caught: boolean; falseReject: boolean; }

/** Mann-Whitney AUC: P(score_positive < score_negative) with 0.5 for ties. Here "positive" (blend) should have a
 *  LOWER target p-value, so AUC = P(pTarget_blend < pTarget_planet) + 0.5 P(equal). */
function mannWhitneyAuc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p < q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function main() {
  JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")); // stamp input; protocol context
  const rows = readFileSync(CENTROID_FIXTURE, "utf8").replace(/\r/g, "").trim().split("\n").map((l) => JSON.parse(l) as Row);
  const blendsAll = rows.filter((r) => r.label === "blend");
  const planetsAll = rows.filter((r) => r.label === "planet");
  const blends = blendsAll.filter((r) => r.testable).map((r) => r.pTarget);
  const planets = planetsAll.filter((r) => r.testable).map((r) => r.pTarget);

  // Continuity with p104: at the DEFAULT operating point, blend catch-rate and planet false-reject-rate.
  const caughtAtDefault = blendsAll.filter((r) => r.testable && r.pTarget < DEFAULT_ALPHA && r.bestNeighbourP >= DEFAULT_ALPHA).length;
  const falseRejectAtDefault = planets.filter((p) => p < DEFAULT_ALPHA).length;

  // AUC of the target p-value as a blend-vs-planet discriminator (lower = more blend-like / off-target).
  const aucTarget = Number(mannWhitneyAuc(blends, planets).toFixed(4));
  // A secondary discriminator: is a viable neighbour consistent (higher bestNeighbourP = a blend explains the dip).
  const blendsNb = blendsAll.filter((r) => r.testable).map((r) => r.bestNeighbourP);
  const planetsNb = planetsAll.filter((r) => r.testable).map((r) => r.bestNeighbourP);
  const aucNeighbour = Number(mannWhitneyAuc(planetsNb, blendsNb).toFixed(4)); // higher neighbourP -> blend, so flip

  // Youden-optimal threshold on pTarget: maximise sens + spec - 1 over every observed p-value as a cut.
  const cuts = Array.from(new Set([...blends, ...planets])).sort((a, b) => a - b);
  let best = { alpha: Number.NaN, sens: 0, spec: 0, j: -Infinity };
  for (const a of cuts) {
    const sens = blends.filter((p) => p < a).length / blends.length;                 // blends correctly flagged off-target
    const spec = planets.filter((p) => p >= a).length / planets.length;              // planets correctly kept
    const j = sens + spec - 1;
    if (j > best.j) best = { alpha: a, sens, spec, j };
  }

  // Honest classification of the axis's power.
  const auc = aucTarget;
  const power = !Number.isFinite(auc) ? "undefined" : auc > 0.7 ? "usable" : auc > 0.6 ? "weak" : "none";
  const usable = power === "usable" && best.j >= 0.4;
  const verdict = `P106-CENTROID-ROC (does the pixel-centroid F-test discriminate blends from planets at ANY threshold, over ${blends.length + planets.length} labelled testable real sources): target-p-value AUC = ${auc.toFixed(3)} (${power} separation); neighbour-consistency AUC = ${aucNeighbour.toFixed(3)}. At the operating point p104 used (alpha=${DEFAULT_ALPHA}) it caught ${caughtAtDefault}/${blends.length} blends while wrongly rejecting ${falseRejectAtDefault}/${planets.length} planets. The Youden-optimal cut (alpha=${Number.isFinite(best.alpha) ? best.alpha.toExponential(2) : "n/a"}) reaches sensitivity ${best.sens.toFixed(2)} / specificity ${best.spec.toFixed(2)} (J=${best.j.toFixed(2)}). Conclusion: ${usable ? "a usable band exists -> candidate axis, but NOT promoted without external imaging" : "the centroid target test carries NO usable blend/planet separation on this real data at any threshold -> it cannot be promoted into the gate, confirming p104 with a full ROC rather than one operating point"}. discoveryClaim false, safeToGate false.`;
  console.log(`  testable: blends ${blends.length}, planets ${planets.length}`);
  console.log(`  AUC(target p) = ${auc.toFixed(3)} [${power}]   AUC(neighbour) = ${aucNeighbour.toFixed(3)}`);
  console.log(`  @alpha=${DEFAULT_ALPHA}: caught ${caughtAtDefault}/${blends.length}, falseReject ${falseRejectAtDefault}/${planets.length}`);
  console.log(`  Youden best: alpha=${Number.isFinite(best.alpha) ? best.alpha.toExponential(2) : "n/a"} sens=${best.sens.toFixed(3)} spec=${best.spec.toFixed(3)} J=${best.j.toFixed(3)}`);
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p106-centroid-roc.ts", PROTOCOL_PATH, CENTROID_FIXTURE]),
      generatedBy: "scripts/p106-centroid-roc.ts", module: "centroid F-test (src/detect centroidFtest via scripts/p82-scaled-validation.ts)",
      data: "committed REAL pixel-centroid F-test checkpoint (tests/fixtures/scaled/centroid.jsonl), labelled planet/blend on real TESS+Gaia data. AUC over 2-sig-fig stored p-values. Fully offline, deterministic.",
      note: "ROC/separability audit of the centroid axis: does it discriminate at ANY threshold. discoveryClaim false, safeToGate false.",
    },
    nTestableBlends: blends.length, nTestablePlanets: planets.length,
    aucTarget, aucNeighbour, power, usable,
    defaultAlpha: DEFAULT_ALPHA, caughtAtDefault, falseRejectAtDefault,
    youden: { alpha: Number.isFinite(best.alpha) ? best.alpha : null, sensitivity: Number(best.sens.toFixed(4)), specificity: Number(best.spec.toFixed(4)), j: Number(best.j.toFixed(4)) },
    verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p106-centroid-roc.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P106 - Centroid F-test ROC: does it separate blends from planets at ANY threshold?",
    "",
    "Generated by `scripts/p106-centroid-roc.ts`. p104 refused to promote the pixel-centroid F-test because at",
    "alpha=0.001 it caught 0 of 59 testable blends. p106 asks whether some OTHER threshold rescues it: it sweeps",
    `the stored, threshold-free target p-values over ${blends.length} testable blends and ${planets.length} testable planets (real labelled data) and reports a Mann-Whitney AUC plus the Youden-optimal cut. Fully offline over a committed fixture.`,
    "",
    `Reproduce: \`npm run p106:centroid-roc\``,
    "",
    `- AUC of the target p-value (blend vs planet): **${auc.toFixed(3)}** -> ${power} separation.`,
    `- Neighbour-consistency AUC: ${aucNeighbour.toFixed(3)}.`,
    `- At alpha=${DEFAULT_ALPHA} (p104's point): caught ${caughtAtDefault}/${blends.length}, wrongly rejected ${falseRejectAtDefault}/${planets.length}.`,
    `- Youden-optimal: alpha=${Number.isFinite(best.alpha) ? best.alpha.toExponential(2) : "n/a"}, sensitivity ${best.sens.toFixed(2)}, specificity ${best.spec.toFixed(2)} (J=${best.j.toFixed(2)}).`,
    "",
    "Note on precision: the checkpoint stores p-values to 2 significant figures, so AUC ties from rounding are",
    "scored at 0.5; the AUC is approximate to that storage precision.",
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: 'we did not promote it because it caught nothing at one threshold' is stronger when we show",
    "there is no threshold where it works. That is what this measures. Research-only; nothing gated, anchored,",
    "claimed, or deployed. `safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p106-centroid-roc.md", md);
  console.log("\nwrote reports/p106-centroid-roc.md and .json");
}

main();
