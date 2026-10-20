// Tests for the critic's false-positive vetting path. The load-bearing guarantee is that
// vetting is fully ADDITIVE and gated: with no vetting supplied the ReviewResult is
// byte-for-byte identical to before (so the deterministic synthetic/bundle path is
// untouched), and only a supplied failing metric can downgrade a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewCandidate, type ReviewInput } from "../src/critic/review.ts";
import { critique } from "../src/seats/seats.ts";
import type { DetectionResult } from "../src/detect/pipeline.ts";
import type { ArchivePlanet, TransitCandidate } from "../src/core/types.ts";

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

/** A catalog entry the base candidate independently cross-matches at P=3.5d (blind recovery). */
const catalog: ArchivePlanet[] = [{ pl_name: "VET-TEST-1 b", hostname: "VET-TEST-1", pl_orbper: 3.5 }];

const baseInput: ReviewInput = {
  candidate,
  aliasMultiple: 1,
  catalog,
  nTransitsObserved: 5,
};

test("base blind candidate is accepted (control for the vetting cases below)", () => {
  const r = reviewCandidate(baseInput);
  assert.equal(r.verdict, "accepted", `expected accepted, got ${r.verdict}: ${r.reason}`);
  assert.ok(r.crossmatch.matchedKnownPlanet, "the accept must rest on an independent catalog cross-match");
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

test("a high systematics-aware FAP (coherent artifact) downgrades to rejected", () => {
  const r = reviewCandidate({ ...baseInput, vetting: { systematicsFap: 0.5 } });
  assert.equal(r.verdict, "rejected");
  assert.match(r.reason, /ensemble-common instrumental systematic/);
  assert.ok(r.checks.some((x) => x.name === "systematics-fap" && x.pass === false));
});

test("a low systematics-aware FAP keeps the accept and adds a passing check", () => {
  const plain = reviewCandidate(baseInput);
  const r = reviewCandidate({ ...baseInput, vetting: { systematicsFap: 1e-4 } });
  assert.equal(r.verdict, "accepted");
  const c = r.checks.find((x) => x.name === "systematics-fap");
  assert.ok(c && c.pass === true, "systematics-fap check should pass for a low FAP");
  assert.ok(r.score >= plain.score && r.score <= plain.score + 5, "passing vetting adds at most +5");
});

test("vetting can reject an otherwise-accepted recovery-gated candidate (override is absolute)", () => {
  const rec: ReviewInput = {
    ...baseInput,
    truthSource: "catalog",
    truthPeriodDays: 3.5,
    recoveryGating: true,
    vetting: { centroidShiftArcsec: 30 },
  };
  const r = reviewCandidate(rec);
  assert.equal(r.verdict, "rejected", "a 30 arcsec shift must reject even a period-perfect match");
});

test("critique() forwards vetting to the review (the path both the edge and Node use)", () => {
  const detection = { candidate, aliasMultiple: 1 } as unknown as DetectionResult;
  const plain = critique({ detection, catalog });
  assert.equal(plain.verdict, "accepted", "control: the strong cross-matched blind candidate is accepted");
  const vetted = critique({ detection, catalog, vetting: { centroidShiftArcsec: 12.5 } });
  assert.equal(vetted.verdict, "rejected", "critique must pass vetting through to a rejection");
  assert.ok(vetted.checks.some((x) => x.name === "centroid-shift" && x.pass === false));
});

// ---- BLIND-by-default protocol (the honest critic) ----

test("a significant blind signal with NO catalog match is capped at needs-more-data (never a claimed discovery)", () => {
  const r = reviewCandidate({ ...baseInput, catalog: [] });
  assert.equal(r.verdict, "needs-more-data", `a novel signal must not be auto-accepted, got ${r.verdict}`);
  assert.match(r.reason, /no catalog match/, "the reason must state it is not a claimed discovery");
});

test("truth is a POST-HOC non-gating check in blind mode: verdict and score ignore it", () => {
  const blind = reviewCandidate(baseInput);
  const withTruth = reviewCandidate({ ...baseInput, truthPeriodDays: 3.5, truthSource: "injected" });
  assert.equal(withTruth.verdict, blind.verdict, "truth must not change the blind verdict");
  assert.equal(withTruth.score, blind.score, "truth must not inflate the blind score");
  const postHoc = withTruth.checks.find((x) => x.name === "period-vs-truth (post-hoc, non-gating)");
  assert.ok(postHoc, "the truth cross-check is recorded, labelled non-gating");
  assert.ok(!blind.checks.some((x) => x.name.startsWith("period-vs-truth")), "no truth check when no truth is supplied");
});

test("a blind verdict is driven by evidence even when the known period disagrees", () => {
  // truth says the real period is far off, but blind mode must NOT consult it: the candidate still
  // cross-matches the catalog and passes the evidence, so it is accepted (and the post-hoc check
  // honestly records the disagreement without gating on it).
  const r = reviewCandidate({ ...baseInput, truthPeriodDays: 9.9, truthSource: "injected" });
  assert.equal(r.verdict, "accepted", "blind mode ignores the disagreeing truth period");
  const postHoc = r.checks.find((x) => x.name === "period-vs-truth (post-hoc, non-gating)");
  assert.ok(postHoc && postHoc.pass === false, "the disagreement is recorded as a failing NON-gating check");
});

test("recoveryGating:true opts into the benchmark self-test (truth gates the verdict)", () => {
  const hit = reviewCandidate({ ...baseInput, truthPeriodDays: 3.5, recoveryGating: true });
  assert.equal(hit.verdict, "accepted", "a period-perfect recovery is accepted under gating");
  assert.ok(hit.checks.some((x) => x.name === "period-vs-truth"), "gating mode labels the check as gating");
  const miss = reviewCandidate({ ...baseInput, catalog: [], truthPeriodDays: 9.9, recoveryGating: true });
  assert.equal(miss.verdict, "rejected", "a period far from truth is rejected under gating");
});

test("a signal matching a known planet only via a HARMONIC is capped at needs-more-data (probable alias)", () => {
  // candidate at 7.0d cross-matches the 3.5d catalog planet only at harmonic x0.5 -> an alias,
  // never a clean blind recovery, so it must not be accepted/anchored.
  const aliasCandidate: TransitCandidate = { ...candidate, periodDays: 7.0 };
  const r = reviewCandidate({ ...baseInput, candidate: aliasCandidate });
  assert.equal(r.verdict, "needs-more-data", `a harmonic-only match must not be accepted, got ${r.verdict}`);
  assert.match(r.reason, /harmonic/, "the reason must name the harmonic alias");
});

test("an unresolved odd-even alias (aliasMultiple != 1) is capped at needs-more-data", () => {
  const r = reviewCandidate({ ...baseInput, aliasMultiple: 2 });
  assert.equal(r.verdict, "needs-more-data", `an unresolved alias must not be accepted, got ${r.verdict}`);
  assert.match(r.reason, /alias/);
});

// ---- audit #5: a degenerate fit must not be described as "physically-consistent" ----

const CAP = (cand: TransitCandidate, over: Partial<ReviewInput> = {}): ReviewInput => ({
  ...baseInput, candidate: cand, ...over,
});

test("a clean cross-matched accept still says physically-consistent (control)", () => {
  const r = reviewCandidate(baseInput);
  assert.equal(r.verdict, "accepted");
  assert.match(r.reason, /physically-consistent/, "a non-degenerate recovery keeps the plain wording");
  assert.ok(!r.checks.some((x) => x.name.startsWith("significance-plausibility")));
});

test("a box SNR far above any physical transit is flagged degenerate, not " + '"physically-consistent"', () => {
  const absurd: TransitCandidate = { ...candidate, snr: 45171 };
  const r = reviewCandidate(CAP(absurd, { catalog: [] }));
  assert.equal(r.verdict, "needs-more-data", "degeneracy must not flip the verdict tier (honesty-only wording)");
  assert.doesNotMatch(r.reason, /physically-consistent/, "a 45171 SNR cannot be called physically-consistent");
  assert.match(r.reason, /DEGENERATE/);
  assert.ok(r.checks.some((x) => x.name === "significance-plausibility (informational, non-gating)" && x.pass === false),
    "the implausible SNR is recorded as a non-gating check");
});

test("a period at the long-edge of the search grid is not called physically-consistent", () => {
  const edge: TransitCandidate = { ...candidate, periodDays: 16.0, atSearchBoundary: true, searchMaxPeriodDays: 16 } as TransitCandidate;
  const r = reviewCandidate(CAP(edge, { catalog: [] }));
  assert.doesNotMatch(r.reason, /physically-consistent/, "an unmeasured boundary period cannot claim physical consistency");
  assert.match(r.reason, /DEGENERATE/);
});

test("a candidate at x4 of a catalogued planet is recognized as a harmonic alias (audit: F-TOI-1860-b)", () => {
  // catalog planet at 3.5 d; candidate at 0.875 d = 3.5/4. Before harmonics 4 and 1/4 were added this read as
  // "no catalog match"; now crossmatchPeriod finds it at f=4 and review names the alias.
  const x4: TransitCandidate = { ...candidate, periodDays: 0.875 };
  const r = reviewCandidate(CAP(x4));
  assert.equal(r.verdict, "needs-more-data", "an x4 harmonic-only match must never be accepted/anchored");
  assert.ok(r.crossmatch.matchedKnownPlanet, "the catalogued planet must now be recognized via the x4 harmonic");
  assert.equal(r.crossmatch.harmonic, 4, "the identified harmonic multiple is 4");
  assert.match(r.reason, /harmonic/, "the reason names it as a probable alias");
});

// ---- audit #5: the crossmatch tri-state (hit/alias vs no-match vs off-slice vs lookup-failed) ----

const novel = (over: Partial<ReviewInput> = {}): ReviewInput => CAP(candidate, { catalog: [], ...over });

test("crossmatch tri-state is opt-in: with no lookup fields the novel reason and crossmatch are unchanged", () => {
  const r = reviewCandidate(novel());
  assert.equal(r.verdict, "needs-more-data");
  assert.match(r.reason, /with no catalog match -- a candidate for follow-up, not a claimed discovery\./);
  assert.equal(r.crossmatch.status, undefined, "no tri-state stamped on the default path (hash unchanged)");
  assert.ok(!r.checks.some((x) => x.name.startsWith("catalog-lookup")));
});

test("a FAILED catalog lookup is not read as novelty: the reason states novelty is undetermined", () => {
  const r = reviewCandidate(novel({ catalogSource: "failed" }));
  assert.equal(r.verdict, "needs-more-data");
  assert.match(r.reason, /did NOT complete|novelty is undetermined/);
  assert.doesNotMatch(r.reason, /not a claimed discovery/, "a failed lookup must not assert novelty either way");
  assert.equal(r.crossmatch.status, "lookup-failed");
  const chk = r.checks.find((x) => x.name === "catalog-lookup (informational, non-gating)");
  assert.ok(chk && chk.pass === false, "the failed lookup is a NON-gating check (excluded from the content hash)");
});

test("a fallback slice is likewise 'lookup incomplete', never 'novel'", () => {
  const r = reviewCandidate(novel({ catalogSource: "fallback" }));
  assert.equal(r.crossmatch.status, "lookup-failed");
  assert.match(r.reason, /undetermined/);
});

test("an off-slice planet is labeled already-published (NOT novel) and still never accepted", () => {
  const offSlicePlanet: ArchivePlanet = { pl_name: "VET-TEST-1 b", hostname: "VET-TEST-1", pl_orbper: 3.5 };
  const r = reviewCandidate(novel({ catalogSource: "nasa-tap", hostCatalog: [offSlicePlanet] }));
  assert.equal(r.verdict, "needs-more-data", "an off-slice match must not create an accept");
  assert.equal(r.crossmatch.matchedKnownPlanet, false, "the bulk slice genuinely did not match");
  assert.equal(r.crossmatch.status, "off-slice");
  assert.match(r.reason, /IS announced for this host|NOT novel/);
  const chk = r.checks.find((x) => x.name === "catalog-lookup (informational, non-gating)");
  assert.ok(chk && chk.pass === true, "a completed off-slice lookup is not a failure");
});

test("a completed per-host lookup with nothing announced is a genuine novel reading", () => {
  const r = reviewCandidate(novel({ catalogSource: "nasa-tap", hostCatalog: [] }));
  assert.equal(r.verdict, "needs-more-data");
  assert.equal(r.crossmatch.status, "none");
  assert.match(r.reason, /with no catalog match -- a candidate for follow-up, not a claimed discovery\./);
});

test("the tri-state never widens the accept set: a direct slice hit still accepts with status hit", () => {
  const r = reviewCandidate({ ...baseInput, catalogSource: "nasa-tap" });
  assert.equal(r.verdict, "accepted");
  assert.equal(r.crossmatch.status, "hit");
});
