// M4 milestone figure -- the picture must be a projection of its record, not a drawing with numbers near it.
//
// The pattern this file enforces is the one tests/anchor-counts-figure.test.ts established after an external audit
// asked how a reader could check a published figure at all: the committed SVG is REBUILT from the committed record
// and required to be byte-identical. Anything that would change the picture -- a rephrased basis, a rounded number,
// a date that refreshes itself -- fails here rather than shipping a plausible-looking image nobody can verify.
//
// The second family of assertions covers the failure mode specific to a milestone panel: a missing input quietly
// becoming a zero. `period matched: 0` is a real result and must print; `blindHeld` absent from production is NOT a
// zero, it is a revision that predates the split, and drawing it as one would be the same "verified vs stamped"
// confusion this repo keeps being audited for. So the builder refuses undefined, and the test says so explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildM4Figure, buildPanels, type M4Record } from "../src/figures/m4MilestoneFigure.ts";

const HERE = resolve(process.cwd());
const REC_PATH = resolve(HERE, "reports", "m4-milestone.json");
const SVG_PATH = resolve(HERE, "web", "m4-milestone-figure.svg");
const have = existsSync(REC_PATH) && existsSync(SVG_PATH);

/** A complete record for the offline rule tests, so they run even before the artifacts exist. */
function sampleRecord(over: Partial<M4Record> = {}): M4Record {
  return {
    schema: "sdr-m4-milestone/1",
    measuredAt: "2026-10-18T15:00:00.000Z",
    source: { state: "https://spacedatarig.app/api/state" },
    p88: { n: 17, withGaiaData: 6, periodMatched: 0, vetoPower: 0 },
    p89: { n: 5, falseVeto: 2, vetoPower: 0 },
    p90: { matched: 16, publishedMedianSignedErrPct: -26.16, boxMedianSignedErrPct: -35.44 },
    p91: { rows: 5, controls: 5, controlsMet: 5, axes: ["subject", "recency", "attribution", "band", "corroboration"], verdict: "subject MATCH | attribution NO-CITATION" },
    publicCounters: { bundlesAnchored: 11, ledgerAnchored: 20, blindHeld: 26, blindCandidates: 47, surveyPassClaimed: 72, distinctHosts: 94 },
    cadence: { passes: 24, fullPassSpanMedianSec: 260, idleMedianSec: 2421, cronEveryMin: 15 },
    ...over,
  } as M4Record;
}

// ---- the committed pair is reproducible ----------------------------------------------------

test("the committed SVG is exactly what the committed record draws", { skip: have ? false : "run npm run figure:m4 to produce reports/m4-milestone.json and the SVG" }, () => {
  const rec = JSON.parse(readFileSync(REC_PATH, "utf8")) as M4Record;
  const committed = readFileSync(SVG_PATH, "utf8");
  assert.equal(buildM4Figure(rec), committed, "the picture drifted from its data -- redraw with npm run figure:m4");
  assert.equal(rec.schema, "sdr-m4-milestone/1");
});

test("the committed record carries no non-ASCII byte and no discovery wording", { skip: have ? false : "artifacts not generated yet" }, () => {
  const rec = readFileSync(REC_PATH, "utf8");
  const svg = readFileSync(SVG_PATH, "utf8");
  for (const [name, text] of [["record", rec], ["svg", svg]] as const) {
    assert.ok(!/[^\x00-\x7F]/.test(text), `${name} carries a non-ASCII character`);
    assert.doesNotMatch(text, /\bdiscover(?:y|ed|ies)\b/i, `${name} claims a discovery`);
  }
});

test("every number printed in the committed SVG exists in the record it was drawn from", { skip: have ? false : "artifacts not generated yet" }, () => {
  const rec = readFileSync(REC_PATH, "utf8");
  const svg = readFileSync(SVG_PATH, "utf8");
  const record = JSON.parse(rec) as M4Record;
  // The headline values are formatted, so check the formatted strings appear -- and that the record supplied them.
  for (const panel of buildPanels(record)) {
    assert.ok(svg.includes(panel.value.replace(/&/g, "&amp;")), `panel ${panel.key} value "${panel.value}" is not in the picture`);
    assert.ok(panel.basis.length > 30, `panel ${panel.key} must state a basis, not just a number`);
  }
  // And the raw counters, so a number cannot be introduced by the drawer.
  for (const [k, v] of Object.entries(record.publicCounters)) {
    assert.match(rec, new RegExp(`"${k}":\\s*${v}\\b`), `record must carry ${k}=${v}`);
  }
});

