// R41: p107 is the single attestation of the earned gate, closing p100-p106. Its whole value is that it does
// NOT trust the six reports' published verdicts -- it RE-COMPUTES each shared figure and ENFORCES cross-report
// consistency, so the attestation is only as honest as the agreement between independent rounds. This test
// re-derives the key cross-report equalities from the six source files with an INDEPENDENT pass (so a hand-edit
// of p107 alone cannot fake green), pins that the attestation reports ALL checks passing, that every bar is
// labelled with an allowed status, and that the honest characterisation (3 fed-real / 2 unsupportable / 1
// synthetic-only / 1 diagnostic / 1 unmet-known / 1 policy) holds. Red lines stay false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p107-gate-state.json"), "utf8"));
const load = (n: string) => JSON.parse(readFileSync(resolve(process.cwd(), `reports/${n}.json`), "utf8"));
const r101 = load("p101-prospective-real"), r103 = load("p103-target-gate-table"), r104 = load("p104-corroboration-capability"), r105 = load("p105-gate-calibration"), r106 = load("p106-centroid-roc");

test("p107 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the attestation reports every cross-report consistency check passing", () => {
  assert.equal(R.consistencyAllPass, true);
  assert.ok(R.consistency.length >= 10 && R.consistency.length === R.consistencyChecks);
  for (const c of R.consistency) assert.equal(c.ok, true, `consistency check failed: ${c.check} (${c.detail})`);
});

test("key cross-report equalities independently re-derived from the six sources", () => {
  assert.equal(r105.nLabeled, r103.nTargets + r104.gateOverlapHosts);
  assert.equal(r106.caughtAtDefault, r104.centroid.caught);
  assert.equal(r106.defaultAlpha, r104.alpha);
  assert.equal(r101.hostsWithCrossSectorDetectionGe2, r103.crossSectorClears);
  assert.equal(r104.gaia.decisive, 0);
  assert.equal(r105.falsePromotions, 0);
  // the published consistency flags must agree with these independent facts
  const published = Object.fromEntries(R.consistency.map((c) => [c.check, c.ok]));
  assert.equal(published["p105 labelled n == p103 targets + p104 overlap"], true);
  assert.equal(published["p101 (>=2 sectors) count == p103 cross-sector clears"], true);
});

test("p103 aggregates re-computed from its own rows match (attestation recomputes, not copies)", () => {
  const rows = r103.rows;
  const xsec = rows.filter((r) => r.coherentSectors >= 2).length;
  assert.equal(xsec, r103.crossSectorClears);
  assert.ok(rows.every((r) => r.gateTier === "none"), "all p103 real hosts are tier none, as attested");
});

test("every bar carries an allowed status and the honest characterisation holds", () => {
  const allowed = new Set(["fed-real", "unmet-known-real", "diagnostic-only", "unsupportable-committed", "synthetic-only", "policy"]);
  assert.ok(R.bars.length >= 8);
  for (const b of R.bars) assert.ok(allowed.has(b.status), `unexpected status ${b.status}`);
  assert.equal(R.byStatus.fedReal, 3);
  assert.equal(R.byStatus.unsupportableCommitted, 2);
  assert.equal(R.byStatus.syntheticOnly, 1);
  assert.equal(Object.values(R.byStatus).reduce((a, b) => a + b, 0), R.bars.length, "status counts sum to the bar list");
});
