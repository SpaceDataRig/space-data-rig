// R42: p108 grows the gate specificity census with the 3 committed single-sector known-planet hosts p103 skipped.
// Its honesty rests on three things this test pins with INDEPENDENT recomputation: (1) the new hosts are genuine
// brand-new negatives (no id collision with p103/p104, so pooling does not double-count); (2) every labelled real
// host -- old and new -- lands tier none, so false promotions are truly zero; (3) the published Wilson lower bound
// and the sample-size ceiling are re-derived here from discoveryGate.wilsonLowerBound, not copied. Red lines stay
// false; the single-sector cross-sector bar is unmet by construction (one sector cannot corroborate across >=2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wilsonLowerBound } from "../src/discover/discoveryGate.ts";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p108-negatives-expansion.json"), "utf8"));
const p103 = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p103-target-gate-table.json"), "utf8"));
const p104 = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p104-corroboration-capability.json"), "utf8"));

test("p108 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the 3 newly-used hosts are single-sector known-planet systems, all refused tier none", () => {
  assert.equal(R.newHosts, 3);
  assert.equal(R.rows.length, 3);
  for (const r of R.rows) {
    assert.equal(r.nSectors, 1, `${r.host} is single-sector`);
    assert.equal(r.crossSectorClears, false, "one sector cannot corroborate across >=2 (unmet by construction)");
    assert.equal(r.gateTier, "none");
  }
  // honest detection-reliability observation: on 2/3 the strongest peak is NOT the catalogued planet
  assert.equal(R.singleSectorPeakMismatch, 2);
});

test("the new negatives are genuinely new (no double-counting when pooled)", () => {
  assert.equal(R.idCollisions.length, 0, "p108 hosts must not already appear in p103/p104");
  const prior = new Set([...p103.rows.map((r) => r.host), ...p104.rows.map((r) => String(r.tic))]);
  assert.equal(R.nLabeledPrior, prior.size, "prior union equals recomputed p103+p104 distinct ids");
  assert.equal(R.nLabeled, prior.size + R.newHosts, "15 = 12 prior + 3 new");
  assert.equal(new Set(R.labeled.map((l) => l.id)).size, R.nLabeled, "the labelled list is distinct by id");
});

test("zero false promotions on the full real labelled-negative census", () => {
  assert.equal(R.falsePromotions, 0);
  assert.equal(R.trueNegatives, R.nLabeled);
  assert.equal(R.specificity, 1);
  assert.ok(R.labeled.every((l) => l.tier === "none"), "every labelled real host is refused");
});

test("Wilson bound and sample-size ceiling re-derived independently from discoveryGate", () => {
  const lb15 = Number(wilsonLowerBound(R.nLabeled, R.nLabeled).toFixed(4));
  const lb12 = Number(wilsonLowerBound(R.nLabeledPrior, R.nLabeledPrior).toFixed(4));
  assert.equal(R.specificityWilsonLB, lb15);
  assert.equal(R.priorWilsonLB, lb12);
  assert.ok(lb15 > lb12, "adding real negatives must tighten (raise) the lower bound");
  // recompute the ceiling: fewest zero-false-claim negatives whose Wilson LB reaches the protocol target
  let need = 0; for (let k = 1; k <= 500; k++) { if (wilsonLowerBound(k, k) >= R.targetPrecisionLB) { need = k; break; } }
  assert.equal(R.nRequiredForTarget, need);
  assert.ok(R.nLabeled < need, "we are short of the ceiling -- the gap is real-negative sample size, stated as a number");
});
