// Round-21 audit defects 2/3/5 -- the anchor gate, the tier-as-data fix and the unverifiable-letter
// disclosure, pinned on BOTH synthetic rows (the rules) and the CAPTURED production bytes (the
// population), the two-halves discipline rounds 14-17 proved necessary. Every live count below was
// MEASURED first with the production helpers over tests/fixtures/live-{ledger,catalog}.json
// (out/measure21.ts, capture 2026-10-23T05:42Z) and then pinned -- a silent mismatch failing CI is
// the point. Read-only throughout: nothing here touches a verdict, a hash or a ledger row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { anchorHealth, rowIsStandIn, type AnchorHealthLedgerRow, type AnchorHealthRow } from "../src/core/anchor-health.ts";
import { labelConflict } from "../src/core/signal-identity.ts";
import { DATA_TIER_REAL, DATA_TIER_STANDIN, dataTierOfHeadline, dataTierOfSource, isRealPhotometry } from "../src/data/dataTier.ts";
import { reviewCandidate, type ReviewInput } from "../src/critic/review.ts";
import { critique } from "../src/seats/seats.ts";
import type { DetectionResult } from "../src/detect/pipeline.ts";
import type { ArchivePlanet, Finding, TransitCandidate } from "../src/core/types.ts";

// ---- defect 2/5: the pure aggregate, pinned on hand-built rows (the rules) ----

const mkRow = (o: Partial<AnchorHealthRow> & { id: string }): AnchorHealthRow => ({ verdict: "accepted", ...o });
const mkLedger = (o: Partial<AnchorHealthLedgerRow> & { findingId: string }): AnchorHealthLedgerRow => ({ status: "anchored", ...o });

test("anchorHealth counts ONLY anchored ledger rows and reports each drift class separately", () => {
  const ledger = [
    mkLedger({ findingId: "F-OK", bundleHash: "h1", signature: "sig1", slot: 7 }),
    mkLedger({ findingId: "F-DOWN", bundleHash: "h2", signature: "sig2" }),
    mkLedger({ findingId: "F-FAILED", status: "failed" }), // not an on-chain commitment -> never counted
    mkLedger({ findingId: "F-GONE", bundleHash: "h3" }), // anchored but the row vanished from the board
  ];
  const rows = [
    mkRow({ id: "F-OK", bundleHash: "h1", labelConflictStatus: "clear", dataTier: DATA_TIER_REAL }),
    mkRow({ id: "F-DOWN", verdict: "needs-more-data", bundleHash: "hSTALE", labelConflictStatus: "unverifiable", dataTier: DATA_TIER_STANDIN }),
    mkRow({ id: "F-FAILED", verdict: "rejected" }),
  ];
  const rep = anchorHealth(ledger, rows, "2026-10-26T00:00:00.000Z");
  assert.equal(rep.anchored, 3, "the failed row is not a commitment");
  assert.equal(rep.bundleHashMatch, 1, "only F-OK still carries the hash that was sealed on-chain");
  assert.equal(rep.needsMoreData, 1);
  assert.equal(rep.rejected, 0, "F-FAILED's row is not counted because its ledger entry never anchored");
  assert.equal(rep.standIn, 1);
  assert.equal(rep.unverifiableLetter, 1);
  assert.equal(rep.missingRow, 1);
  const gone = rep.rows.find((r) => r.findingId === "F-GONE");
  assert.ok(gone && gone.verdict === null && gone.labelConflictStatus === "missing-row", "a vanished row is disclosed, not silently dropped");
  assert.equal(rep.asOf, "2026-10-26T00:00:00.000Z");
});

