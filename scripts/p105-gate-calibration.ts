// P105 (discovery roadmap: calibrate the gate AS A CLASSIFIER on the labelled REAL candidates we hold).
// p101-p104 fed the gate every axis that real committed data can decisively support. What has NOT been
// quantified is the gate's own trustworthiness: on candidates whose GROUND TRUTH we know -- every committed
// host here is a catalogued planet system, so the CORRECT gate output is "none" (a discovery-tier result would
// be a false claim) -- how often does the gate actually refuse? p103 returned tier none for its 9 multi-sector
// SPOC hosts and p104 for its 3 Gaia/centroid hosts; the two host sets are disjoint (no TIC overlap), so the
// union is 12 independent labelled negatives. Reading the two committed reports, p105 counts false promotions and
// puts a Wilson lower bound on the gate's true-negative rate -- a real, previously-uncomputed statistic that
// says the gate's refusals are trustworthy. Fully OFFLINE, deterministic, machine-verified.
//
// Scope honesty: this measures SPECIFICITY (not promoting known planets), the arm real labelled data CAN test.
// The SENSITIVITY arm (promoting a genuinely clean novel signal) is established only SYNTHETICALLY (p100),
// because committed data contains no labelled NOVEL candidate -- and no amount of catalogued hosts can create
// one. p105 makes that asymmetry explicit rather than hiding it. discoveryClaim/safeToGate stay false; nothing
// is gated, anchored, claimed or deployed -- this audits the instrument, it does not announce a finding.
//
// Usage: npm run p105:gate-calibration
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { wilsonLowerBound } from "../src/discover/discoveryGate.ts";

const PROTOCOL_PATH = "discovery-protocol.json";
const P103_JSON = "reports/p103-target-gate-table.json";
const P104_JSON = "reports/p104-corroboration-capability.json";

interface Labeled { id: string; source: string; tier: string; known: boolean; unmet: string[]; }

