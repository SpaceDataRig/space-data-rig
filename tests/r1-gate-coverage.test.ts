// External-audit R1 regression gate: the two most-cited EXTERNAL benchmark reports must be inside the freshness
// gate, and the project's most-cited single number (the P75 inverted-curve AR(1) false-alarm rate) must be
// reproducible, not a lottery on when a scheduled CI re-measure against the live Archive happened to run.
//
// Two properties, both checked against committed bytes on disk (a green run means a clean checkout has them):
//   1. p86 now enumerates reports/crosscheck/ (not just top level): the LEO-Vetter benchmark and the cross-pipeline
//      study appear in the served index and each has a page a reader can open. Before this they were entirely outside
//      the gate -- the auditor's whole complaint.
//   2. P75 is frozen and replays offline: the committed report carries a real provenance stamp whose inputs are the
//      script + the committed frozen-row fixture, and its published summary is exactly a pure function of those rows
//      (so re-running the default path cannot move the number the way a live re-fetch would).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const LIB = resolve(process.cwd(), "web", "reports");
const REPORTS = resolve(process.cwd(), "reports");
const FROZEN = resolve(REPORTS, "fixtures", "p75-frozen-rows.json");

interface Entry { id: string; slug: string; verified?: boolean; stamped?: boolean; fresh?: boolean }

function index(): { reports: Entry[] } {
  return JSON.parse(readFileSync(resolve(LIB, "index.json"), "utf8"));
}

test("the freshness gate now covers the crosscheck external-benchmark reports", () => {
  const entries = index().reports;
  const cc = entries.filter((e) => e.id.startsWith("crosscheck/"));
  assert.ok(cc.length >= 2, `expected the two crosscheck reports in the served index, got ${cc.length}`);
  for (const e of cc) {
    assert.ok(
      existsSync(resolve(LIB, `${e.slug}.html`)),
      `crosscheck report ${e.id} must have a page a reader can open (slug ${e.slug})`,
    );
  }
});

test("P75 is frozen: the committed report is stamped and its data stamp keys on the fixture, not the live catalog", () => {
  assert.ok(existsSync(FROZEN), "reports/fixtures/p75-frozen-rows.json must be committed");
  const j = JSON.parse(readFileSync(resolve(REPORTS, "p75-inverted-fp.json"), "utf8")) as {
    meta: { generatedAt?: string; gitSha?: string; inputs?: { path: string }[]; measuredAt?: string };
    summary: Record<string, unknown>;
  };
  assert.ok(j.meta.generatedAt, "p75 report must carry generatedAt");
  assert.ok(j.meta.gitSha, "p75 report must carry gitSha");
  const paths = (j.meta.inputs ?? []).map((i) => i.path);
  assert.ok(paths.includes("reports/fixtures/p75-frozen-rows.json"), "the frozen fixture must be a hashed input");
  // The whole point of freezing: the LIVE-catalog modules are deliberately NOT inputs, so a NASA Archive update
  // cannot mark this cited report stale and force a re-measure that would silently move the published rate.
  assert.ok(!paths.includes("src/data/exoplanetArchive.ts"), "the live Archive module must NOT gate this frozen report");
  assert.ok(!paths.includes("src/data/mastS3.ts"), "the live S3 curve host must NOT gate this frozen report");
});

test("P75's published numbers are exactly the frozen rows (byte-stable replay, not a re-measure)", () => {
  const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as { rows: { ar1FalseAlarm: boolean; blockFalseAlarm: boolean; flip: boolean }[] };
  const rows = frozen.rows;
  const derived = {
    n: rows.length,
    ar1FalseAlarms: rows.filter((r) => r.ar1FalseAlarm).length,
    blockFalseAlarms: rows.filter((r) => r.blockFalseAlarm).length,
    flips: rows.filter((r) => r.flip).length,
  };
  const j = JSON.parse(readFileSync(resolve(REPORTS, "p75-inverted-fp.json"), "utf8")) as { summary: Record<string, number> };
  for (const [k, v] of Object.entries(derived)) {
    assert.equal(j.summary[k], v, `p75 summary.${k} must equal the pure function of the frozen rows (${v})`);
  }
  assert.equal(j.summary.n, 200, "the frozen sample size is what the report cites");
});