test("rowIsStandIn reads the STRUCTURED tier field, and dataTierOfSource/dataTierOfHeadline agree on both narrate tags", () => {
  assert.equal(rowIsStandIn(mkRow({ id: "x", dataTier: DATA_TIER_STANDIN })), true);
  assert.equal(rowIsStandIn(mkRow({ id: "x", dataTier: DATA_TIER_REAL })), false);
  assert.equal(rowIsStandIn(mkRow({ id: "x" })), false, "no tier served -> not asserted stand-in (the aggregate says null, not a guess)");
  // the two tags narrate.ts prefixes EVERY headline with (byte-exact from src/reporter/narrate.ts):
  assert.equal(dataTierOfHeadline("[real TESS photometry] Blind recovery: ..."), DATA_TIER_REAL);
  assert.equal(dataTierOfHeadline("[stand-in synthetic curve] Verdict: ..."), DATA_TIER_STANDIN);
  assert.equal(dataTierOfHeadline(undefined), DATA_TIER_STANDIN, "an untagged headline reads as the conservative default");
  // tier-of-source and tier-of-headline are the same rule through the same discriminator:
  for (const s of ["stitched/curated TESS light curve (REAL photometry)", "synthetic stand-in generated at the catalog period", undefined]) {
    const headline = isRealPhotometry(s) ? "[real TESS photometry] x" : "[stand-in synthetic curve] x";
    assert.equal(dataTierOfHeadline(headline), dataTierOfSource(s), `source "${s}" and its narrated headline must yield one tier`);
  }
});

test("labelConflict.status makes the structural blind spot first-class: conflict / clear / unverifiable", () => {
  // defect 5: `conflict === false` used to mean BOTH "letters agree" and "nothing to compare".
  assert.equal(labelConflict("HR 858 d", { matchedKnownPlanet: true, knownPlanetName: "HR 858 b" }).status, "conflict");
  assert.equal(labelConflict("HR 858 b", { matchedKnownPlanet: true, knownPlanetName: "HR 858 b" }).status, "clear");
  assert.equal(labelConflict("TIC 2228", { matchedKnownPlanet: true, knownPlanetName: "TIC 2228 b" }).status, "unverifiable", "bare star label: no requested letter to check");
  assert.equal(labelConflict("HR 858 d", undefined).status, "unverifiable", "letter label with no crossmatch: no detected letter to check");
  // the conflict boolean is unchanged by the new field (every prior pin still holds):
  for (const [t, cm] of [["HR 858 d", { knownPlanetName: "HR 858 b" }], ["HR 858 b", { knownPlanetName: "HR 858 b" }], ["TIC 2228", undefined]] as const) {
    const lc = labelConflict(t, cm as never);
    assert.equal(lc.conflict, lc.status === "conflict", "conflict === true exactly when status === 'conflict'");
  }
});

// ---- defect 2/3/5 on the CAPTURED production bytes (the population, as-of 2026-10-23T05:42Z) ----

interface CatalogFixture { capturedAt: string; findings: Finding[] }
interface LedgerFixture { capturedAt: string; ledger: AnchorHealthLedgerRow[] }
const loadFx = <T,>(file: string): T => JSON.parse(readFileSync(resolve(process.cwd(), "tests", "fixtures", file), "utf8")) as T;
const catalogFx = loadFx<CatalogFixture>("live-catalog.json");
const ledgerFx = loadFx<LedgerFixture>("live-ledger.json");

/** Rebuild the served projection the way BOTH runtimes' findingView does: one kernel call + the headline tier. */
function servedRows(): AnchorHealthRow[] {
  return catalogFx.findings.map((f) => {
    const lc = labelConflict(f.targetId, f.crossmatch);
    return {
      id: f.id,
      verdict: f.verdict,
      bundleHash: f.bundleHash,
      labelConflictsWithKnown: lc.conflict,
      labelConflictStatus: lc.status,
      dataTier: dataTierOfHeadline(f.narration?.headline),
    };
  });
}

