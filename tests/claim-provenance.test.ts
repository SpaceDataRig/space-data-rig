// P91 claim-provenance rules test -- the offline half of "a rule that quietly changed direction is caught
// rather than admired" (the note in reports/p91-claims.json promises exactly this file).
//
// What is pinned here, and why it is the right thing to pin:
//   (1) the control grid. Every row of reports/p91-claims.json carries `expect` tiers, checked against the PURE
//       rule layer (src/claims/claimReview.ts) using records transcribed from the live resolvers. No network, so
//       CI fails when a rule changed, never when the internet had a bad day.
//   (2) the distinctions a sloppy verifier gets wrong: "the identifier does not exist" (evidence) vs "the request
//       failed" (not evidence); a resolved link that contradicts the post (MISMATCH) vs a link that resolves
//       (not agreement); freshness wording with no date (UNVERIFIABLE) vs a big honest lag without wording
//       (silent).
//   (3) the invariants: attribution reads ONLY the ids the post cited, never the ids we located for it;
//       safeToGate is false everywhere; no output string carries discovery wording.
//
// The live re-check is the script itself (npm run p91:claim-provenance); this file is the part CI can own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RECENCY_INFLATION_DAYS,
  extractMicronBand,
  platformTerms,
  presentPhenomenonClasses,
  reviewClaim,
  type PrimaryRecord,
  type PublicClaim,
} from "../src/claims/claimReview.ts";

/* ------------------------------------------------------------------ fixture + captured records -------- */

interface Row {
  id: string;
  kind: string;
  text: string;
  postedUtc: string;
  asserted: { mission: string; instrument?: string; agency?: string };
  citedIds: string[];
  locatedIds?: string[];
  expect?: Record<string, string>;
}

const FIXTURE = resolve(process.cwd(), "reports", "p91-claims.json");
const rows = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { claims: Row[] }).claims;

// Transcribed from the registering bodies on 2026-10-18 (Crossref for the DOI -- abstract included, because
// Crossref really does serve one -- and the arXiv API for the id). The same records scripts/p91-claim-provenance.ts
// embeds as CAPTURED; if a transcription and the script's copy ever diverge, the offline grid here fails before
// the live run is trusted. The LaTeX/unit characters are escapes so this file stays pure ASCII.
const DOI_RECORD: PrimaryRecord = {
  kind: "doi",
  id: "10.3847/1538-4357/ae9a94",
  resolved: true,
  title: "A Single Line Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy",
  abstract:
    "Abstract We report the detection of a previously unknown object with a single emission line within the Hubble Ultra Deep Field, " +
    "using a new JWST NIRSpec technique called Multiobject Coronagraphy for Slitless Spectroscopy (MOCSS) with the G140M/F100LP observing mode. " +
    "This line is detected at 1.60 \u00b5 m with a line flux of [2.5 \u00b1 0.3] \u00d7 10 \u221218 erg s \u22121 cm \u22122, and does not correspond to any " +
    "known source. We discuss possible active galactic nucleus and transient phenomena that could explain the finding.",
  publishedUtc: "2026-09-22T00:00:00Z",
  venue: "The Astrophysical Journal",
  publisher: "American Astronomical Society",
};
const ARXIV_RECORD: PrimaryRecord = {
  kind: "arxiv",
  id: "2610.12553",
  resolved: true,
  title: "A Single Line-Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy",
  abstract:
    "We report the detection of a previously unknown object with a single emission line within the Hubble Ultra Deep Field, using a new JWST NIRSpec " +
    "technique called Multi-Object Coronagraphy for Slitless Spectroscopy (MOCSS) with the G140M/F100LP observing mode. This line is detected at " +
    "1.60 $\\rm \u03bcm$ with a line flux of $[2.5\\pm 0.3]\\times10^{-18} \\rm erg\\ s^{-1} cm^{-2}$ and does not correspond to any known source. " +
    "We discuss possible AGN and transient phenomena that could explain the finding.",
  publishedUtc: "2026-10-08T18:00:01Z",
  venue: "arXiv",
};

const AS_DEAD: PrimaryRecord = { kind: "doi", id: "10.0000/this-identifier-does-not-exist", resolved: false, reason: "not-found" };

