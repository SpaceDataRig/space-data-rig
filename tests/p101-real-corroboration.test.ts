// R35 (audit of R34): p101 fed the earned gate with REAL measured cross-sector corroboration, but NOTHING in the suite
// pinned its published invariants -- the aggregates were only checked by hand. This test is the missing teeth. It reads
// the COMMITTED report and its committed frozen-rows fixture and asserts:
//   (1) honesty red lines: discoveryClaim/safeToGate exactly false; the gate denies the claim (tier none, allowed false)
//       for the strongest host AND for the counterfactual that GRANTS novelty -- so novelty alone cannot earn a claim;
//   (2) self-consistency: every published aggregate equals a re-computation from the frozen rows (catches any hand-edit
//       that inflates corroboration or hides a known-host);
//   (3) non-vacuity of the MEASUREMENT: at least one host really shows >=2 sectors independently detecting (the bar is
//       reachable on real data) AND at least one shows 0 and at least one has a period that does NOT match the catalog
//       (so it is not a rubber stamp -- the p29/p30 selection bottleneck is real and left visible);
//   (4) the two defects caught on the first live run stay fixed: every row has a POSITIVE detrended SNR, and no host
//       ever reports more detecting sectors than it has sectors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPORT = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p101-prospective-real.json"), "utf8"));
const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), "reports/fixtures/p101-frozen-real.json"), "utf8"));
const rows = FIXTURE.rows as { host: string; nSectors: number; coherentSectors: number; stitchedSnr: number; recoveredPeriod: number; hostInCatalog: boolean; periodMatchesCatalog: boolean }[];

test("p101 keeps the discovery red lines false", () => {
  assert.equal(REPORT.discoveryClaim, false);
  assert.equal(REPORT.safeToGate, false);
});

test("the gate denies the claim for the strongest host AND when novelty is granted (non-vacuous)", () => {
  assert.ok(REPORT.gateAsIs, "gateAsIs present");
  assert.equal(REPORT.gateAsIs.tier, "none");
  assert.equal(REPORT.gateAsIs.discoveryClaimAllowed, false);
  // The counterfactual grants novelty but keeps every other value real; it must STILL not earn a claim.
  assert.ok(REPORT.gateCounterfactualNovelty, "counterfactual present");
  assert.equal(REPORT.gateCounterfactualNovelty.tier, "none");
  assert.equal(REPORT.gateCounterfactualNovelty.discoveryClaimAllowed, false);
});

test("published aggregates are exactly re-derivable from the frozen rows (no hand-edit drift)", () => {
  const cohGe2 = rows.filter((r) => r.coherentSectors >= 2).length;
  const hostKnown = rows.filter((r) => r.hostInCatalog).length;
  const periodMatch = rows.filter((r) => r.periodMatchesCatalog).length;
  assert.equal(REPORT.nHosts, rows.length);
  assert.equal(REPORT.hostsWithCrossSectorDetectionGe2, cohGe2);
  assert.equal(REPORT.hostInCatalogCount, hostKnown);
  assert.equal(REPORT.periodMatchesCatalogCount, periodMatch);
});

test("the real corroboration measurement is non-vacuous, not a rubber stamp", () => {
  assert.ok(rows.length >= 1, "has hosts");
  // the >=2 cross-sector-detection bar is reachable on real photometry...
  assert.ok(rows.some((r) => r.coherentSectors >= 2), "at least one host really shows >=2 coherent detecting sectors");
  // ...but it is NOT automatically satisfied: some hosts fail it, and some recovered periods are not the catalog planet.
  assert.ok(rows.some((r) => r.coherentSectors === 0), "at least one host has 0 corroboration (not assumed)");
  assert.ok(rows.some((r) => !r.periodMatchesCatalog), "at least one recovered period misses the catalog (selection bottleneck visible)");
});

test("every SPOC host is catalog-known, which is exactly why the gate refuses (honest, not evasive)", () => {
  assert.ok(rows.every((r) => r.hostInCatalog === true), "all committed SPOC hosts are confirmed-planet systems");
});

test("the two first-run defects stay fixed: positive detrended SNR and coherentSectors <= nSectors", () => {
  for (const r of rows) {
    assert.ok(r.stitchedSnr > 0, `${r.host} non-positive SNR (detrend regression)`);
    assert.ok(r.recoveredPeriod > 0, `${r.host} non-positive period`);
    assert.ok(r.coherentSectors <= r.nSectors, `${r.host} claims more detecting sectors than fetched`);
  }
});