test("live capture: the aggregate over 20 anchored commitments reproduces the measured drift counters", () => {
  const rep = anchorHealth(ledgerFx.ledger, servedRows(), "fixture");
  // MEASURED (out/measure21.ts over the same fixtures with the same production helpers), then pinned:
  assert.equal(rep.anchored, 20, "the capture holds 20 anchored rows (live moved to 23 on 2026-10-24; see live-catalog-accounting header)");
  assert.equal(rep.bundleHashMatch, 0, "NO anchored row still carries its sealed bundle hash -- the board re-minted every row since (round-20 measured the same)");
  assert.equal(rep.needsMoreData, 2);
  assert.equal(rep.rejected, 1);
  assert.equal(rep.conflict, 3, "F-HD-260655-c, F-HR-858-c, F-HR-858-d: anchored while their own crossmatch disputes the label");
  assert.equal(rep.standIn, 3);
  assert.equal(rep.unverifiableLetter, 4);
  assert.equal(rep.missingRow, 0);
});

test("live capture: the five audit-named ids are exactly the anchored rows whose letter the predicate cannot verify, and the three stand-ins are disclosed as such", () => {
  const rep = anchorHealth(ledgerFx.ledger, servedRows(), "fixture");
  const unverifiable = rep.rows.filter((r) => r.unverifiableLetter).map((r) => r.findingId).sort();
  // four of the five round-21 defect-5 ids sit in THIS capture (F-AU-Mic-b anchored 2026-10-23T15:56Z, after it):
  assert.deepEqual(unverifiable, ["F-GJ-1214-b", "F-HAT-P-11-b", "F-HD-189733-b", "F-HD-63433-d"]);
  const standIns = rep.rows.filter((r) => r.standIn).map((r) => r.findingId).sort();
  assert.deepEqual(standIns, ["F-GJ-1214-b", "F-HAT-P-11-b", "F-HD-189733-b"]);
  // the two ACCEPTED stand-in rows are the ones whose sealed verdictReason contradicted their own headline:
  for (const id of ["F-GJ-1214-b", "F-HD-189733-b"]) {
    const row = rep.rows.find((r) => r.findingId === id);
    assert.ok(row && row.verdict === "accepted" && row.standIn && row.unverifiableLetter, `${id}: accepted + stand-in + unverifiable letter, all disclosed on one row`);
  }
  // population-wide the tier stays honest: 99 real / 4 stand-in over all 103 served rows (measured):
  const tiers = servedRows().reduce((m, r) => ((m[r.dataTier ?? "null"] = (m[r.dataTier ?? "null"] ?? 0) + 1), m), {} as Record<string, number>);
  assert.deepEqual(tiers, { [DATA_TIER_REAL]: 99, [DATA_TIER_STANDIN]: 4 });
  const kinds = servedRows().reduce((m, r) => ((m[r.labelConflictStatus ?? "null"] = (m[r.labelConflictStatus ?? "null"] ?? 0) + 1), m), {} as Record<string, number>);
  assert.deepEqual(kinds, { unverifiable: 69, conflict: 7, clear: 27 }, "the predicate now SAYS which of the 103 rows it could actually judge (27+7) and which it structurally could not (69)");
});

// ---- defect 2: the spend gate itself, pinned structurally on both runtimes (the DO cannot be imported in Node) ----

test("both runtimes refuse a NEW spend on a row the current judgement does not stand behind, AFTER the no-spend idempotency guard", () => {
  const edge = readFileSync(resolve(process.cwd(), "src", "cf", "rig-state.do.ts"), "utf8");
  const node = readFileSync(resolve(process.cwd(), "src", "api", "server.ts"), "utf8");
  for (const [name, src] of [["rig-state.do.ts", edge], ["server.ts", node]] as const) {
    assert.match(src, /const lcNow = labelConflict\(f\.targetId, f\.crossmatch\);/, `${name}: the gate re-reads the CURRENT kernel state, not a stored flag`);
    assert.match(src, /f\.verdict !== "accepted" \|\| lcNow\.conflict/, `${name}: refuses on a downgraded verdict OR a live label conflict`);
    assert.match(src, /anchor refused: /, `${name}: the refusal says why`);
    const gateAt = src.indexOf("lcNow.conflict");
    const idemAt = src.indexOf("alreadyAnchored");
    assert.ok(idemAt !== -1 && gateAt > idemAt, `${name}: the gate sits AFTER the no-spend idempotency guard, so replays/re-stamps of anchored rows are untouched`);
  }
  assert.match(edge, /httpStatus: 409/, "the edge DO returns 409 for a refused anchor");
  assert.match(node, /anchor refused[\s\S]{0,120}409/, "the Node parity route returns 409 for a refused anchor");
});

