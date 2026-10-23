// audit-16 D4 -- the accounting gate on REAL served bytes. The fifteenth and sixteenth audits both found the same
// meta-defect: our checks only ever exercised ONE direction of this data (synthetic ids for the query, a 16-row
// live-findings fixture that quietly contains 3x HR 858 / 2x HD 25463 / 2x HD 63433 with nobody asserting anything is
// off). This file drives the PRODUCTION pure functions (groupBySignal / labelConflict / hostKeyOf / queryFindings /
// RigStore.computeStats) over the FULL catalog and ledger captured from spacedatarig.app by
// scripts/capture-served-catalog.ts, and pins the exact population the auditor recomputed:
//   103 rows -> 91 recovered signals -> 90 host stars; 12 duplicate rows; accepted 18 rows -> 15 signals / 15 stars;
//   5 label-vs-own-crossmatch contradictions of which 3 are accepted; ledger 20 commitments -> 17 signals, with the
//   HR 858 trio carrying THREE different scienceHashes (the duplication is baked into the content address today).
// Re-run the capture with `npm run fixtures:capture-catalog`; if the live rig mints new rows, update the expected
// counts HERE -- a silent mismatch failing CI is the point, not a surprise for the next auditor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupBySignal, hostKeyOf, labelConflict, signalKeyOf } from "../src/core/signal-identity.ts";
import { queryFindings, depthPpmOf } from "../src/core/finding-query.ts";
import { RigStore } from "../src/core/store.ts";
import type { Finding } from "../src/core/types.ts";

interface CatalogFixture { capturedFrom: string; capturedAt: string; total: number; findings: Finding[] }
interface LedgerFixture { capturedFrom: string; capturedAt: string; ledger: { findingId: string; bundleHash: string; scienceHash: string; status: string }[] }

function load<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), "tests", "fixtures", file), "utf8")) as T;
}
const catalog = load<CatalogFixture>("live-catalog.json");
const ledgerFx = load<LedgerFixture>("live-ledger.json");
const rows = catalog.findings;

test("the served catalog is 103 rows that collapse to 91 recovered signals with 12 duplicate rows (D1 population)", () => {
  assert.equal(rows.length, 103, `fixture must hold the full served catalog (total ${catalog.total})`);
  assert.equal(catalog.total, 103);
  const groups = [...groupBySignal(rows).values()];
  assert.equal(groups.length, 91, "103 seat-label rows are 91 physical candidates at (host, period@1e-9, ppm, snr@1e-6)");
  const dupRows = groups.reduce((n, g) => n + (g.length > 1 ? g.length - 1 : 0), 0);
  assert.equal(groups.filter((g) => g.length > 1).length, 11, "11 signals are registered under >= 2 ids");
  assert.equal(dupRows, 12, "12 rows are pure duplicates of an already-recorded signal");
  // the exact merges the audit named, from the fixture's own bytes:
  const hr858 = groups.find((g) => hostKeyOf(g[0].targetId) === "hr 858");
  assert.ok(hr858 && hr858.map((f) => f.targetId).sort().join(",") === "HR 858 b,HR 858 c,HR 858 d", "three HR 858 seat rows are ONE signal");
  assert.ok(groups.some((g) => g.length === 2 && g.every((f) => hostKeyOf(f.targetId) === "hd 260655")), "HD 260655 b/c are one signal");
});

test("103 rows live on 90 host stars, so the published distinctHosts must read 90 -- and distinctRecords stays 103 (secondary #1)", () => {
  assert.equal(new Set(rows.map((f) => hostKeyOf(f.targetId))).size, 90);
  const store = new RigStore("test-live-accounting");
  for (const f of rows) store.addFinding(structuredClone(f));
  const stats = store.computeStats([]);
  assert.equal(stats.distinctHosts, 90, "the DO/Node counter now counts STARS via the shared hostKeyOf, not label strings");
  assert.equal(stats.distinctRecords, 103, "the raw-label count is published separately, both readings honest");
});

test("accepted findings: 18 rows fold to 15 signals over 15 distinct stars", () => {
  const accepted = rows.filter((f) => f.verdict === "accepted");
  assert.equal(accepted.length, 18);
  assert.equal(groupBySignal(accepted).size, 15);
  assert.equal(new Set(accepted.map((f) => hostKeyOf(f.targetId))).size, 15);
});

