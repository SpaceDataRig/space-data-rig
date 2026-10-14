// Offline tests for the reduced hierarchical false-positive probability (priority 2).
// Pure + deterministic; no network. The point of the module is that the blend term is driven by the
// MEASURED neighbour list, so the tests exercise the dilution inversion directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessFalsePositive,
  DEFAULT_FP_PRIORS,
  type BlendNeighbor,
} from "../src/candidate/falsePositiveProbability.ts";

const HOST = 10; // host G magnitude

test("no neighbours: only the on-target EB prior contributes", () => {
  const a = assessFalsePositive(0.01, HOST, []);
  assert.equal(a.pBlend, 0);
  assert.ok(Math.abs(a.pFalsePositive - DEFAULT_FP_PRIORS.onTargetEbPrior) < 1e-9, `pFP should equal the on-target prior, got ${a.pFalsePositive}`);
  assert.ok(a.pPlanet > 0.97);
  assert.equal(a.discoveryClaim, false);
  assert.equal(a.determined, true);
});

test("a neighbour of the right contrast is a viable diluted blend and lifts P(FP)", () => {
  // depth 0.01, neighbour 4 mag fainter (k~0.025) needs an intrinsic ~41% eclipse -> plausible EB.
  const nb: BlendNeighbor[] = [{ gmag: 14, sepArcsec: 5 }];
  const a = assessFalsePositive(0.01, HOST, nb);
  assert.equal(a.viableBlends.length, 1);
  assert.ok(a.viableBlends[0].requiredEbDepth > 0.1 && a.viableBlends[0].requiredEbDepth < 0.9);
  assert.ok(a.pBlend > 0);
  assert.ok(a.pFalsePositive > DEFAULT_FP_PRIORS.onTargetEbPrior);
});

test("a too-faint neighbour would need an impossible >90% eclipse and is excluded", () => {
  const nb: BlendNeighbor[] = [{ gmag: 17, sepArcsec: 5 }]; // k~0.0016 -> required depth ~6x
  const a = assessFalsePositive(0.01, HOST, nb);
  assert.equal(a.viableBlends.length, 0);
  assert.equal(a.pBlend, 0);
  assert.equal(a.neighboursConsidered, 1); // seen, but not viable
});

test("a neighbour outside the aperture cannot dilute and is not even considered", () => {
  const nb: BlendNeighbor[] = [{ gmag: 13, sepArcsec: 30 }];
  const a = assessFalsePositive(0.01, HOST, nb);
  assert.equal(a.neighboursConsidered, 0);
  assert.equal(a.pBlend, 0);
});

test("P(FP) is monotonic in the number of viable blended neighbours", () => {
  const one = assessFalsePositive(0.01, HOST, [{ gmag: 14, sepArcsec: 3 }]);
  const three = assessFalsePositive(0.01, HOST, [{ gmag: 14, sepArcsec: 3 }, { gmag: 14.5, sepArcsec: 6 }, { gmag: 13.5, sepArcsec: 9 }]);
  assert.ok(three.pBlend > one.pBlend, `three (${three.pBlend}) should exceed one (${one.pBlend})`);
  assert.ok(three.pFalsePositive > one.pFalsePositive);
});

test("many viable blends clamp P(FP) to 1 and P(planet) to 0", () => {
  const many: BlendNeighbor[] = [];
  for (let i = 0; i < 200; i++) many.push({ gmag: 14, sepArcsec: 1 });
  const a = assessFalsePositive(0.01, HOST, many);
  assert.equal(a.pBlend, 1);
  assert.equal(a.pFalsePositive, 1);
  assert.equal(a.pPlanet, 0);
  assert.equal(a.fpOdds, Infinity);
});

test("a non-finite depth is not determined and yields no viable blends", () => {
  const a = assessFalsePositive(NaN, HOST, [{ gmag: 14, sepArcsec: 3 }]);
  assert.equal(a.determined, false);
  assert.equal(a.viableBlends.length, 0);
  assert.equal(a.pBlend, 0);
});

test("deeper observed signals admit more viable blends (a bright shallow EB can mimic them)", () => {
  // a neighbour at contrast ~1 mag (k~0.4): shallow d=0.001 needs depth 0.0035 (below min -> excluded);
  // deeper d=0.05 needs 0.175 (viable).
  const nb: BlendNeighbor[] = [{ gmag: 11, sepArcsec: 3 }];
  const shallow = assessFalsePositive(0.001, HOST, nb);
  const deep = assessFalsePositive(0.05, HOST, nb);
  assert.equal(shallow.viableBlends.length, 0);
  assert.equal(deep.viableBlends.length, 1);
});
