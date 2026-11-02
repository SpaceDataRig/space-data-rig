// R43: p109 closes the pixel-centroid line (p82/p104/p106) by quantifying the CEILING of the whole centroid feature
// set -- the best blend/planet separation ANY rule can reach on the committed real labelled data. Its honesty rests
// on numbers that must be RE-DERIVABLE from the fixture, not merely asserted: this test recomputes the neighbour and
// target Mann-Whitney AUCs with an independent pass, checks continuity with p106 (same fixture -> same single-axis
// AUCs), pins that the ceiling is the max over all rules (so the report cannot hide a better band), that it stays
// below the 0.7 usable bar and the Youden below 0.4, and -- the decisive point -- that the report flags the labels
// as harness-derived rather than external imaging. Red lines stay false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p109-centroid-ceiling.json"), "utf8"));
const p106 = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p106-centroid-roc.json"), "utf8"));
const rows = readFileSync(resolve(process.cwd(), "tests/fixtures/scaled/centroid.jsonl"), "utf8").replace(/\r/g, "").trim().split("\n").map((l) => JSON.parse(l));

function aucGt(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

test("p109 keeps the discovery red lines false and states the label provenance", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
  assert.equal(R.labelsFromHarnessNotExternalImaging, true);
});

test("counts and single-axis AUCs are independently re-derived from the fixture", () => {
  const t = rows.filter((r) => r.testable);
  const b = t.filter((r) => r.label === "blend");
  const p = t.filter((r) => r.label === "planet");
  assert.equal(b.length, R.nTestableBlends);
  assert.equal(p.length, R.nTestablePlanets);
  const aucNb = aucGt(b.map((r) => r.bestNeighbourP), p.map((r) => r.bestNeighbourP));
  assert.ok(Math.abs(aucNb - R.aucNeighbour) < 1e-3, `neighbour AUC recompute ${aucNb} vs ${R.aucNeighbour}`);
  const aucT = aucGt(p.map((r) => r.pTarget), b.map((r) => r.pTarget));
  assert.ok(Math.abs(aucT - R.aucTarget) < 1e-3, `target AUC recompute ${aucT} vs ${R.aucTarget}`);
});

test("continuity with p106 -- same fixture, same single-axis AUCs", () => {
  assert.ok(Math.abs(R.aucTarget - p106.aucTarget) < 5e-3, "target AUC agrees with p106");
  assert.ok(Math.abs(R.aucNeighbour - p106.aucNeighbour) < 5e-3, "neighbour AUC agrees with p106");
});

test("the ceiling is the max over all rules and stays below the usable bar", () => {
  const strataAucs = R.strata.filter((s: any) => s.auc !== null && s.nBlend >= 5 && s.nPlanet >= 5).map((s: any) => s.auc);
  const recomputedCeiling = Math.max(R.aucNeighbour, R.aucComposite, ...(strataAucs.length ? strataAucs : [0]));
  assert.ok(Math.abs(R.ceiling - recomputedCeiling) < 1e-3, "ceiling equals the max achievable AUC across rules");
  assert.equal(R.power, "weak");
  assert.equal(R.usable, false);
  assert.ok(R.ceiling < 0.7, "no rule clears the 0.7 usable bar");
  // the 2-feature composite must not beat the better single axis -- combining a dead axis does not help
  assert.ok(R.aucComposite <= R.aucNeighbour + 1e-6, "composite does not exceed neighbour alone");
  assert.ok(Math.max(R.youdenNeighbour.j, R.youdenConjunction.j) < 0.4, "best Youden stays below the usable threshold");
});

test("at a tight false-reject budget the centroid barely catches blends (operational dead end)", () => {
  assert.ok(R.catchAt5pctFalseReject.falseReject <= 0.05, "reported operating point honours the <=5% budget");
  assert.ok(R.catchAt5pctFalseReject.sensitivity < 0.5, "flags fewer than half of blends without discarding many planets");
});