/** The primaries each row's verdict is computed from, offline. Mirrors the script's cited+located union. */
function recordsFor(row: Row): PrimaryRecord[] {
  const ids = [...row.citedIds, ...(row.locatedIds ?? [])];
  return ids.map((id) => {
    if (id === DOI_RECORD.id) return DOI_RECORD;
    if (id === ARXIV_RECORD.id) return ARXIV_RECORD;
    if (id === AS_DEAD.id) return AS_DEAD;
    // NOTE: AS_DEAD resolves to a transcribed not-found record (live Crossref really returns 404 for it);
    // an id with no captured record and no such evidence stays a transport unknown, never invented.
    // An id with no captured record must NOT be invented -- the script reports it as transport-unknown, and so
    // does this grid. Nothing in the fixture relies on this branch, and the last test proves it stays empty.
    return { kind: id.startsWith("10.") ? "doi" : "arxiv", id, resolved: false, reason: "transport" as const };
  });
}

function claimOf(row: Row): PublicClaim {
  const claim: PublicClaim = {
    id: row.id,
    text: row.text,
    postedUtc: row.postedUtc,
    asserted: { ...row.asserted },
    citedIds: row.citedIds,
    locatedIds: row.locatedIds ?? [],
  };
  // Same fallback order as the script: the post's own number first, then the located record's abstract --
  // a band always comes from citable text, never from the reviewer's memory.
  const fromRecord = extractMicronBand(recordsFor(row).map((p) => p.abstract ?? "").join(" "));
  const band = extractMicronBand(row.text);
  if (band) claim.asserted.band = band;
  else if (fromRecord) claim.bandFromPrimary = fromRecord;
  return claim;
}

/* ------------------------------------------------------------------ (1) the control grid ---------------- */

test("every expectation-bearing fixture row meets its declared tiers offline, against the pure rules", () => {
  const bearing = rows.filter((r) => Object.keys(r.expect ?? {}).length);
  assert.ok(bearing.length >= 4, `the grid should carry at least 4 expectation rows, found ${bearing.length}`);
  for (const row of bearing) {
    // Coverage of the real row depends on sector lookup; pass null (not checked) so the axis rule that DOES get
    // pinned -- band drives NOT-IN-OUR-BAND regardless of coverage -- is the one under test.
    const review = reviewClaim(claimOf(row), recordsFor(row), null);
    const got = (axis: string): string => {
      const box = (review as unknown as Record<string, { tier?: string }>)[axis];
      assert.ok(box && typeof box.tier === "string", `${row.id}: axis ${axis} missing from the review`);
      return box.tier;
    };
    for (const [axis, want] of Object.entries(row.expect!)) {
      assert.equal(got(axis), want, `${row.id} axis ${axis}`);
    }
  }
});

test("the positive control actually passes clean -- a verifier that only complains is caught by this row", () => {
  const control = rows.find((r) => r.kind === "control-positive");
  assert.ok(control, "reports/p91-claims.json must ship a control-positive row");
  const review = reviewClaim(claimOf(control), recordsFor(control), null);
  assert.equal(review.recency.tier, "NO-TIMING-CLAIM");
  assert.equal(review.attribution.tier, "CITES-PRIMARY");
  assert.equal(review.subject.tier, "MATCH", "the control speaks the paper's own words; a grid that forced disagreement here would be rigging the verifier");
  assert.ok(!review.timingWords.length, "the same-day control must assert no freshness term");
});

test("the dead-identifier control reports CITATION-DOES-NOT-RESOLVE and never pretends to know the sky", () => {
  const control = rows.find((r) => r.id === "control-dead-identifier");
  assert.ok(control);
  const review = reviewClaim(claimOf(control), recordsFor(control), null);
  assert.equal(review.attribution.tier, "CITATION-DOES-NOT-RESOLVE");
  assert.equal(review.subject.tier, "UNRESOLVED");
  assert.equal(review.recency.tier, "UNVERIFIABLE", "no date could be resolved, so the lag is UNKNOWN, not wrong");
});

/* ------------------------------------------------------------------ (2) rule edges the grid implies -- */