test("both runtimes serve the tier + the letter status on the read projection and expose the aggregate endpoint", () => {
  const worker = readFileSync(resolve(process.cwd(), "src", "cf", "worker.ts"), "utf8");
  const node = readFileSync(resolve(process.cwd(), "src", "api", "server.ts"), "utf8");
  for (const [name, src] of [["worker.ts", worker], ["server.ts", node]] as const) {
    assert.match(src, /labelConflictStatus: lc\.status/, `${name}: the served row carries the three-state letter status`);
    assert.match(src, /dataTier: dataTierOfHeadline\(f\.narration\?\.headline\)/, `${name}: the served row carries the tier as DATA, decoded from the headline tag`);
    assert.match(src, /app\.get\("\/api\/anchor-health"/, `${name}: the aggregate endpoint exists on this runtime`);
    assert.match(src, /anchorHealth\(/, `${name}: the route drives the SAME pure helper this test drives`);
  }
});

// ---- defect 3: the critic's wording, pinned on the review path both runtimes call ----

const candidate: TransitCandidate = {
  targetId: "TIER-TEST-1",
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
const catalog: ArchivePlanet[] = [{ pl_name: "TIER-TEST-1 b", hostname: "TIER-TEST-1", pl_orbper: 3.5 }];
const baseInput: ReviewInput = { candidate, aliasMultiple: 1, catalog, nTransitsObserved: 5 };

test("a stand-in curve's accepted reason says BY CONSTRUCTION and drops the independent-evidence claim; real photometry wording is byte-identical", () => {
  const real = reviewCandidate(baseInput);
  assert.equal(real.verdict, "accepted");
  assert.match(real.reason, /^Blind recovery: /, "control: unset standInCurve keeps the exact pre-round-21 wording");
  assert.match(real.reason, /independently cross-matches/);
  assert.match(real.reason, /on evidence alone, without using any truth period/);
  const standIn = reviewCandidate({ ...baseInput, standInCurve: true });
  assert.equal(standIn.verdict, "accepted", "the wording fix changes NO verdict and NO threshold");
  assert.match(standIn.reason, /^Stand-in curve: /);
  assert.match(standIn.reason, /by construction and is NOT independent evidence of a recovery/);
  assert.doesNotMatch(standIn.reason, /on evidence alone/, "the self-contradicting clause the audit named must be gone on stand-in rows");
  assert.equal(standIn.score, real.score, "words change, the number does not");
  assert.deepEqual(standIn.checks, real.checks);
  // explicit false is the same as unset (the real-photometry callers pass a decoded boolean):
  assert.deepEqual(reviewCandidate({ ...baseInput, standInCurve: false }).reason, real.reason);
});

test("critique() derives standInCurve from the light-curve SOURCE through the single canonical discriminator", () => {
  const detection = { candidate, aliasMultiple: 1 } as unknown as DetectionResult;
  const real = critique({ detection, catalog, lightCurveSource: "stitched/curated TESS light curve (REAL photometry)" });
  assert.match(real.reason, /^Blind recovery: /, "a real-photometry source keeps the evidence wording");
  const standIn = critique({ detection, catalog, lightCurveSource: "synthetic stand-in generated at the catalog period" });
  assert.match(standIn.reason, /^Stand-in curve: /, "a stand-in source is worded as by-construction");
  const unset = critique({ detection, catalog });
  assert.deepEqual(unset.reason, real.reason, "no source served -> no stand-in claim flipped on (byte-identical to real wording)");
});
