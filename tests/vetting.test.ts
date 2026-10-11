// Tests for the critic's false-positive vetting path. The load-bearing guarantee is that
// vetting is fully ADDITIVE and gated: with no vetting supplied the ReviewResult is
// byte-for-byte identical to before (so the deterministic synthetic/bundle path is
// untouched), and only a supplied failing metric can downgrade a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewCandidate, type ReviewInput } from "../src/critic/review.ts";
import type { TransitCandidate } from "../src/core/types.ts";

/** A strong, physically-sane blind candidate that the base critic ACCEPTS. */
const candidate: TransitCandidate = {
  targetId: "VET-TEST-1",
  periodDays: 3.5,
  epochBjd: 2458425.7,
  durationHours: 2.9,
  depthPpt: 5.1,
  depthFrac: 0.0051,
  snr: 18,
  power: 0.0042,
  nPointsInTransit: 24,
  folded: [],
};

const baseInput: ReviewInput = {
  candidate,
  aliasMultiple: 1,
  catalog: [],
  nTransitsObserved: 5,
};

test("base blind candidate is accepted (control for the vetting cases below)", () => {
  const r = reviewCandidate(baseInput);
  assert.equal(r.verdict, "accepted", `expected accepted, got ${r.verdict}: ${r.reason}`);
});

test("an empty vetting object yields a result identical to no vetting (gating invariant)", () => {
  const without = reviewCandidate(baseInput);
  const empty = reviewCandidate({ ...baseInput, vetting: {} });
  assert.deepEqual(empty, without, "empty vetting must not alter checks/score/verdict");
});

test("a large photocenter shift downgrades the verdict to rejected (blend / background EB)", () => {
  const r = reviewCandidate({ ...baseInput, vetting: { centroidShiftArcsec: 8.3 } });
  assert.equal(r.verdict, "rejected");
  assert.match(r.reason, /off the target star/);
  const c = r.checks.find((x) => x.name === "centroid-shift");
  assert.ok(c && c.pass === false, "centroid-shift check should be present and failing");
  assert.ok(r.score <= 20, "score must be capped on a vetting failure");
});

test("a sub-threshold shift keeps the accept and adds a passing check", () => {
  const r = reviewCandidate({ ...baseInput, vetting: { centroidShiftArcsec: 0.1 } });
  assert.equal(r.verdict, "accepted");
  const c = r.checks.find((x) => x.name === "centroid-shift");
  assert.ok(c && c.pass === true, "centroid-shift check should pass for 0.1 arcsec");
});

test("an insignificant FAP downgrades to rejected", () => {
  const r = reviewCandidate({ ...baseInput, vetting: { fap: 0.42 } });
  assert.equal(r.verdict, "rejected");
  assert.match(r.reason, /not significant/);
  assert.ok(r.checks.some((x) => x.name === "fap" && x.pass === false));
});

test("a significant FAP plus a clean shift reinforces the accept (bounded bonus)", () => {
  const plain = reviewCandidate(baseInput);
  const vetted = reviewCandidate({
    ...baseInput,
    vetting: { centroidShiftArcsec: 0.2, fap: 1e-4 },
  });
  assert.equal(vetted.verdict, "accepted");
  assert.ok(vetted.score >= plain.score && vetted.score <= plain.score + 5, "passing vetting adds at most +5");
});

test("vetting can reject an otherwise-accepted recovery-mode candidate (override is absolute)", () => {
  const rec: ReviewInput = {
    ...baseInput,
    truthSource: "catalog",
    truthPeriodDays: 3.5,
    vetting: { centroidShiftArcsec: 30 },
  };
  const r = reviewCandidate(rec);
  assert.equal(r.verdict, "rejected", "a 30 arcsec shift must reject even a period-perfect match");
});