test("a transport failure is never evidence: same dead id, different reason, different tier", () => {
  const base: PublicClaim = {
    id: "t", text: "JUST IN: JWST detects a line.", postedUtc: "2026-10-17T00:00:00Z",
    asserted: { mission: "JWST" }, citedIds: ["10.3847/1538-4357/ae9a94"],
  };
  const notFound = reviewClaim(base, [{ ...DOI_RECORD, resolved: false, reason: "not-found" }], null);
  const transport = reviewClaim(base, [{ ...DOI_RECORD, resolved: false, reason: "transport" }], null);
  assert.equal(notFound.attribution.tier, "CITATION-DOES-NOT-RESOLVE");
  // The transport row must NOT be reported as a broken citation; it is "we could not look".
  assert.notEqual(transport.attribution.tier, "CITATION-DOES-NOT-RESOLVE");
  assert.equal(transport.recency.tier, "UNVERIFIABLE");
  assert.equal(transport.subject.tier, "UNRESOLVED");
});

test("recency flips exactly at the stated allowance, and only when a freshness term is present", () => {
  // Both transcribed dates in play: the rule takes the EARLIEST resolvable, so the lag runs off 2026-09-22.
  const dated: PrimaryRecord[] = [DOI_RECORD, { ...ARXIV_RECORD, publishedUtc: "2026-10-08T18:00:01Z" }];
  const anchor = Date.parse("2026-09-22T00:00:00Z");
  const mk = (days: number, fresh: boolean): PublicClaim => ({
    id: "r", text: fresh ? "JUST IN: a line from JWST." : "Looking back: a line from JWST.",
    postedUtc: new Date(anchor + days * 86400000).toISOString(),
    asserted: { mission: "JWST" }, citedIds: ["2610.12553", "10.3847/1538-4357/ae9a94"],
  });
  assert.equal(reviewClaim(mk(RECENCY_INFLATION_DAYS, true), dated, null).recency.tier, "CONSISTENT");
  assert.equal(reviewClaim(mk(RECENCY_INFLATION_DAYS + 1, true), dated, null).recency.tier, "INFLATED");
  assert.equal(reviewClaim(mk(RECENCY_INFLATION_DAYS + 400, false), dated, null).recency.tier, "NO-TIMING-CLAIM");
});

test("a resolving link that contradicts the post is MISMATCH, not a pass", () => {
  // Chandra is asserted by the post and appears NOWHERE in the record; Hubble would, because this paper's own
  // abstract cites the deepest HST imaging -- a control built on Hubble would pass for the wrong reason.
  const wrongPlatform: PublicClaim = {
    id: "m", text: "JUST IN: the Chandra X-ray Observatory detects an emission line where no source is known.",
    postedUtc: "2026-10-17T00:00:00Z", asserted: { mission: "Chandra X-ray Observatory" },
    citedIds: ["10.3847/1538-4357/ae9a94"],
  };
  const review = reviewClaim(wrongPlatform, [DOI_RECORD], null);
  assert.equal(review.subject.tier, "MISMATCH");
  assert.equal(review.attribution.tier, "CITES-PRIMARY", "attribution and subject are separate axes, by design");
});

test("attribution reads only the ids the POST cited -- our located ids never launder the poster's diligence", () => {
  const citesNothing: PublicClaim = {
    id: "a", text: "JUST IN: JWST detects a mysterious signal from an empty void.", postedUtc: "2026-10-17T00:00:00Z",
    asserted: { mission: "JWST" }, citedIds: [], locatedIds: [DOI_RECORD.id],
  };
  const review = reviewClaim(citesNothing, [DOI_RECORD], null);
  assert.equal(review.attribution.tier, "NO-CITATION");
  assert.equal(review.subject.tier, "MATCH", "subject is judged against cited + located, so locating still counts there");
});

