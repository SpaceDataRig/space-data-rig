// Science-digest composer guard (scripts/science-digest.ts). The half-hourly X digest reports SCIENCE as a
// LONG-FORM Premium post -- not commit counts, not one clipped sentence -- so composeDigest is the single place
// that decides what the rig says in public. Offline,
// deterministic, PURE: it takes an already-built window + data and returns text (all network/file I/O lives
// in main(), which the entry guard keeps from running on import).
//
// The load-bearing properties are the HONESTY RED LINES, so those are what we pin:
//  - No new result in the window -> "" (the workflow then posts NOTHING; never an empty/noise tweet).
//  - A blind candidate is ALWAYS "UNCONFIRMED ... for human follow-up", never a discovery.
//  - Only blind-TOI findings (contractually recovered on real photometry) may say "real TESS photometry".
//  - Purity is cited as the LOWER bound it is; numbers carry their basis.
//  - Output is pure ASCII, within X's 25,000-char long-post ceiling, and free of time-implying words
//    (post-x-text.ts enforces ASCII too, and clamps to the same 25,000 ceiling).
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeDigest } from "../scripts/science-digest.ts";
import type { DigestFinding, DigestInput, DigestLedgerEntry, DigestResearch } from "../scripts/science-digest.ts";

const START = "2026-10-16T10:00:00.000Z";
const END = "2026-10-16T11:00:00.000Z";
const IN = "2026-10-16T10:30:00.000Z"; // inside the window
const BEFORE = "2026-10-16T09:00:00.000Z"; // before windowStart
const AFTER = "2026-10-16T12:00:00.000Z"; // after windowEnd

function input(over: Partial<DigestInput> = {}): DigestInput {
  return { windowStart: START, windowEnd: END, ledger: [], findings: [], research: null, researchUpdated: false, ...over };
}

// A ledger row only counts as "anchored" when it carries a real signature inside the window.
const anchored = (findingId: string, at = IN, signature = "5xYsig"): DigestLedgerEntry => ({ findingId, status: "confirmed", signature, anchoredAt: at });

const knownPlanet = (id: string, name: string, periodDays?: number, origin = "revalidation"): DigestFinding => ({
  id,
  targetId: "TIC 3323",
  origin,
  createdAt: IN,
  candidate: periodDays != null ? { periodDays } : undefined,
  crossmatch: { matchedKnownPlanet: true, knownPlanetName: name },
});

const blind = (id: string, targetId: string, createdAt = IN, periodDays?: number): DigestFinding => ({
  id,
  targetId,
  origin: "blind-toi",
  createdAt,
  candidate: periodDays != null ? { periodDays } : undefined,
});

// A realistic research fixture (the shape web/research.json has): the completeness span + the independent blind
// test, so the long-form characterization paragraph is exercised end to end. The numbers mirror the real bundle
// (204 stars, purity 0.5315, completeness 0.358/0.931, recall 0.769, precision 0.333) but are asserted only
// through composeDigest's own rounding -- never hardcoded in a template.
const RICH_RESEARCH: DigestResearch = {
  survey: {
    stars: 204,
    purity: 0.5315315315315315,
    completeness: [
      { depthPpm: 300, rate: 0.35784313725490197 },
      { depthPpm: 8000, rate: 0.9313725490196079 },
    ],
  },
  blindTest: { recall: 0.7692307692307693, precision: 0.3333333333333333 },
};

// The post red lines every composed line must satisfy.
const TIME_WORDS = /\b(this week|last week|next week|recently|overnight|today|tonight|yesterday|last night|this morning|this evening|in recent)\b/i;
function assertTweetSafe(text: string): void {
  assert.ok(text.length > 0, "expected a non-empty line");
  assert.ok(text.length <= 25000, `must fit X's 25,000-char long-post ceiling, got ${text.length}`);
  assert.ok(!/[^\x00-\x7F]/.test(text), "must be pure ASCII (post-x-text.ts refuses non-ASCII)");
  assert.ok(!TIME_WORDS.test(text), `must not imply a time window: ${text}`);
  assert.ok(!/wallet|private key|seed phrase|sol\b|\$\d|usd|cost/i.test(text), "must never mention wallet/key/cost");
}

test("nothing new in the window composes no tweet (empty string -> the workflow posts nothing)", () => {
  assert.equal(composeDigest(input()), "");
});

