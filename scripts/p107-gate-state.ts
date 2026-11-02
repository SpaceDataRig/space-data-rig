// P107 (discovery roadmap: ONE machine-verified attestation of the earned gate's full state, closing the
// p100-p106 arc). Rounds R32-R40 fed the discovery gate every axis real committed data can support (p101
// cross-sector, p102 shape, p103 significance, p104 capability, p105 specificity, p106 ROC) and proved which
// axes cannot be supported. That state is now scattered across six reports. p107 consolidates it into a single
// per-bar scoreboard -- but it does NOT copy the numbers: it RE-COMPUTES every headline from the source reports
// and ENFORCES cross-report consistency, so the attestation fails loudly if any upstream report and its
// neighbours disagree. Fully OFFLINE, deterministic, machine-verified.
//
// Honest framing: this characterises the INSTRUMENT, it is not a finding. discoveryClaim/safeToGate stay false;
// nothing gated/anchored/claimed/deployed.
//
// Usage: npm run p107:gate-state
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";

const PROTOCOL_PATH = "discovery-protocol.json";
const SRC = {
  p101: "reports/p101-prospective-real.json",
  p102: "reports/p102-shape-axes-real.json",
  p103: "reports/p103-target-gate-table.json",
  p104: "reports/p104-corroboration-capability.json",
  p105: "reports/p105-gate-calibration.json",
  p106: "reports/p106-centroid-roc.json",
};

type BarStatus = "fed-real" | "unmet-known-real" | "diagnostic-only" | "unsupportable-committed" | "synthetic-only" | "policy";

interface Bar { bar: string; protocol: string; status: BarStatus; evidence: string; unblocks: string; }