test("the band comes from citable text -- LaTeX units included -- and lands outside TESS at 1.60 micron", () => {
  assert.deepEqual(extractMicronBand("a 1.6 micron emission line"), { loMicron: 1.4, hiMicron: 1.8 });
  // The forms the registering bodies actually serve: arXiv LaTeX "$\rm <mu>m$" and Crossref's spaced "<mu> m".
  assert.deepEqual(extractMicronBand("detected at 1.60 $\\rm \u03bcm$ with a flux"), { loMicron: 1.4, hiMicron: 1.8 });
  assert.deepEqual(extractMicronBand("detected at 1.60 \u00b5 m with"), { loMicron: 1.4, hiMicron: 1.8 });
  // Traps that must NOT produce a band: a loose m unit, a flux exponent's digits, a cm in a flux denominator.
  assert.equal(extractMicronBand("no wavelength here at all"), null);
  assert.equal(extractMicronBand("0 micron nonsense"), null);
  assert.equal(extractMicronBand("a survey since 1971 miles apart"), null);
  assert.equal(extractMicronBand("flux 2.5 \u00d7 10 \u221218 erg s \u22121 cm \u22122"), null);
  const fromPost = reviewClaim(
    { id: "b", text: "an infrared signal at 1.6 micron from JWST", postedUtc: "2026-10-17T00:00:00Z", asserted: { mission: "JWST", band: { loMicron: 1.4, hiMicron: 1.8 } }, citedIds: [] },
    [], null,
  );
  assert.equal(fromPost.band.tier, "DISJOINT");
  const fromRecord = reviewClaim(claimOf(rows.find((r) => r.id === "polymarket-jwst-void-2026-10-17")!), recordsFor(rows.find((r) => r.id === "polymarket-jwst-void-2026-10-17")!), null);
  assert.equal(fromRecord.band.tier, "DISJOINT", "the post only says infrared; the records' own 1.60 micron carries it");
  assert.ok(fromRecord.band.basis.includes("primary record"), "the basis must say where the number came from");
});

test("band decides reach, coverage never merges into an optimistic sentence", () => {
  const disjoint = reviewClaim(
    { id: "c", text: "a 4.4 micron line from JWST", postedUtc: "2026-10-01T00:00:00Z", asserted: { mission: "JWST", band: { loMicron: 4.2, hiMicron: 4.6 } }, citedIds: [] },
    [], [105, 106], // covered position, wrong wavelength
  );
  assert.equal(disjoint.corroboration.tier, "NOT-IN-OUR-BAND");
  assert.ok(disjoint.corroboration.basis.includes("105,106"), "coverage is still PRINTED, just not merged");
  const unstated = reviewClaim(
    { id: "d", text: "JWST sees something", postedUtc: "2026-10-01T00:00:00Z", asserted: { mission: "JWST" }, citedIds: [] },
    [], [105],
  );
  assert.equal(unstated.corroboration.tier, "COVERAGE-NOT-CHECKED", "no usable band -> no statement, even with coverage");
});

/* ------------------------------------------------------------------ (3) invariants ----------------------- */

test("safeToGate is false on every row, and nothing in the output reads like a discovery", () => {
  const banned = /\b(discovery|discovered|confirmed planet|validated planet)\b/i;
  for (const row of rows) {
    const review = reviewClaim(claimOf(row), recordsFor(row), null);
    assert.equal(review.safeToGate, false, `${row.id}: safeToGate`);
    const printed = JSON.stringify(review);
    assert.ok(!banned.test(printed), `${row.id}: output carries discovery wording: ${printed.slice(0, 120)}`);
  }
});

test("every identifier the fixture mentions has a captured record, so the offline grid tests no invented data", () => {
  for (const row of rows) {
    for (const id of [...row.citedIds, ...(row.locatedIds ?? [])]) {
      const rec = recordsFor(row).find((p) => p.id === id.replace(/^doi:\s*/i, ""));
      assert.ok(rec, `${row.id}: no record for ${id}`);
      if (rec!.reason === "transport") {
        assert.equal(id, "only-transport-if-unmapped", `unmapped id in the fixture: ${id}`);
      }
    }
  }
});

test("phenomenon classes and platform aliases are synonym classes, not raw tokens", () => {
  assert.ok(presentPhenomenonClasses("a mysterious emitter in an empty void").length >= 2);
  assert.deepEqual(platformTerms("jameswebbspace").sort(), ["jameswebbspace", "jwst", "webb"], "the literal token is kept alongside the alias class, by design");
  assert.ok(platformTerms("some-unmapped-instrument").includes("some-unmapped-instrument"), "an unknown name must stay itself, not vanish");
});
