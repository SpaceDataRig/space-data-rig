// Offline tests for the blind-test scorer (priority 5). Pure scoring on synthetic truth vs detections;
// the injection/detection happens in the script. Emphasis on the confusion matrix, period tolerance,
// and the corroboration-capping safety metric (falseAccepts) that mirrors the project's blind-verdict
// discipline (uncorroborated significant signals are capped as needs-more-data, never auto-accepted).
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";

test("perfect run: all injected recovered, nulls clean", () => {
  const truth: Truth[] = [
    { id: "a", injected: true, periodDays: 5 },
    { id: "b", injected: true, periodDays: 3 },
    { id: "c", injected: false },
    { id: "d", injected: false },
  ];
  const dets: Detection[] = [
    { id: "a", periodDays: 5.01, corroboratedSectors: 2 },
    { id: "b", periodDays: 3.02, corroboratedSectors: 2 },
  ];
  const s = scoreBlindTest(truth, dets);
  assert.equal(s.tp, 2);
  assert.equal(s.fp, 0);
  assert.equal(s.fn, 0);
  assert.equal(s.tn, 2);
  assert.equal(s.recall, 1);
  assert.equal(s.precision, 1);
  assert.equal(s.falseAccepts, 0);
  assert.equal(s.discoveryClaim, false);
});

test("a missed injection counts as a false negative and lowers recall", () => {
  const truth: Truth[] = [
    { id: "a", injected: true, periodDays: 5 },
    { id: "b", injected: true, periodDays: 8 },
  ];
  const dets: Detection[] = [{ id: "a", periodDays: 5, corroboratedSectors: 2 }];
  const s = scoreBlindTest(truth, dets);
  assert.equal(s.tp, 1);
  assert.equal(s.fn, 1);
  assert.ok(Math.abs(s.recall - 0.5) < 1e-9);
});

test("a detection on a null curve is a false positive and lowers precision", () => {
  const truth: Truth[] = [
    { id: "a", injected: true, periodDays: 5 },
    { id: "n", injected: false },
  ];
  const dets: Detection[] = [
    { id: "a", periodDays: 5, corroboratedSectors: 2 },
    { id: "n", periodDays: 4.2, corroboratedSectors: 2 },
  ];
  const s = scoreBlindTest(truth, dets);
  assert.equal(s.tp, 1);
  assert.equal(s.fp, 1);
  assert.equal(s.tn, 0);
  assert.ok(Math.abs(s.precision - 0.5) < 1e-9);
  assert.equal(s.fpPerNullCurve, 1);
});

test("period outside tolerance is not a match (becomes FP + FN)", () => {
  const truth: Truth[] = [{ id: "a", injected: true, periodDays: 5 }];
  const dets: Detection[] = [{ id: "a", periodDays: 6, corroboratedSectors: 2 }]; // 20% off > 2% tol
  const s = scoreBlindTest(truth, dets);
  assert.equal(s.tp, 0);
  assert.equal(s.fp, 1);
  assert.equal(s.fn, 1);
});

test("corroboration capping: an uncorroborated real detection is needs-more-data, not accepted", () => {
  const truth: Truth[] = [{ id: "a", injected: true, periodDays: 5 }];
  const dets: Detection[] = [{ id: "a", periodDays: 5, corroboratedSectors: 1 }]; // real but single-sector
  const s = scoreBlindTest(truth, dets, { minCorroboration: 2 });
  assert.equal(s.tp, 1);
  assert.equal(s.accepted, 0);
  assert.equal(s.needsMoreData, 1);
  assert.equal(s.falseAccepts, 0);
});

test("falseAccepts counts an accepted detection that is NOT real (the safety metric)", () => {
  const truth: Truth[] = [
    { id: "a", injected: true, periodDays: 5 },
    { id: "b", injected: true, periodDays: 5 },
    { id: "c", injected: false },
  ];
  const dets: Detection[] = [
    { id: "a", periodDays: 5, corroboratedSectors: 2 }, // TP accepted
    { id: "b", periodDays: 5, corroboratedSectors: 1 }, // TP capped (needs-more-data)
    { id: "c", periodDays: 5, corroboratedSectors: 2 }, // FP accepted -> falseAccept
  ];
  const s = scoreBlindTest(truth, dets, { minCorroboration: 2 });
  assert.equal(s.tp, 2);
  assert.equal(s.fp, 1);
  assert.equal(s.accepted, 2); // a and c
  assert.equal(s.acceptedTp, 1); // only a
  assert.equal(s.falseAccepts, 1); // c
  assert.equal(s.needsMoreData, 1); // b
  assert.ok(Math.abs(s.acceptedPrecision - 0.5) < 1e-9);
});

test("minCorroboration=1 disables capping (everything accepted)", () => {
  const truth: Truth[] = [{ id: "a", injected: true, periodDays: 5 }];
  const dets: Detection[] = [{ id: "a", periodDays: 5, corroboratedSectors: 1 }];
  const s = scoreBlindTest(truth, dets, { minCorroboration: 1 });
  assert.equal(s.accepted, 1);
  assert.equal(s.needsMoreData, 0);
  assert.equal(s.falseAccepts, 0);
});

test("confidence intervals bracket the point estimate", () => {
  const truth: Truth[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, injected: true, periodDays: 5 }));
  const dets: Detection[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, periodDays: 5, corroboratedSectors: 2 }));
  const s = scoreBlindTest(truth, dets);
  assert.equal(s.recall, 0.6);
  assert.ok(s.recallCI[0] <= 0.6 && 0.6 <= s.recallCI[1]);
  assert.equal(s.precision, 1);
  assert.equal(s.precisionCI[1], 1);
});

test("scoring is deterministic for identical inputs", () => {
  const truth: Truth[] = [
    { id: "a", injected: true, periodDays: 5 },
    { id: "b", injected: false },
  ];
  const dets: Detection[] = [{ id: "b", periodDays: 4, corroboratedSectors: 2 }];
  assert.deepEqual(scoreBlindTest(truth, dets), scoreBlindTest(truth, dets));
});