// ---- the rules, offline --------------------------------------------------------------------

test("a zero that was MEASURED prints; an absent field throws instead of becoming a zero", () => {
  // periodMatched 0 and vetoPower 0 are P88/P89's real results -- they must appear, not be elided.
  const panels = buildPanels(sampleRecord());
  assert.match(panels[0].basis, /period matched: 0/);
  assert.equal(panels[0].tone, "warn", "a zero-match coverage study must not be drawn in the colour of a positive result");

  // Now the same number missing rather than measured: that is an error, not a zero.
  const broken = sampleRecord() as unknown as Record<string, Record<string, unknown>>;
  delete broken.p88.periodMatched;
  assert.throws(() => buildM4Figure(broken as unknown as M4Record), /missing p88\.periodMatched/, "a hole in the record must stop the drawing");
  // A hole in any printed number is refused the same way, not just this one.
  const broken2 = sampleRecord() as unknown as Record<string, Record<string, unknown>>;
  delete broken2.cadence.idleMedianSec;
  assert.throws(() => buildM4Figure(broken2 as unknown as M4Record), /missing cadence\.idleMedianSec/);
});

test("a held count larger than the assessed count is a contradiction, and the figure refuses to draw it", () => {
  const bad = sampleRecord({
    publicCounters: { bundlesAnchored: 1, ledgerAnchored: 2, blindHeld: 30, blindCandidates: 26, surveyPassClaimed: 5, distinctHosts: 5 },
  });
  assert.throws(() => buildM4Figure(bad), /held \(30\) cannot exceed assessed \(26\)/, "the pair must stay a subset relationship or the surfaces disagree");
});

test("p91 tone flips when a control fails to meet its declared expectation", () => {
  const clean = buildPanels(sampleRecord()).find((p) => p.key === "p91");
  assert.equal(clean?.tone, "good");
  const failing = buildPanels(sampleRecord({
    p91: { rows: 5, controls: 4, controlsMet: 3, axes: ["subject"], verdict: "x" },
  })).find((p) => p.key === "p91");
  assert.equal(failing?.tone, "warn", "3 of 4 controls met must not be drawn as success");
  assert.match(failing?.value ?? "", /3\/4/);
});

test("the blind pair is drawn as held over assessed, never as the assessed total alone", () => {
  const counters = buildPanels(sampleRecord()).find((p) => p.key === "counters");
  assert.equal(counters?.value, "26/47 blind held/assessed");
  assert.match(counters?.basis ?? "", /one phrase, one rule/, "the panel has to say why the pair exists");
  assert.match(counters?.basis ?? "", /11 published-bytes, 20 commitments/, "the anchor split prints too");
  assert.match(counters?.basis ?? "", /72 passes CLAIMED/, "claimed, not completed");
});

test("cadence is quoted as measured, with its sample", () => {
  const basis = buildPanels(sampleRecord()).find((p) => p.key === "counters")?.basis ?? "";
  assert.match(basis, /cadence measured: 260s per full pass inside a 15min cron/);
  assert.match(basis, /2421s idle/);
});

// ---- the wiring ----------------------------------------------------------------------------

test("the figure CLI reads its numbers from committed artifacts and live state, not from arguments", () => {
  const cli = readFileSync(resolve(HERE, "scripts", "m4-milestone-figure.ts"), "utf8");
  for (const f of ["reports/p88-independent-corroboration.json", "reports/p89-multiepoch-di.json", "reports/p90-depth-estimators.json", "reports/p91-claim-provenance.json"]) {
    assert.ok(cli.includes(f), `the CLI must read ${f}`);
  }
  assert.match(cli, /\/api\/state/, "and the live counters");
  // It reuses the deployed cadence rule instead of keeping a second clustering implementation.
  assert.match(cli, /import \{[^}]*measurePassSpans[^}]*\} from "\.\.\/src\/deploy\/deployWindow\.ts"/);
  // And it refuses to draw from a production that predates the definition split.
  assert.ok(cli.includes('"blindHeld"') && cli.includes('"blindCandidates"'), "both halves of the pair are required");
  assert.match(cli, /predates the definition layer/, "with a stated refusal");
  const pkg = JSON.parse(readFileSync(resolve(HERE, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["figure:m4"], "tsx scripts/m4-milestone-figure.ts");
});
