// SCALED-REPRODUCIBILITY guard (external audit problem #3: "the flagship reports are not recomputable off the
// generating machine"). p82/p84/p85 previously stamped buildStamp([out/scaled/*.jsonl]) -- a gitignored path -- so
// their checksums could be re-hashed on exactly one workstation and on no fresh clone (report-freshness counts such
// an input `untracked`, not `verified`). The fix commits the row-level checkpoints under tests/fixtures/scaled and
// proves, offline, that those committed bytes re-derive the PUBLISHED headline numbers. If this test passes on any
// checkout, a stranger can reproduce the flagship result without the 2.7h network pull.
//
// Two independent claims:
//   (1) every committed checkpoint row still hashes to its recorded digest line-sha (the bytes are the run's bytes);
//   (2) re-scoring the committed checkpoints with the SAME scorer the report uses (scoreBlindTest, minCorroboration=2,
//       the aggregate() external/centroid filters) reproduces reports/p82-scaled.json field-for-field -- not a re-
//       implementation of the digest, a re-derivation straight from the fixtures against the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "scaled");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const MIN_CORR = 2;

const digest = JSON.parse(readFileSync(join(FIX, "digest.json"), "utf8")) as {
  files: Record<string, { rows: number; sha256: string; lineSha: string[] }>;
};
const report = JSON.parse(readFileSync(join(HERE, "..", "reports", "p82-scaled.json"), "utf8")) as {
  blind: { curves: number; injected: number; nullCurves: number; recall: number; precision: number; acceptedUnderBar: number; acceptedTp: number; falseAccepts: number; acceptedPrecision: number };
  external: { kp: { tested: number; validated: number; grade: number }; cp: { tested: number; validated: number; grade: number } };
  centroid: { planetsTestable: number; planetFalseReject: number; blendsTestable: number; blendCaught: number };
};

interface Rec { truth?: unknown; dets?: unknown; disp?: string; validated?: boolean; blendFpp?: number | null; harmonicSiblings?: number; label?: string; testable?: boolean; falseReject?: boolean; caught?: boolean }

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIX, name), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
}
const parse = (name: string): Rec[] => fixtureLines(name).map((l) => JSON.parse(l) as Rec);

test("every committed checkpoint row still matches its recorded per-line sha256", () => {
  for (const name of ["blind.jsonl", "external.jsonl", "centroid.jsonl"]) {
    const lines = fixtureLines(name);
    const d = digest.files[name];
    assert.equal(lines.length, d.rows, `${name}: row count drifted from the digest`);
    assert.deepEqual(lines.map((l) => sha256(l)), d.lineSha, `${name}: a committed row no longer hashes as the digest recorded`);
    assert.equal(sha256(lines.join("\n") + "\n"), d.sha256, `${name}: file sha256 drifted from the digest`);
  }
});

test("the committed checkpoints re-derive the published p82 headline from scratch", () => {
  const blindRows = parse("blind.jsonl").filter((r) => r.truth);
  const truth = blindRows.map((r) => r.truth as Truth);
  const dets = blindRows.flatMap((r) => (r.dets as Detection[]) ?? []);
  const bt = scoreBlindTest(truth, dets, { minCorroboration: MIN_CORR });

  assert.equal(bt.nCurves, report.blind.curves, "blind curves");
  assert.equal(bt.nInjected, report.blind.injected, "blind injected");
  assert.equal(bt.nNull, report.blind.nullCurves, "blind nullCurves");
  assert.ok(Math.abs(bt.recall - report.blind.recall) < 1e-12, "blind recall");
  assert.ok(Math.abs(bt.precision - report.blind.precision) < 1e-12, "blind precision");
  assert.equal(bt.accepted, report.blind.acceptedUnderBar, "blind acceptedUnderBar");
  assert.equal(bt.acceptedTp, report.blind.acceptedTp, "blind acceptedTp");
  assert.equal(bt.falseAccepts, report.blind.falseAccepts, "blind falseAccepts");
  assert.ok(Math.abs(bt.acceptedPrecision - report.blind.acceptedPrecision) < 1e-12, "blind acceptedPrecision");

  const ext = parse("external.jsonl").filter((r) => r.disp);
  const rate = (rows: Rec[]) => ({
    tested: rows.length,
    validated: rows.filter((r) => r.validated).length,
    grade: rows.filter((r) => r.validated && (r.blendFpp ?? 1) < 1e-3 && (r.harmonicSiblings ?? 0) === 0).length,
  });
  assert.deepEqual(rate(ext.filter((r) => r.disp === "KP")), { tested: report.external.kp.tested, validated: report.external.kp.validated, grade: report.external.kp.grade }, "external KP");
  assert.deepEqual(rate(ext.filter((r) => r.disp === "CP")), { tested: report.external.cp.tested, validated: report.external.cp.validated, grade: report.external.cp.grade }, "external CP");

  const cen = parse("centroid.jsonl").filter((r) => r.testable);
  const planets = cen.filter((r) => r.label === "planet");
  const blends = cen.filter((r) => r.label === "blend");
  assert.equal(planets.length, report.centroid.planetsTestable, "centroid planetsTestable");
  assert.equal(planets.filter((r) => r.falseReject).length, report.centroid.planetFalseReject, "centroid planetFalseReject");
  assert.equal(blends.length, report.centroid.blendsTestable, "centroid blendsTestable");
  assert.equal(blends.filter((r) => r.caught).length, report.centroid.blendCaught, "centroid blendCaught");
});

test("the flagship p82/p84/p85 reports stamp the tracked committed fixtures, not a gitignored path", () => {
  const inputsOf = (p: string) => (JSON.parse(readFileSync(join(HERE, "..", "reports", p), "utf8")).meta.inputs as { path: string }[]);
  for (const rep of ["p82-scaled.json", "p84-centroid-diagnosis.json", "p85-contaminant-fit.json"]) {
    const ins = inputsOf(rep);
    assert.ok(ins.length > 0, `${rep}: records no inputs`);
    for (const i of ins) {
      assert.ok(i.path.startsWith("tests/fixtures/scaled/"), `${rep}: input ${i.path} is not a tracked committed fixture, so it cannot be re-hashed on another checkout`);
    }
  }
});