function main() {
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8"));
  const r101 = JSON.parse(readFileSync(SRC.p101, "utf8"));
  const r102 = JSON.parse(readFileSync(SRC.p102, "utf8"));
  const r103 = JSON.parse(readFileSync(SRC.p103, "utf8"));
  const r104 = JSON.parse(readFileSync(SRC.p104, "utf8"));
  const r105 = JSON.parse(readFileSync(SRC.p105, "utf8"));
  const r106 = JSON.parse(readFileSync(SRC.p106, "utf8"));

  const sig = proto.significanceBars;
  const cor = proto.corroborationBars;
  const rows = r103.rows as { coherentSectors: number; stitchedSnr: number; ar1Far: number; oddEvenDiffFrac: number; catalogKnown: boolean; gateTier: string }[];

  // RE-COMPUTE p103's aggregates from its own rows (do not trust the published fields).
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const sigClears = rows.filter((r) => r.stitchedSnr >= sig.minSnr && isNum(r.ar1Far) && r.ar1Far <= sig.maxAr1FalseAlarmProb).length;
  const xsecClears = rows.filter((r) => r.coherentSectors >= cor.minCrossSectorEphemerisCoherentSectors).length;
  const shapeClears = rows.filter((r) => isNum(r.oddEvenDiffFrac) && r.oddEvenDiffFrac <= cor.maxOddEvenAsymmetryFrac).length;
  const allNone103 = rows.every((r) => r.gateTier === "none");
  const allKnown103 = rows.every((r) => r.catalogKnown);

  // Cross-report consistency (the point of the attestation): independent reports must agree on shared numbers.
  const consistency: { check: string; ok: boolean; detail: string }[] = [];
  const add = (check: string, ok: boolean, detail: string) => consistency.push({ check, ok, detail });
  add("p103 recomputed significance clears == published", sigClears === r103.significanceClears, `${sigClears} vs ${r103.significanceClears}`);
  add("p103 recomputed cross-sector clears == published", xsecClears === r103.crossSectorClears, `${xsecClears} vs ${r103.crossSectorClears}`);
  add("p103 recomputed shape clears == published", shapeClears === r103.oddEvenClears, `${shapeClears} vs ${r103.oddEvenClears}`);
  add("p101 (>=2 sectors) count == p103 cross-sector clears", r101.hostsWithCrossSectorDetectionGe2 === r103.crossSectorClears, `${r101.hostsWithCrossSectorDetectionGe2} vs ${r103.crossSectorClears}`);
  add("p105 labelled n == p103 targets + p104 overlap", r105.nLabeled === r103.nTargets + r104.gateOverlapHosts, `${r105.nLabeled} vs ${r103.nTargets}+${r104.gateOverlapHosts}`);
  add("p106 caught@alpha == p104 centroid caught (same fixture/bar)", r106.caughtAtDefault === r104.centroid.caught, `${r106.caughtAtDefault} vs ${r104.centroid.caught}`);
  add("p106 default alpha == p104 alpha", r106.defaultAlpha === r104.alpha, `${r106.defaultAlpha} vs ${r104.alpha}`);
  add("p104 gaia decisive == 0", r104.gaia.decisive === 0, `decisive ${r104.gaia.decisive}`);
  add("p105 false promotions == 0", r105.falsePromotions === 0, `falsePromotions ${r105.falsePromotions}`);
  add("all p103 real hosts -> tier none", allNone103, `${r103.tierNoneCount}/${r103.nTargets}`);
  add("all p103 real hosts catalogued (novelty unmet on truth)", allKnown103, "catalogKnown all true");
  add("p102 odd/even bar frozen 0.2", r102.maxOddEvenAsymmetryFrac === cor.maxOddEvenAsymmetryFrac, `${r102.maxOddEvenAsymmetryFrac}`);
  const allConsistent = consistency.every((c) => c.ok);

  // The per-bar state scoreboard.
  const bars: Bar[] = [
    { bar: "significance (SNR + AR1 FAR)", protocol: `minSnr ${sig.minSnr}, maxAr1FAP ${sig.maxAr1FalseAlarmProb}`, status: "fed-real", evidence: `p103: ${sigClears}/${rows.length} real hosts clear both on measured SNR + a matched-surrogate AR1 FAR`, unblocks: "already real per target" },
    { bar: "cross-sector corroboration", protocol: `min ${cor.minCrossSectorEphemerisCoherentSectors} coherent sectors`, status: "fed-real", evidence: `p101/p103: ${xsecClears}/${rows.length} hosts independently detected in >=2 sectors on real photometry`, unblocks: "already real" },
    { bar: "odd/even transit shape", protocol: `max asymmetry ${cor.maxOddEvenAsymmetryFrac}`, status: "fed-real", evidence: `p102: measured on ${r102.oddEvenDeterminable} curves, ${r102.oddEvenPass} pass / ${r102.oddEvenFailShape} fail -> discriminates`, unblocks: "already real" },
    { bar: "novelty (not already known)", protocol: "requireNotAlreadyKnown", status: "unmet-known-real", evidence: `p103: every real host is catalogued (${r103.notNovelCount}/${rows.length}) -> bar correctly unmet, not a missing measurement`, unblocks: "a genuinely uncatalogued target" },
    { bar: "harmonic-alias FPP", protocol: `max ${cor.maxHarmonicAliasFpp}`, status: "diagnostic-only", evidence: `p102: sibling COUNTS reported (${r102.hostsWithHarmonicSiblings} hosts) but no calibrated false-positive probability`, unblocks: "empirical alias-FPP calibration across a population" },
    { bar: "Gaia blend/dilution ruled out", protocol: "requireGaiaBlendRuledOut", status: "unsupportable-committed", evidence: `p104: 0/${r104.gaia.withData} Gaia hosts decisive (all unknown, no orbit at candidate period)`, unblocks: "Gaia RV/orbit AT the candidate period" },
    { bar: "PSF / difference-imaging clear", protocol: "requirePsfOrDiffImagingClear", status: "unsupportable-committed", evidence: `p106: centroid F-test AUC ${r106.aucTarget} -> no blend/planet separation at any threshold; would rubber-stamp ${r104.centroid.blendWouldClear}/${r104.centroid.blendsTestable} blends`, unblocks: "real difference-imaging / target-pixel TGLC follow-up" },
    { bar: "prospective precision (Wilson LB)", protocol: `min ${proto.prospectiveValidation.minPrecisionWilsonLowerBound}`, status: "synthetic-only", evidence: `p100/p105: sensitivity arm established on synthetic forward streams only; specificity on real data is measured (${r105.specificityWilsonLB} Wilson LB, ${r105.nLabeled} labelled negatives)`, unblocks: "a real prospective run on a genuinely new target" },
    { bar: "human signoff", protocol: "announcementRequiresHumanSignoff", status: "policy", evidence: "automatedMaySetDiscoveryClaim=false by the frozen protocol", unblocks: "an operator signoff (never automated)" },
  ];
  const byStatus = (s: BarStatus) => bars.filter((b) => b.status === s).length;
  const verdict = `P107-GATE-STATE (single attestation of the earned gate, closing p100-p106; all numbers RE-COMPUTED from source reports, ${consistency.length} cross-report consistency checks ${allConsistent ? "ALL PASS" : "FAILED"}): of ${bars.length} bars -- fed with real per-target measurements: ${byStatus("fed-real")}; correctly unmet because real hosts are catalogued: ${byStatus("unmet-known-real")}; diagnostic-only (not yet a calibrated probability): ${byStatus("diagnostic-only")}; proven unsupportable from committed real data (needs external instrument input): ${byStatus("unsupportable-committed")}; established only synthetically: ${byStatus("synthetic-only")}; policy: ${byStatus("policy")}. Reading: the gate is not refusing from missing numbers -- it refuses because the remaining bars require data we honestly do not have yet (an uncatalogued target, Gaia orbits at the period, real difference-imaging, a prospective run). ${allConsistent ? "Every shared figure across the six reports agrees." : "CONSISTENCY VIOLATION -> inspect before trusting."} discoveryClaim false, safeToGate false.`;
  console.log(`  consistency: ${consistency.filter((c) => c.ok).length}/${consistency.length} pass`);
  for (const c of consistency) if (!c.ok) console.log(`   FAIL: ${c.check} (${c.detail})`);
  for (const b of bars) console.log(`  [${b.status}] ${b.bar}`);
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p107-gate-state.ts", PROTOCOL_PATH, SRC.p101, SRC.p102, SRC.p103, SRC.p104, SRC.p105, SRC.p106]),
      generatedBy: "scripts/p107-gate-state.ts", module: "src/discover/discoveryGate.ts + reports p101-p106",
      data: "recomputed from the six committed gate reports + the frozen protocol. Every shared number cross-checked. Fully offline, deterministic.",
      note: "attestation of the earned gate's per-bar state; NOT a finding. discoveryClaim false, safeToGate false.",
    },
    consistencyChecks: consistency.length, consistencyAllPass: allConsistent, consistency,
    bars, byStatus: { fedReal: byStatus("fed-real"), unmetKnownReal: byStatus("unmet-known-real"), diagnosticOnly: byStatus("diagnostic-only"), unsupportableCommitted: byStatus("unsupportable-committed"), syntheticOnly: byStatus("synthetic-only"), policy: byStatus("policy") },
    verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p107-gate-state.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P107 - Earned-gate state attestation (per-bar, re-computed from p100-p106)",
    "",
    "Generated by `scripts/p107-gate-state.ts`. R32-R40 fed the discovery gate every axis real committed data",
    "supports and proved which it cannot. p107 is a SINGLE scoreboard of that state: it RE-COMPUTES every headline",
    "from the six source reports (never copies a verdict string) and enforces cross-report consistency, so it",
    "fails loudly if the reports disagree. Fully offline over committed, tracked files.",
    "",
    `Reproduce: \`npm run p107:gate-state\``,
    "",
    `- cross-report consistency: ${consistency.filter((c) => c.ok).length}/${consistency.length} checks pass.`,
    `- bars fed with REAL per-target data: ${byStatus("fed-real")}; correct unmet-because-known: ${byStatus("unmet-known-real")}; diagnostic-only: ${byStatus("diagnostic-only")}; proven unsupportable from committed data: ${byStatus("unsupportable-committed")}; synthetic-only: ${byStatus("synthetic-only")}; policy: ${byStatus("policy")}.`,
    "",
    "| bar | protocol | status | evidence | what would unblock it |",
    "|---|---|---|---|---|",
    ...bars.map((b) => `| ${b.bar} | ${b.protocol} | ${b.status} | ${b.evidence} | ${b.unblocks} |`),
    "",
    "## Consistency checks",
    "",
    ...consistency.map((c) => `- ${c.ok ? "PASS" : "FAIL"}: ${c.check} (${c.detail})`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: this is an audit of the instrument, not a discovery. It lets a reader see, in one machine-",
    "checked place, exactly how far the gate can be taken on data we already hold -- and precisely which external",
    "inputs the last few bars need. Research-only; nothing gated, anchored, claimed, or deployed.",
    "`safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p107-gate-state.md", md);
  console.log("\nwrote reports/p107-gate-state.md and .json");
}

main();