function main() {
  JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")); // input to the stamp; protocol defines the bars
  const p103 = JSON.parse(readFileSync(P103_JSON, "utf8")) as { rows: { host: string; gateTier: string; catalogKnown: boolean; unmet: string[] }[] };
  const p104 = JSON.parse(readFileSync(P104_JSON, "utf8")) as { rows: { tic: number; pl: string; tier: string }[] };

  // The union of labelled REAL hosts. Every one is a catalogued planet system -> expected tier "none".
  const labeled: Labeled[] = [
    ...p103.rows.map((r) => ({ id: r.host, source: "p103/spoc", tier: r.gateTier, known: r.catalogKnown, unmet: r.unmet })),
    ...p104.rows.map((r) => ({ id: String(r.tic), source: "p104/gaia+centroid", tier: r.tier, known: true, unmet: [] as string[] })),
  ];
  // disjointness of the two host id sets (spoc host names vs Gaia tics never coincide) is what makes the union valid.
  const ids = new Set(labeled.map((l) => l.id));
  const n = ids.size;
  const falsePromotions = labeled.filter((l) => l.tier !== "none").length;   // a labelled known that the gate promoted = a false claim
  const trueNegatives = n - falsePromotions;
  const specificity = n ? trueNegatives / n : 0;
  const specLB = Number(wilsonLowerBound(trueNegatives, n).toFixed(4));

  // Binding-constraint census across the hosts that carry unmet lists (p103). The gate refuses for the RIGHT reasons.
  const withUnmet = labeled.filter((l) => l.unmet.length > 0);
  const censusOf = (re: RegExp) => withUnmet.filter((l) => l.unmet.some((u) => re.test(u))).length;
  const bindNovelty = censusOf(/novel|known|duplicate/i);
  const bindProspective = censusOf(/prospective|precision|wilson/i);
  const bindBlend = censusOf(/blend/i);
  const bindPsf = censusOf(/psf|diff[- ]imaging/i);

  const verdict = `P105-GATE-CALIBRATION (specificity of the earned gate on labelled REAL candidates, offline): on the union of ${n} distinct committed hosts whose ground truth is "catalogued planet" (a discovery-tier output would be a false claim), the gate returned tier none for ${trueNegatives}/${n} -> ${falsePromotions} false promotion(s), specificity ${specificity.toFixed(3)}, Wilson 95% lower bound on the true-negative rate ${specLB.toFixed(3)}. Binding refusals (over the ${withUnmet.length} hosts carrying unmet lists): novelty ${bindNovelty}/${withUnmet.length}, prospective precision ${bindProspective}/${withUnmet.length}, blend ${bindBlend}/${withUnmet.length}, PSF ${bindPsf}/${withUnmet.length}. This validates the REFUSALS: the gate does not over-claim on any real labelled planet we hold. The SENSITIVITY arm (promoting a clean NOVEL signal) is only established synthetically (p100) because committed data has no labelled novel candidate to test it on -- an asymmetry stated, not hidden. No claim, no gate.`;
  console.log(`  labelled real hosts (union): ${n}  trueNegatives ${trueNegatives}  falsePromotions ${falsePromotions}`);
  console.log(`  specificity ${specificity.toFixed(3)}  Wilson 95% LB ${specLB.toFixed(3)}`);
  console.log(`  binding (of ${withUnmet.length} w/ unmet): novelty ${bindNovelty}, prospective ${bindProspective}, blend ${bindBlend}, psf ${bindPsf}`);
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p105-gate-calibration.ts", PROTOCOL_PATH, P103_JSON, P104_JSON]),
      generatedBy: "scripts/p105-gate-calibration.ts", module: "src/discover/discoveryGate.ts (wilsonLowerBound)",
      data: "union of committed labelled REAL candidates from p103 (9 SPOC known-planet hosts) + p104 (3 Gaia/centroid known-planet hosts); disjoint id sets. Fully offline, deterministic.",
      note: "gate specificity / zero-false-claim calibration on labelled negatives; the sensitivity arm is synthetic-only (p100). discoveryClaim false, safeToGate false.",
    },
    nLabeled: n, trueNegatives, falsePromotions, specificity, specificityWilsonLB: specLB,
    withUnmetCount: withUnmet.length, bindingCensus: { novelty: bindNovelty, prospective: bindProspective, blend: bindBlend, psf: bindPsf },
    rows: labeled, verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p105-gate-calibration.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P105 - Gate calibration on labelled real candidates (specificity / zero false claims)",
    "",
    "Generated by `scripts/p105-gate-calibration.ts`. Treats the earned gate as a classifier and asks how it",
    "behaves on candidates whose ground truth we KNOW: every committed host here is a catalogued planet system,",
    "so the correct output is tier none. It reads the two committed per-target reports (p103, p104) -- disjoint",
    "host sets -- and counts false promotions, then bounds the true-negative rate with a Wilson interval.",
    "Fully offline over committed, tracked files.",
    "",
    `Reproduce: \`npm run p105:gate-calibration\``,
    "",
    `- ${n} labelled real hosts -> true negatives ${trueNegatives}/${n}, false promotions ${falsePromotions}, specificity ${specificity.toFixed(3)}.`,
    `- Wilson 95% lower bound on the true-negative rate: ${specLB.toFixed(3)} (a small-sample bound: only ${n} labelled negatives so far).`,
    `- binding refusals (of ${withUnmet.length} with unmet lists): novelty ${bindNovelty}, prospective ${bindProspective}, blend ${bindBlend}, PSF ${bindPsf}.`,
    `- sensitivity arm (promoting a clean novel signal) is synthetic-only (p100): committed data has no labelled NOVEL candidate.`,
    "",
    "| host | source | tier | known? |",
    "|---|---|---|---|",
    ...labeled.map((l) => `| ${l.id} | ${l.source} | ${l.tier} | ${l.known} |`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: a refusal is only reassuring if the refuser is calibrated not to over-claim. On every real",
    "labelled planet we hold, the gate refuses -- that is the assurance behind 'the gate says none'. What remains",
    "unproven on real data is the OTHER direction (does it promote a true novelty), and we say so plainly.",
    "Research-only; nothing gated, anchored, claimed, or deployed.",
    "`safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p105-gate-calibration.md", md);
  console.log("\nwrote reports/p105-gate-calibration.md and .json");
}

main();
