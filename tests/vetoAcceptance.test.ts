// Offline tests for the true-veto 2x2 acceptance protocol (roadmap priority 0, the unblocked half).
// These validate the SCORER only -- they do NOT certify any real veto tool (that needs the labelled
// negative class P52 showed is blocked on an ExoFOP token). The most important test is the
// positives-only case: it must refuse to certify, which is exactly our current honest situation.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  confusionMatrix,
  vetoMetrics,
  rocCurve,
  aucRocCurve,
  acceptVetoTool,
  type VetoCase,
} from "../src/candidate/vetoAcceptance.ts";

const blend = (veto: boolean, score?: number): VetoCase => ({ isBlend: true, veto, score });
const planet = (veto: boolean, score?: number): VetoCase => ({ isBlend: false, veto, score });

test("confusionMatrix tallies the 2x2 correctly", () => {
  const cases: VetoCase[] = [blend(true), blend(true), blend(false), planet(false), planet(true)];
  const cm = confusionMatrix(cases);
  assert.deepEqual(cm, { trueVeto: 2, missedBlend: 1, falseVeto: 1, trueKeep: 1 });
});

test("a perfect veto has power 1, zero false vetoes, and is safe to gate", () => {
  const cases: VetoCase[] = [blend(true), blend(true), blend(true), blend(true), blend(true), planet(false), planet(false), planet(false), planet(false), planet(false)];
  const m = vetoMetrics(cases);
  assert.equal(m.vetoPower, 1);
  assert.equal(m.falseVetoRate, 0);
  assert.equal(m.vetoPrecision, 1);
  const v = acceptVetoTool(cases, { targetPower: 0.8 });
  assert.equal(v.safeToGate, true, v.reason);
});

test("a single false veto disqualifies the gate (measure-before-gate)", () => {
  const cases: VetoCase[] = [blend(true), blend(true), planet(false), planet(true)]; // one planet killed
  const v = acceptVetoTool(cases);
  assert.equal(v.safeToGate, false);
  assert.match(v.reason, /1 real planet\(s\) wrongly vetoed/);
});

test("positives-only (our current real data) CANNOT certify a veto", () => {
  const cases: VetoCase[] = [planet(false), planet(false), planet(false)]; // no labelled blends
  const v = acceptVetoTool(cases);
  assert.equal(v.safeToGate, false);
  assert.match(v.reason, /no labelled blends.*need a negative class/);
});

test("zero false vetoes but under-powered is safe-but-not-gated", () => {
  // catches only 1 of 10 blends, kills no planets -> safe but power 0.1
  const cases: VetoCase[] = [blend(true), ...Array.from({ length: 9 }, () => blend(false)), planet(false), planet(false)];
  const v = acceptVetoTool(cases, { targetPower: 0.5 });
  assert.equal(v.safeToGate, false);
  assert.match(v.reason, /safe but under-powered/);
});

test("ROC of a perfectly separating score has AUC 1; an inverted score has AUC 0", () => {
  const perfect: VetoCase[] = [blend(true, 1), blend(true, 1), planet(false, 0), planet(false, 0)];
  assert.equal(aucRocCurve(rocCurve(perfect)), 1);
  const inverted: VetoCase[] = [blend(false, 0), blend(false, 0), planet(true, 1), planet(true, 1)];
  assert.equal(aucRocCurve(rocCurve(inverted)), 0);
});

test("rocCurve is empty when no continuous scores are present", () => {
  assert.deepEqual(rocCurve([blend(true), planet(false)]), []);
  assert.equal(acceptVetoTool([blend(true), blend(true), planet(false)]).auc, null);
});