test("an inverted or unparseable window composes no tweet", () => {
  assert.equal(composeDigest(input({ windowStart: END, windowEnd: START })), ""); // end < start
  assert.equal(composeDigest(input({ windowStart: "nope", windowEnd: END })), ""); // NaN start
});

test("priority 1: a known-planet re-validation sealed on-chain is named, with its period", () => {
  const text = composeDigest(
    input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)] }),
  );
  assert.match(text, /re-verified the known exoplanet HD 189733 b \(P=2\.22d\)/);
  assert.match(text, /sealed the analysis on-chain/);
  assert.match(text, /recovery check/, "long form frames a re-validation as a recovery check, not a discovery");
  assert.match(text, /discoveryClaim=false/);
  assert.match(text, /spacedatarig\.app$/);
  assertTweetSafe(text);
});

test("priority 1: anchored rows that do NOT resolve to a known planet fall back to an honest count", () => {
  const one = composeDigest(input({ ledger: [anchored("f1")], findings: [blind("f1", "TIC 9")] }));
  assert.match(one, /anchored 1 reproducible analysis result on-chain/);
  assert.ok(!/results/.test(one), "singular for exactly one");

  const many = composeDigest(
    input({ ledger: [anchored("f1"), anchored("f2")], findings: [blind("f1", "TIC 9"), blind("f2", "TIC 10")] }),
  );
  assert.match(many, /anchored 2 reproducible analysis results on-chain/);
  assertTweetSafe(many);
});

test("priority 1: a ledger row WITHOUT a signature is not treated as anchored", () => {
  const row: DigestLedgerEntry = { findingId: "f1", status: "confirmed", anchoredAt: IN }; // no signature
  assert.equal(composeDigest(input({ ledger: [row], findings: [knownPlanet("f1", "HD 1 b")] })), "");
});

test("window filtering: results anchored OUTSIDE the window are ignored", () => {
  assert.equal(
    composeDigest(input({ ledger: [anchored("f1", BEFORE)], findings: [knownPlanet("f1", "HD 1 b")] })),
    "",
  );
  assert.equal(
    composeDigest(input({ ledger: [anchored("f1", AFTER)], findings: [knownPlanet("f1", "HD 1 b")] })),
    "",
  );
});

test("priority 2: a newly flagged blind candidate is UNCONFIRMED, for follow-up, never a discovery", () => {
  const text = composeDigest(input({ findings: [blind("f1", "TIC 240720121", IN, 4.5)] }));
  assert.match(text, /flagged 1 new UNCONFIRMED transit candidate/);
  assert.match(text, /real TESS photometry/); // blind-TOI is contractually recovered on real photometry
  assert.match(text, /for human follow-up rather than any claimed discovery/);
  assert.match(text, /\(e\.g\. TIC 240720121, P=4\.50d\)/);
  assert.match(text, /discoveryClaim=false/);
  assert.ok(!/discovered/i.test(text), "must never claim a discovery");
  assertTweetSafe(text);
});

test("priority 2: plural, and the newest candidate is the example", () => {
  const text = composeDigest(
    input({ findings: [blind("f1", "TIC 1", "2026-10-16T10:10:00.000Z"), blind("f2", "TIC 2", "2026-10-16T10:50:00.000Z")] }),
  );
  assert.match(text, /flagged 2 new UNCONFIRMED transit candidates/);
  assert.match(text, /e\.g\. TIC 2\b/, "the newest by createdAt is the example");
  assertTweetSafe(text);
});

test("window filtering: blind candidates created OUTSIDE the window are ignored", () => {
  assert.equal(composeDigest(input({ findings: [blind("f1", "TIC 1", BEFORE)] })), "");
  assert.equal(composeDigest(input({ findings: [blind("f1", "TIC 1", AFTER)] })), "");
});

test("priority ordering: an on-chain result outranks a blind candidate in the same window", () => {
  const text = composeDigest(
    input({
      ledger: [anchored("k1")],
      findings: [knownPlanet("k1", "HD 189733 b", 2.2), blind("b1", "TIC 7", IN, 3.1)],
    }),
  );
  assert.match(text, /re-verified the known exoplanet HD 189733 b/);
  assert.ok(!/UNCONFIRMED/.test(text), "the anchored line wins, so no blind text");
});

