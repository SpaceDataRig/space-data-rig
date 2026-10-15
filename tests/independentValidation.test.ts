// Offline tests for the independent-validation predicate (audit-9 gap 3).
import { test } from "node:test";
import assert from "node:assert/strict";

import { independentlyConfirmed, type BlindDetection, type ExternalClaim } from "../src/candidate/independentValidation.ts";

const claim = (p: number): ExternalClaim => ({ id: "T", periodDays: p, disposition: "CP" });

test("a >=2-sector blind detection matching the claim period validates it", () => {
  const d: BlindDetection = { periodDays: 4.0, corroboratedSectors: 3 };
  const r = independentlyConfirmed(d, claim(4.02));
  assert.equal(r.validated, true);
  assert.ok(r.relPeriodDiff < 0.02);
});

test("a single-sector (uncorroborated) detection does NOT validate", () => {
  const d: BlindDetection = { periodDays: 4.0, corroboratedSectors: 1 };
  const r = independentlyConfirmed(d, claim(4.0));
  assert.equal(r.validated, false);
  assert.match(r.reason, /sector/);
});

test("a period far from the claim does NOT validate even at high corroboration", () => {
  const d: BlindDetection = { periodDays: 5.5, corroboratedSectors: 4 };
  const r = independentlyConfirmed(d, claim(4.0));
  assert.equal(r.validated, false);
  assert.match(r.reason, /off by/);
  assert.ok(r.relPeriodDiff > 0.02);
});

test("missing or non-positive period can never validate", () => {
  assert.equal(independentlyConfirmed({ periodDays: NaN, corroboratedSectors: 5 }, claim(4)).validated, false);
  assert.equal(independentlyConfirmed({ periodDays: 4, corroboratedSectors: 5 }, claim(0)).validated, false);
});

test("tolerance and corroboration thresholds are configurable", () => {
  const d: BlindDetection = { periodDays: 4.1, corroboratedSectors: 2 };
  assert.equal(independentlyConfirmed(d, claim(4.0), { periodTolFrac: 0.01 }).validated, false); // 2.5% off > 1%
  assert.equal(independentlyConfirmed(d, claim(4.0), { periodTolFrac: 0.05 }).validated, true); // within 5%
  assert.equal(independentlyConfirmed(d, claim(4.0), { minCorroboration: 3 }).validated, false); // 2 < 3
});
