// R39: p105 calibrates the earned gate's SPECIFICITY on labelled REAL candidates -- the union of the 9 SPOC
// (p103) and 3 Gaia/centroid (p104) known-planet hosts, whose ground truth is "not a novel discovery", so the
// correct gate output is tier none. This test pins: red lines false; the labelled set is exactly the disjoint
// union (12 = 9 + 3, unique ids); ZERO false promotions (every labelled host is tier none) so specificity == 1;
// the published Wilson lower bound is exactly re-derivable from the real wilsonLowerBound(trueNegatives, n) and
// is a strict, non-trivial value in (0,1) (a small-sample bound, not a rubber stamp); and the binding-constraint
// census over p103's unmet lists is reproducible (novelty binds all of them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wilsonLowerBound } from "../src/discover/discoveryGate.ts";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p105-gate-calibration.json"), "utf8"));
const rows = R.rows as { id: string; source: string; tier: string; known: boolean; unmet: string[] }[];

test("p105 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the labelled set is the disjoint union of p103 and p104 (12 = 9 + 3, unique ids)", () => {
  assert.equal(R.nLabeled, 12);
  assert.equal(new Set(rows.map((r) => r.id)).size, 12, "ids are unique -> the two host sets do not collide");
  assert.equal(rows.filter((r) => r.source.startsWith("p103")).length, 9);
  assert.equal(rows.filter((r) => r.source.startsWith("p104")).length, 3);
});

test("zero false promotions on labelled real planets -> specificity is exactly 1", () => {
  assert.equal(R.falsePromotions, 0);
  assert.equal(R.trueNegatives, R.nLabeled);
  assert.equal(R.specificity, 1);
  for (const r of rows) {
    assert.equal(r.tier, "none", `${r.id}: a labelled known planet must not be promoted`);
    assert.equal(r.known, true, `${r.id}: labelled host is a catalogued system`);
  }
});

test("the Wilson lower bound is re-derivable from the real wilsonLowerBound and non-trivial", () => {
  const lb = Number(wilsonLowerBound(R.trueNegatives, R.nLabeled).toFixed(4));
  assert.equal(R.specificityWilsonLB, lb, "published LB matches wilsonLowerBound(trueNegatives, n) recomputed here");
  assert.ok(lb > 0 && lb < 1, "the bound is a strict small-sample bound, not a fake 1.0");
});

test("the binding-constraint census is reproducible from p103's unmet lists (novelty binds all)", () => {
  const withUnmet = rows.filter((r) => r.unmet.length > 0);
  assert.equal(R.withUnmetCount, withUnmet.length);
  const novelty = withUnmet.filter((l) => l.unmet.some((u) => /novel|known|duplicate/i.test(u))).length;
  assert.equal(R.bindingCensus.novelty, novelty);
  assert.equal(novelty, withUnmet.length, "every p103 host is refused as already-known");
  const blend = withUnmet.filter((l) => l.unmet.some((u) => /blend/i.test(u))).length;
  assert.equal(R.bindingCensus.blend, blend);
});