test("priority 3: a research milestone fires only when research.json landed in the window", () => {
  const research: DigestResearch = { survey: { stars: 204, purity: 0.5315315 } };
  const text = composeDigest(input({ research, researchUpdated: true }));
  assert.match(text, /research update/);
  assert.match(text, /characterized on 204 real public TESS-SPOC stars/);
  assert.match(text, /purity LOWER bound is 53%/, "purity is rounded and labelled a LOWER bound");
  assert.match(text, /a genuine but uncatalogued planet is counted against it/);
  assert.match(text, /discoveryClaim=false/);
  assertTweetSafe(text);
});

test("priority 3: research NOT updated this window -> no milestone (never re-posts a stale metric)", () => {
  const research: DigestResearch = { survey: { stars: 204, purity: 0.53 } };
  assert.equal(composeDigest(input({ research, researchUpdated: false })), "");
});

test("priority 3: researchUpdated with missing survey data composes no tweet", () => {
  assert.equal(composeDigest(input({ research: null, researchUpdated: true })), "");
  assert.equal(composeDigest(input({ research: {}, researchUpdated: true })), "");
});

test("priority 3: a milestone with stars but no purity still composes, omitting the purity clause", () => {
  const text = composeDigest(input({ research: { survey: { stars: 120 } }, researchUpdated: true }));
  assert.match(text, /characterized on 120 real public TESS-SPOC stars/);
  assert.ok(!/purity/.test(text), "no purity -> no purity clause");
  assertTweetSafe(text);
});

test("hard-trim: an absurdly long body is clipped to <=25000 chars ending in an ellipsis", () => {
  const longName = "X".repeat(26000); // far past even the 25,000 long-post ceiling
  const text = composeDigest(input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", longName)] }));
  assert.ok(text.length <= 25000, `clipped length ${text.length}`);
  assert.match(text, /\.\.\.$/);
  assertTweetSafe(text);
});

test("every representative line obeys the post red lines (ASCII, length, no time words, no cost/wallet)", () => {
  const lines = [
    composeDigest(input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)] })),
    composeDigest(input({ ledger: [anchored("f1"), anchored("f2")], findings: [blind("f1", "TIC 9"), blind("f2", "TIC 10")] })),
    composeDigest(input({ findings: [blind("f1", "TIC 240720121", IN, 4.5)] })),
    composeDigest(input({ research: { survey: { stars: 204, purity: 0.5315 } }, researchUpdated: true })),
    // long-form variants that also carry the full characterization context
    composeDigest(input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)], research: RICH_RESEARCH })),
    composeDigest(input({ findings: [blind("f1", "TIC 240720121", IN, 4.5)], research: RICH_RESEARCH })),
    composeDigest(input({ research: RICH_RESEARCH, researchUpdated: true })),
  ];
  for (const text of lines) assertTweetSafe(text);
});

test("long-form: the research milestone cites the completeness span and the independent blind test", () => {
  const text = composeDigest(input({ research: RICH_RESEARCH, researchUpdated: true }));
  assert.match(text, /completeness rises from 36% at 300 ppm to 93% at 8000 ppm/);
  assert.match(text, /purity LOWER bound is 53%/);
  assert.match(text, /independent sealed-key blind test measured 77% recall at 33% precision/);
  assert.match(text, /not discoveries/);
  assert.match(text, /spacedatarig\.app$/);
  assert.ok(text.length > 280, "a long-form digest intentionally runs past the classic 280-char post");
  assertTweetSafe(text);
});

test("long-form: a known-planet re-validation carries the survey as SEPARATE context, never as photometry it recovered", () => {
  const text = composeDigest(
    input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)], research: RICH_RESEARCH }),
  );
  assert.match(text, /re-verified the known exoplanet HD 189733 b \(P=2\.22d\)/);
  assert.match(text, /recovery check/);
  assert.match(text, /separately characterized on 204 real public TESS-SPOC stars/);
  assert.match(text, /completeness rises from 36% at 300 ppm to 93% at 8000 ppm/);
  assert.match(text, /discoveryClaim=false/);
  // Red line: the re-validation clause itself must NOT claim it ran on real photometry (its photons may be seeded
  // stand-ins); only the separate characterization may cite the real public survey.
  assert.ok(!/re-verified[^.]*real (TESS|public)/.test(text), "the revalidation clause must not borrow real-photometry provenance");
  assertTweetSafe(text);
});