test("label-vs-own-crossmatch contradictions exist in the served bytes and labelConflict names exactly them (D1 disclosure predicate)", () => {
  const conflicts = rows.filter((f) => labelConflict(f.targetId, f.crossmatch).conflict);
  assert.equal(conflicts.length, 5);
  assert.equal(conflicts.filter((f) => f.verdict === "accepted").length, 3, "three contradicting labels are ACCEPTED rows");
  // the accepted trio the auditor quoted verbatim from the live catalog:
  const named = conflicts.filter((f) => f.verdict === "accepted").map((f) => `${f.targetId}<-${f.crossmatch?.knownPlanetName}`).sort();
  assert.deepEqual(named, ["HD 260655 c<-HD 260655 b", "HR 858 c<-HR 858 b", "HR 858 d<-HR 858 b"]);
  for (const f of conflicts) {
    const lc = labelConflict(f.targetId, f.crossmatch);
    assert.notEqual(lc.requested, lc.detected);
    assert.equal(hostKeyOf(f.targetId), hostKeyOf(f.crossmatch?.knownPlanetName ?? ""), "a conflict is same-star different-letter, by construction");
  }
});

test("the chain paid 20 fees for 17 signals, and the HR 858 trio's three scienceHashes differ -- duplication reaches the content address (D2 population)", () => {
  const ledger = ledgerFx.ledger;
  assert.equal(ledger.length, 20);
  assert.ok(ledger.every((r) => r.status === "anchored"));
  const byId = new Map(rows.map((f) => [f.id, f]));
  assert.ok(ledger.every((r) => byId.has(r.findingId)), "every commitment joins to a catalog row");
  const signals = new Set(ledger.map((r) => { const f = byId.get(r.findingId)!; return signalKeyOf(f.targetId, f.candidate.periodDays, f.candidate.depthFrac, f.candidate.snr); }));
  assert.equal(signals.size, 17, "20 commitments cover 17 physical candidates (HR 858 x3, HD 260655 x2)");
  const hr = ledger.filter((r) => r.findingId.startsWith("F-HR-858-"));
  assert.equal(hr.length, 3);
  assert.equal(new Set(hr.map((r) => r.scienceHash)).size, 3, "today one candidate carries THREE distinct science hashes -- the dedup cannot fire structurally until the projection is recalibrated (HANDOFF next-step)");
});

test("tic queries on the SERVED catalog: no candidate-number leak, and host-level lookup returns ALL of a star's rows (D4's missing direction)", () => {
  // the audit-15 hole, now asserted against real bytes rather than synthetic ids: tic=01 used to sweep in every
  // TOI-####.01 object. A pure-digit query must only hit ROWS OF A HOST whose key contains that number -- never a
  // bare .NN candidate index.
  assert.equal(queryFindings(rows, { tic: "01" }).matched, 0, ".01/.02 are candidate numbers, not host identifiers");
  assert.equal(queryFindings(rows, { tic: "0858" }).matched, 3, "zero-padded real HR 858 hits all three seat rows");
  assert.equal(queryFindings(rows, { tic: "858" }).matched, 3);
  for (const f of rows) {
    for (const run of hostKeyOf(f.targetId).match(/\d+/g) ?? []) {
      const matched = queryFindings(rows, { tic: run });
      // host-level lookup returns ALL rows of the star; it may ALSO return another star whose key carries the same
      // number ("kelt-11" and "hat-p-11" both answer to 11) -- that is the documented identifier behaviour, a HOST
      // match, never a candidate-index match. The tic=01 zero-hit above is what pins the .NN leak shut.
      assert.ok(matched.rows.every((m) => hostKeyOf(m.targetId).includes(run)), `tic=${run} hit a row whose host key lacks ${run}`);
      assert.ok(rows.filter((g) => hostKeyOf(g.targetId) === hostKeyOf(f.targetId)).every((g) => matched.rows.includes(g)), `tic=${run} missed a row of ${hostKeyOf(f.targetId)}`);
    }
  }
  // 58 served labels carry a candidate number; the loop above already proves every digit-run hit is a HOST hit, so no
  // ".NN" index can resolve as a tic unless the host key itself carries that number.
  assert.equal(rows.filter((f) => /\.\d+$/.test(f.targetId)).length, 58);
});

test("the served depthPpm projection equals the shared rounding, so filter and card can never disagree", () => {
  for (const f of rows) {
    assert.equal((f as Finding & { depthPpm: number }).depthPpm, depthPpmOf(f), `${f.targetId} ppm drift between view and query`);
  }
});
