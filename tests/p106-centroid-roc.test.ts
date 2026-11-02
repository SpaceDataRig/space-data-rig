// R40: p106 sweeps the committed REAL labelled centroid data across every threshold and reports a Mann-Whitney
// AUC for the target p-value as a blend-vs-planet discriminator. The honest finding is that there is NO usable
// separation (AUC ~ 0.5), which upgrades p104's single-threshold refusal into a full ROC. This test pins: red lines
// false; the testable blend/planet counts; that the published AUC is exactly re-derivable from the fixture by an
// INDEPENDENT recomputation (so a hand-edit cannot drift past it); that the conclusion stays "no separation"
// (power none, usable false) -- i.e. it does NOT quietly claim a discriminative axis; and continuity with p104
// (caught 0 at alpha=0.001).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p106-centroid-roc.json"), "utf8"));
const rows = readFileSync(resolve(process.cwd(), "tests/fixtures/scaled/centroid.jsonl"), "utf8").replace(/\r/g, "").trim().split("\n").map((l) => JSON.parse(l));
const blends = rows.filter((r) => r.label === "blend" && r.testable).map((r) => r.pTarget);
const planets = rows.filter((r) => r.label === "planet" && r.testable).map((r) => r.pTarget);
// independent Mann-Whitney re-implementation
function auc(pos: number[], neg: number[]): number {
  let w = 0; for (const p of pos) for (const q of neg) w += p < q ? 1 : p === q ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

test("p106 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the labelled testable counts match the fixture", () => {
  assert.equal(R.nTestableBlends, blends.length);
  assert.equal(R.nTestablePlanets, planets.length);
  assert.ok(blends.length >= 30 && planets.length >= 30, "enough labelled points for an AUC");
});

test("the published AUC is exactly re-derivable from the fixture (tamper-evident)", () => {
  assert.equal(R.aucTarget, Number(auc(blends, planets).toFixed(4)));
});

test("the honest conclusion is NO usable separation -- the axis is not claimed discriminative", () => {
  assert.equal(R.power, "none", "target-p AUC ~ 0.5 -> no separation, labelled honestly");
  assert.equal(R.usable, false, "the centroid axis must NOT be flagged usable");
  assert.ok(R.aucTarget > 0.4 && R.aucTarget < 0.6, `AUC ${R.aucTarget} sits in the no-separation band, not a real signal`);
  assert.ok(R.youden.j < 0.3, "even the best threshold has weak Youden J -> not promotable");
});

test("continuity with p104: at alpha=0.001 it catches 0 blends", () => {
  assert.equal(R.defaultAlpha, 0.001);
  assert.equal(R.caughtAtDefault, 0, "0/59 caught at p104's operating point (reproduced, not asserted)");
  const reCaught = rows.filter((r) => r.label === "blend" && r.testable && r.pTarget < 0.001 && r.bestNeighbourP >= 0.001).length;
  assert.equal(R.caughtAtDefault, reCaught);
});
