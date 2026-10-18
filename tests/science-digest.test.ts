// Science-digest composer guard (scripts/science-digest.ts). The half-hourly X digest reports SCIENCE as a
// LONG-FORM Premium post -- not commit counts, not one clipped sentence -- so composeDigest is the single place
// that decides what the rig says in public. Offline,
// deterministic, PURE: it takes an already-built window + data and returns text (all network/file I/O lives
// in main(), which the entry guard keeps from running on import).
//
// The load-bearing properties are the HONESTY RED LINES, so those are what we pin:
//  - No new science -> "" (the workflow posts NOTHING) -- UNLESS the window carries commit subjects (devCommits),
//    when composeDigest emits a BUILD NOTE (development-progress tier); and, absent both, unless a silence-heartbeat
//    threshold (heartbeatAfterMinutes) is supplied AND the channel has been silent that long, when it emits an
//    honest status note. With no devCommits and no threshold (the default) the post-nothing behavior is unchanged.
//  - NO per-post "discoveryClaim=false" stamp: honesty is carried by plain wording + numbers-with-basis. The standing
//    characterization block + research/figure/p49 links attach ONLY to the research milestone; routine result and
//    candidate posts stay LEAN (headline + one honest line + the sealing tx when any + the live rig).
//  - A blind candidate is ALWAYS "UNCONFIRMED ... for human follow-up", never a discovery.
//  - Only blind-TOI findings (contractually recovered on real photometry) may say "real TESS photometry".
//  - Purity is cited as the LOWER bound it is; numbers carry their basis.
//  - Output is pure ASCII, within X's 25,000-char long-post ceiling, and free of time-implying words
//    (post-x-text.ts enforces ASCII too, and clamps to the same 25,000 ceiling).
//  - LAYOUT: the long-form post is MULTI-LINE (blocks split by a blank line; numbers/proof as ASCII "- " bullets),
//    never a run-on paragraph -- X renders newlines but has no rich text. clip() and post-x-text.ts both preserve
//    newlines (they collapse spaces WITHIN a line, never join lines).
//  - PROOF LINKS: a "Proof:" block cites only artifacts that CORRESPOND to a number actually shown -- on-chain tx
//    (when this window anchored one), research.json (any number), results-figure.svg (completeness/purity), the
//    P49 blind-test report (recall/precision), and always the live rig. P47 / milestone-figure.svg depict OTHER
//    experiments and are never linked (a proof link must match the exact number it is offered for).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeDigest, DEV_BULLETS_MAX } from "../scripts/science-digest.ts";
import { overclaimViolations, BUILD_NOTE_HEADLINES, rejectedDevSubjects } from "../scripts/science-digest.ts";
import { isBuildNoteText } from "../scripts/x-last-post.ts";
import type { DigestFinding, DigestInput, DigestLedgerEntry, DigestResearch } from "../scripts/science-digest.ts";

const START = "2026-10-16T10:00:00.000Z";
const END = "2026-10-16T11:00:00.000Z";
const IN = "2026-10-16T10:30:00.000Z"; // inside the window
const BEFORE = "2026-10-16T09:00:00.000Z"; // before windowStart
const AFTER = "2026-10-16T12:00:00.000Z"; // after windowEnd

function input(over: Partial<DigestInput> = {}): DigestInput {
  return { windowStart: START, windowEnd: END, ledger: [], findings: [], research: null, researchUpdated: false, ...over };
}

// A ledger row only counts as "anchored" when it carries a real signature inside the window. It also carries the
// live mainnet explorer URL the digest prints as on-chain proof. TX_URL is deliberately red-line-clean: pure-ASCII
// https, no whitespace, and free of "cost"/"usd"/"wallet" and of a standalone "sol" ("solana" has no word boundary
// after "sol", so assertTweetSafe's /sol\b/ does not fire on it).
const TX_URL = "https://explorer.solana.com/tx/5xYsigProofOfAnchor123ABCdefGHIjklMNOpqrSTUvwxyz?cluster=mainnet-beta";
const anchored = (findingId: string, at = IN, signature = "5xYsig", explorerUrl: string | undefined = TX_URL): DigestLedgerEntry => ({ findingId, status: "confirmed", signature, anchoredAt: at, explorerUrl });

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

test("priority 1: a known-planet re-validation sealed on-chain is named, with its period, honestly framed", () => {
  const text = composeDigest(
    input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)] }),
  );
  // The period now carries the grid-limited uncertainty rather than a bare "2.22d": a record with no recorded
  // resolution is published under the conservative bound, which at 2.22 d still resolves to hundredths.
  assert.match(text, /known exoplanet HD 189733 b \(P=2\.22 \+\/- 0\.02 d\)/, "names the known planet + period with its real precision (stable across variants)");
  assert.match(text, /on-chain/);
  assert.match(text, /recovery check/, "frames a re-validation as a recovery check, not a discovery");
  assert.ok(!/discoveryClaim=false/.test(text), "the per-post discoveryClaim stamp is gone");
  assert.match(text, /spacedatarig\.app$/);
  assertTweetSafe(text);
});

test("priority 1: anchored rows that do NOT resolve to a known planet fall back to an honest count", () => {
  const one = composeDigest(input({ ledger: [anchored("f1")], findings: [blind("f1", "TIC 9")] }));
  assert.match(one, /\b1 reproducible\b/);
  assert.match(one, /on-chain/);
  assert.ok(!/\bresults\b/.test(one), "singular for exactly one");

  const many = composeDigest(
    input({ ledger: [anchored("f1"), anchored("f2")], findings: [blind("f1", "TIC 9"), blind("f2", "TIC 10")] }),
  );
  assert.match(many, /\b2 reproducible\b/);
  assert.match(many, /\bresults\b/);
  assert.match(many, /on-chain/);
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
  assert.match(text, /UNCONFIRMED transit candidate|periodic-dip candidate/);
  assert.match(text, /real TESS photometry/); // blind-TOI is contractually recovered on real photometry
  assert.match(text, /for human follow-up/);
  // "P=4.50d" implied hundredths; on the conservative grid bound a 4.5 d period resolves to about a tenth, so the
  // published form now carries that (+/- 0.09) instead of inventing precision.
  assert.match(text, /\(e\.g\. TIC 240720121, P=4\.50 \+\/- 0\.09 d\)/);
  assert.ok(!/discoveryClaim=false/.test(text), "no per-post stamp");
  assert.ok(!/discovered/i.test(text), "must never claim a discovery");
  assertTweetSafe(text);
});

test("priority 2: plural, and the newest candidate is the example", () => {
  const text = composeDigest(
    input({ findings: [blind("f1", "TIC 1", "2026-10-16T10:10:00.000Z"), blind("f2", "TIC 2", "2026-10-16T10:50:00.000Z")] }),
  );
  assert.match(text, /\b2 new\b/, "reports the count of 2");
  assert.match(text, /candidates/);
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
  assert.match(text, /known exoplanet HD 189733 b/);
  assert.ok(!/UNCONFIRMED/.test(text), "the anchored line wins, so no blind text");
});

test("priority 3: a research milestone fires only when research.json landed in the window", () => {
  const research: DigestResearch = { survey: { stars: 204, purity: 0.5315315 } };
  const text = composeDigest(input({ research, researchUpdated: true }));
  assert.match(text, /research/);
  assert.match(text, /characterized on 204 real public TESS-SPOC stars/);
  assert.match(text, /purity LOWER bound is 53%/, "purity is rounded and labelled a LOWER bound");
  assert.match(text, /a genuine but uncatalogued planet is counted against it/);
  assert.match(text, /not discoveries/);
  assert.ok(!/discoveryClaim=false/.test(text), "no per-post stamp");
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

test("lean footnotes: a routine known-planet post drops the standing characterization even when research is rich", () => {
  const text = composeDigest(
    input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)], research: RICH_RESEARCH }),
  );
  assert.match(text, /known exoplanet HD 189733 b \(P=2\.22 \+\/- 0\.02 d\)/);
  assert.match(text, /recovery check/);
  assert.ok(!/separately characterized|completeness rises|purity LOWER bound/.test(text), "the methodology block now lives ONLY on the research milestone, not every result post");
  assert.ok(!/research\.json|results-figure\.svg|p49-blind-test/.test(text), "no methodology links when no such number is cited");
  assert.ok(text.includes(`- On-chain transaction: ${TX_URL}`), "the sealing tx is still the proof that corresponds");
  assert.ok(text.endsWith("- Live rig + full methods: https://spacedatarig.app"));
  // Red line preserved: a known-planet re-validation never claims it ran on real photometry (its photons may be seeded).
  assert.ok(!/real (TESS|public) photometry/.test(text), "a lean result post cites no real-photometry provenance");
  assertTweetSafe(text);
});

test("layout: the long-form digest is multi-line (blank-line-separated blocks + ASCII bullets), never a run-on", () => {
  const text = composeDigest(input({ research: RICH_RESEARCH, researchUpdated: true }));
  assert.ok(text.includes("\n"), "a formatted long-form post contains newlines (clip preserves them)");
  assert.ok(text.includes("\n\n"), "blocks are separated by a blank line");
  assert.ok(text.split("\n\n").length >= 4, "headline + honesty caveat + key numbers + proof blocks");
  assert.match(text, /\n- /, "numbers and proof links are laid out as ASCII '- ' bullet lines");
  assertTweetSafe(text);
});

test("proof links: a research milestone links research.json, the results figure, the P49 blind test, and the live rig", () => {
  const text = composeDigest(input({ research: RICH_RESEARCH, researchUpdated: true }));
  assert.match(text, /\nProof:\n/, "a 'Proof:' block heads the verifiable links");
  assert.ok(text.includes("- Numbers + data (research.json): https://spacedatarig.app/research.json"));
  assert.ok(text.includes("- Completeness & purity figure: https://spacedatarig.app/results-figure.svg"));
  assert.ok(text.includes("- Blind test (recall/precision): https://spacedatarig.app/reports/p49-blind-test.html"));
  assert.ok(text.endsWith("- Live rig + full methods: https://spacedatarig.app"), "the live rig root is the last proof line");
  assert.ok(!/On-chain transaction/.test(text), "a research milestone anchors nothing, so it cites no on-chain tx");
  assertTweetSafe(text);
});

test("proof links: each artifact is linked ONLY when the number it proves is actually cited", () => {
  // stars only -> research.json backs the count, but no completeness/purity figure and no blind-test report.
  const starsOnly = composeDigest(input({ research: { survey: { stars: 120 } }, researchUpdated: true }));
  assert.ok(starsOnly.includes("research.json"), "research.json backs the cited star count");
  assert.ok(!starsOnly.includes("results-figure.svg"), "no completeness/purity cited -> no figure link");
  assert.ok(!starsOnly.includes("p49-blind-test"), "no blind test cited -> no P49 link");

  // completeness but no blind test -> figure yes, P49 no.
  const compOnly = composeDigest(
    input({ research: { survey: { stars: 120, completeness: [{ depthPpm: 300, rate: 0.36 }, { depthPpm: 8000, rate: 0.93 }] } }, researchUpdated: true }),
  );
  assert.ok(compOnly.includes("results-figure.svg"), "completeness cited -> the figure that plots it is linked");
  assert.ok(!compOnly.includes("p49-blind-test"), "no blind test cited -> no P49 link");

  // blind test but no completeness/purity -> P49 yes, figure no.
  const blindOnly = composeDigest(
    input({ research: { survey: { stars: 120 }, blindTest: { recall: 0.77, precision: 0.33 } }, researchUpdated: true }),
  );
  assert.ok(blindOnly.includes("p49-blind-test.html"), "recall/precision cited -> the P49 report is linked");
  assert.ok(!blindOnly.includes("results-figure.svg"), "no completeness/purity cited -> no figure link");

  assertTweetSafe(starsOnly);
  assertTweetSafe(compOnly);
  assertTweetSafe(blindOnly);
});

test("proof links: an on-chain result links its ledger transaction as proof", () => {
  const text = composeDigest(
    input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2185)], research: RICH_RESEARCH }),
  );
  assert.ok(text.includes(`- On-chain transaction: ${TX_URL}`), "the sealed result links its on-chain tx");
  assertTweetSafe(text);
});

test("proof links: a ledger row with no usable explorerUrl omits the tx line (never prints a broken one)", () => {
  // Build the row directly WITHOUT explorerUrl: passing `undefined` to the factory would trigger its TX_URL
  // default (JS default params fire on an explicit undefined), so it would not exercise the missing-url path.
  const noUrlRow: DigestLedgerEntry = { findingId: "f1", status: "confirmed", signature: "5xYsig", anchoredAt: IN };
  const noUrl = composeDigest(input({ ledger: [noUrlRow], findings: [blind("f1", "TIC 9")] }));
  assert.match(noUrl, /\b1 reproducible\b/);
  assert.ok(!/On-chain transaction/.test(noUrl), "no explorerUrl -> no tx link");
  assert.ok(!/explorer\.solana\.com/.test(noUrl));
  assertTweetSafe(noUrl);

  const bad = composeDigest(input({ ledger: [anchored("f1", IN, "5xYsig", "not a url")], findings: [blind("f1", "TIC 9")] }));
  assert.ok(!/On-chain transaction/.test(bad), "a non-https explorerUrl is refused, not printed");
  assertTweetSafe(bad);
});

test("proof links: a blind candidate anchors nothing, so it cites no on-chain tx", () => {
  const text = composeDigest(input({ findings: [blind("f1", "TIC 240720121", IN, 4.5)], research: RICH_RESEARCH }));
  assert.match(text, /UNCONFIRMED transit candidate|periodic-dip candidate/);
  assert.ok(!/On-chain transaction/.test(text), "the blind-candidate path has no on-chain anchor");
  assert.ok(text.endsWith("- Live rig + full methods: https://spacedatarig.app"));
  assertTweetSafe(text);
});

test("lean footnotes: a routine blind post carries no characterization or methodology links", () => {
  const text = composeDigest(input({ findings: [blind("f1", "TIC 240720121", IN, 4.5)], research: RICH_RESEARCH }));
  assert.ok(!/separately characterized|completeness rises|purity LOWER bound/.test(text));
  assert.ok(!/research\.json|results-figure\.svg|p49-blind-test/.test(text), "no methodology links without a cited methodology number");
  assert.match(text, /UNCONFIRMED/);
  assert.match(text, /for human follow-up/);
  assert.ok(text.endsWith("- Live rig + full methods: https://spacedatarig.app"));
  assertTweetSafe(text);
});

test("variety: the composer picks a phrasing deterministically from a stable set (pure, no clock/random)", () => {
  const mk = (seed: string) =>
    composeDigest(input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", `HD ${seed} b`, 2.2185)] }));
  // Same window + same planet -> byte-identical (deterministic / testable).
  assert.equal(mk("1"), mk("1"));
  // Whatever variant the rotation picks, the required facts always survive and the stamp never returns.
  for (const t of [mk("1"), mk("7"), mk("42")]) {
    assert.match(t, /known exoplanet HD .* b \(P=2\.22 \+\/- 0\.02 d\)/);
    assert.match(t, /recovery check/);
    assert.ok(!/discoveryClaim=false/.test(t));
  }
});

test("priority 4 (build note): no science but commits -> a plain dev update over the commits", () => {
  const text = composeDigest(input({ devCommits: [
    "feat(worker): a reliable X-post trigger from the Cloudflare cron",
    "fix(x-post): anchor the digest window to the last actual post",
    "test: cover the last-post reader offline",
  ] }));
  assert.match(text, /Under the hood|build note|machinery/);
  assert.match(text, /- feat\(worker\): a reliable X-post trigger/, "commit subjects become the bullets");
  assert.match(text, /- fix\(x-post\): anchor/);
  assert.match(text, /Repository \(code \+ history\): https:\/\/github\.com\/SpaceDataRig\/space-data-rig/);
  assert.ok(text.endsWith("- Live rig + full methods: https://spacedatarig.app"));
  assert.ok(!/discovery|planet|photometry/i.test(text), "a build note is about the code, not a result");
  assertTweetSafe(text);
});

test("build note: subjects that would break a red line are dropped; a clean one survives", () => {
  const text = composeDigest(input({ devCommits: [
    "fix: reduce the wallet cost",
    "feat: shipped today",
    "ci: run the pipeline test",
  ] }));
  assert.ok(!/wallet|\bcost\b|today/i.test(text), "a subject that would break a red line is never printed");
  assert.match(text, /- ci: run the pipeline test/, "a clean subject survives as a bullet");
  assertTweetSafe(text);
});

test("build note: when every commit breaks a red line, there is no dev post (stays silent)", () => {
  const text = composeDigest(input({ devCommits: ["chore: wallet cost in usd", "feat: worked today"] }));
  assert.equal(text, "", "nothing safe to say -> stays silent (the workflow then tries the heartbeat)");
});

test("priority ordering: science beats a build note, and a build note beats the heartbeat", () => {
  const scienceWins = composeDigest(input({
    ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2)], devCommits: ["feat: build x"],
  }));
  assert.match(scienceWins, /known exoplanet HD 189733 b/);
  assert.ok(!/Under the hood|build note|machinery/.test(scienceWins), "science path chosen, not the dev note");

  const devWins = composeDigest(input({ devCommits: ["feat: build x"], silentMinutes: 500, heartbeatAfterMinutes: 90 }));
  assert.match(devWins, /Under the hood|build note|machinery/);
  assert.ok(!/Space Data Rig status\./.test(devWins), "a buildable commit wins over the status heartbeat");
  assertTweetSafe(devWins);
});

// The dev tier's cursor is read back OFF THE FEED: x-last-post.ts has to recognise a build note among the
// account's recent tweets, or the dev window silently resets to the shared science cursor and the tier starves
// again (the production bug this pins: a five-commit push yielded a build note covering one commit, because every
// science post advanced the single shared cursor past unreported commits). This asserts the two sides still agree.
test("the dev-tier cursor recognises a REAL composed build note, and never a science or heartbeat post", () => {
  // Whatever headline the rotation picks, the composed note must be identifiable as such. The seed is
  // `dev:${windowStart}:${firstSubject}`, so the rotation is driven by varying the SUBJECT -- overriding
  // windowStart instead would trip composeDigest's `end < start` guard and compose nothing at all.
  // (Exhaustive coverage of every headline is asserted in tests/x-last-post.test.ts; here the point is that a
  // REAL composed note, whichever variant it is, round-trips through the matcher.)
  const subjects = [
    "fix(x-post): give the build note its own cursor",
    "feat(worker): a reliable trigger",
    "test: cover the dev cursor offline",
    "ci: batch the commit coverage",
    "refactor(digest): split the two cursors",
  ];
  const seen = new Set<string>();
  for (const subj of subjects) {
    const note = composeDigest(input({ devCommits: [subj] }));
    assert.ok(note.length > 0, `subject "${subj}": expected a build note for this fixture`);
    assert.ok(isBuildNoteText(note), `subject "${subj}": composed build note must be recognisable on the feed, else the dev cursor resets`);
    const head = BUILD_NOTE_HEADLINES.find((h) => note.startsWith(h));
    assert.ok(head, `subject "${subj}": the note must open with a headline from the single-source list`);
    seen.add(head as string);
  }
  assert.ok(seen.size >= 2, `the rotation should vary across these seeds, saw only ${seen.size} distinct headline(s)`);

  const science = composeDigest(input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "HD 189733 b", 2.2)] }));
  assert.ok(science.length > 0);
  assert.ok(!isBuildNoteText(science), "a science post must not be mistaken for a build note or the dev window jumps forward");

  const hb = composeDigest(input({ heartbeatAfterMinutes: 45, silentMinutes: 60, research: RICH_RESEARCH }));
  assert.ok(hb.length > 0);
  assert.ok(!isBuildNoteText(hb), "a heartbeat must not be mistaken for a build note either");

  const blindPost = composeDigest(input({ findings: [blind("b1", "TIC 123", IN, 3.3)] }));
  assert.ok(blindPost.length > 0);
  assert.ok(!isBuildNoteText(blindPost), "a blind-candidate post must not be mistaken for a build note either");
});

// ---- silence heartbeat (the documented FALLBACK when nothing new is reportable but the channel has gone quiet) ---

test("heartbeat: fires only when silent >= threshold AND nothing new; states the honest situation", () => {
  const t = composeDigest(input({ research: RICH_RESEARCH, silentMinutes: 200, heartbeatAfterMinutes: 90 }));
  assert.match(t, /Space Data Rig status\./);
  assert.match(t, /running on its own against public NASA TESS/);
  assert.match(t, /nothing newly sealed on-chain or newly flagged/);
  assert.match(t, /characterization on 204 real public TESS-SPOC stars/);
  assert.match(t, /no UNCONFIRMED blind candidate/);
  assert.match(t, /No analysis has been sealed on-chain yet\./);
  assert.match(t, /spacedatarig\.app$/);
  assert.ok(t.split("\n\n").length >= 3, "head + situation body + proof block");
  assert.ok(!/On-chain transaction/.test(t), "a heartbeat seals nothing, so it cites no tx");
  assertTweetSafe(t);
});

test("heartbeat: suppressed below the threshold, when the gap is unknown, and when disabled (0/absent)", () => {
  assert.equal(composeDigest(input({ silentMinutes: 30, heartbeatAfterMinutes: 90 })), "", "under threshold -> stays silent");
  assert.equal(composeDigest(input({ heartbeatAfterMinutes: 90 })), "", "no gap supplied -> stays silent");
  assert.equal(composeDigest(input({ silentMinutes: 999 })), "", "no threshold supplied -> heartbeat disabled");
  assert.equal(composeDigest(input({ silentMinutes: 999, heartbeatAfterMinutes: 0 })), "", "threshold 0 -> disabled");
});

test("heartbeat: reports catalog counts and does NOT reuse the out-of-window science tiers", () => {
  const t = composeDigest(input({
    findings: [blind("b1", "TIC 1", BEFORE), blind("b2", "TIC 2", BEFORE)],
    ledger: [anchored("a1", BEFORE)],
    silentMinutes: 100,
    heartbeatAfterMinutes: 90,
  }));
  assert.ok(!/flagged .* UNCONFIRMED transit candidate/.test(t), "blind rows OUTSIDE the window must not trigger the science tier");
  assert.ok(!/re-verified|reproducible/.test(t), "an anchored row outside the window must not trigger priority 1");
  assert.match(t, /records 2 UNCONFIRMED blind candidates/);
  assert.match(t, /1 analysis result has been sealed on-chain so far/);
  assertTweetSafe(t);
});

test("heartbeat: a real new result always wins -- a huge silence does not force a status post", () => {
  const t = composeDigest(input({
    ledger: [anchored("f1")],
    findings: [knownPlanet("f1", "HD 189733 b", 2.2185)],
    silentMinutes: 100000,
    heartbeatAfterMinutes: 90,
  }));
  assert.match(t, /known exoplanet HD 189733 b/);
  assert.ok(!/Space Data Rig status\./.test(t), "the science path is chosen, not the heartbeat");
  assertTweetSafe(t);
});

// ---- output-level over-claim net (audit-6 #2) --------------------------------
// The per-post "discoveryClaim=false" stamp was removed, so this asserts the FINAL composed text carries no
// affirmative over-claim across EVERY tier, and that the hedge-aware net still fires on the accidental template
// edit it exists to catch (a bare discover/confirm/first with no negation nearby).

test("no tier's final composed text trips the over-claim net (honest negations pass, affirmatives would not)", () => {
  const tierOutputs: Record<string, string> = {
    anchoredKnown: composeDigest(input({ ledger: [anchored("f1")], findings: [knownPlanet("f1", "Kepler-1647 b", 4.2)] })),
    anchoredGeneric: composeDigest(input({ ledger: [anchored("f2")] })),
    blindCandidates: composeDigest(input({ findings: [blind("b1", "TIC 123", IN, 3.3)] })),
    milestone: composeDigest(input({ researchUpdated: true, research: RICH_RESEARCH })),
    buildNote: composeDigest(input({ devCommits: ["fix(p86): refuse stale reports on publish"] })),
    heartbeat: composeDigest(input({ heartbeatAfterMinutes: 45, silentMinutes: 60, research: RICH_RESEARCH, findings: [blind("b2", "TIC 5", IN)] })),
  };
  for (const [tier, text] of Object.entries(tierOutputs)) {
    assert.ok(text.length > 0, `${tier}: expected non-empty composed text for this fixture`);
    assert.deepEqual(overclaimViolations(text), [], `${tier}: composed output must contain no affirmative over-claim`);
  }
});

test("the over-claim net FIRES on an accidental affirmative template edit", () => {
  const bad = "Space Data Rig discovered a new planet and confirms a first detection of it.";
  const hits = overclaimViolations(bad).join(" | ").toLowerCase();
  assert.match(hits, /discover/, "'discovered' in an un-hedged sentence must be flagged");
  assert.match(hits, /confirm/, "'confirms' must be flagged");
  assert.match(hits, /first/, "'first' must be flagged");
});

test("the over-claim net treats the composer's honest negations as safe (not false positives)", () => {
  assert.deepEqual(overclaimViolations("This is not a claimed discovery."), []);
  assert.deepEqual(overclaimViolations("These figures are independent cross-checks, not discoveries."), []);
  assert.deepEqual(overclaimViolations("The catalog records 3 UNCONFIRMED candidates, rather than a confirmed planet."), []);
});

// ---- the tier selector: ONE window may now yield SEVERAL posts -------------------------------
// The one-post-per-window cap was a spam guard that ended up RATIONING the feed: a window that both sealed a
// result and landed commits reported only the result, and the build-note tier was reachable only when the science
// tiers were empty. composeDigest now takes `only`, so the workflow composes each tier separately and posts every
// non-empty result. The default (absent) MUST keep the historical first-match-wins behavior -- that is what every
// test above relies on.

// A window that qualifies for EVERY tier at once, so isolation is observable.
const RICH = () =>
  input({
    ledger: [anchored("f1")],
    findings: [knownPlanet("f1", "HD 189733 b", 2.2), blind("b1", "TIC 123", IN, 3.3)],
    research: RICH_RESEARCH,
    researchUpdated: true,
    devCommits: ["fix(digest): compose every tier in a window"],
    silentMinutes: 500,
    heartbeatAfterMinutes: 90,
  });

test("the default (no `only`) is unchanged: the first tier with something wins and exactly one post comes back", () => {
  const dflt = composeDigest(RICH());
  assert.ok(dflt.length > 0);
  assert.match(dflt, /HD 189733 b/, "the on-chain known-planet re-validation still outranks every other tier");
  assert.ok(!dflt.includes("fix(digest)"), "and the default still returns ONE post, not a concatenation");
});

test("`only` isolates a single tier, so a window that qualifies for several posts all of them", () => {
  const led = composeDigest({ ...RICH(), only: "ledger" });
  const bl = composeDigest({ ...RICH(), only: "blind" });
  const ms = composeDigest({ ...RICH(), only: "milestone" });
  const bn = composeDigest({ ...RICH(), only: "build-note" });
  const hb = composeDigest({ ...RICH(), only: "heartbeat" });
  assert.match(led, /HD 189733 b/, "ledger tier");
  assert.match(bl, /UNCONFIRMED/, "blind tier");
  assert.ok(!bl.includes("HD 189733 b"), "the blind tier must not also carry the ledger post");
  // Not the headline -- pick() rotates it -- but the standing characterization, which ONLY this tier carries.
  assert.match(ms, /characterized on/, "milestone tier");
  assert.ok(isBuildNoteText(bn), "build-note tier");
  assert.match(hb, /^Space Data Rig status\./, "heartbeat tier");
  const all = [led, bl, ms, bn, hb];
  for (const t of all) assertTweetSafe(t);
  assert.equal(new Set(all).size, all.length, "five tiers must produce five DISTINCT posts, not the same one five times");
});

test("`only: science` covers the three science tiers and still picks the highest-priority one", () => {
  assert.equal(composeDigest({ ...RICH(), only: "science" }), composeDigest({ ...RICH(), only: "ledger" }));
  const noLedger = { ...RICH(), ledger: [], only: "science" };
  assert.match(composeDigest(noLedger), /UNCONFIRMED/, "with no anchored result the blind candidate is the science post");
});

test("a tier with nothing to report composes an empty string rather than falling through to another tier", () => {
  // Falling through would silently re-introduce the old suppression: asking for the build note must never return a
  // science post, or the workflow would post the same item twice under two filenames.
  assert.equal(composeDigest({ ...RICH(), ledger: [], findings: [], only: "ledger" }), "");
  assert.equal(composeDigest({ ...RICH(), findings: [], only: "blind" }), "");
  assert.equal(composeDigest({ ...RICH(), researchUpdated: false, only: "milestone" }), "");
  assert.equal(composeDigest({ ...RICH(), devCommits: [], only: "build-note" }), "");
  assert.equal(composeDigest({ ...RICH(), silentMinutes: 1, only: "heartbeat" }), "", "below the silence threshold");
  const scienceOnly = composeDigest({ ...RICH(), ledger: [], findings: [], researchUpdated: false, only: "science" });
  assert.equal(scienceOnly, "", "`science` must not leak the build note or the heartbeat");
});

// ---- the build note is no longer truncated to a fixed handful ---------------------------------

test("a build note carries EVERY subject it is given, not just the first five", () => {
  const subjects = Array.from({ length: 20 }, (_, i) => `fix(area${i}): change number ${i}`);
  const note = composeDigest(input({ devCommits: subjects, only: "build-note" }));
  assertTweetSafe(note);
  for (const s of subjects) assert.ok(note.includes(s), `subject dropped from the note: ${s}`);
  assert.equal(note.split("\n").filter((l) => /^- fix\(area\d+\)/.test(l)).length, subjects.length);
});

test("DEV_BULLETS_MAX is a safety net above the workflow's batch size, so the net never bites", () => {
  // The workflow splits the backlog into chunks of DEV_BATCH and posts one note per chunk. If DEV_BATCH ever grew
  // past DEV_BULLETS_MAX the slice would silently drop the tail of a chunk -- exactly the truncation this replaces.
  const yml = readFileSync(new URL("../.github/workflows/x-post.yml", import.meta.url), "utf8");
  const m = yml.match(/^\s*DEV_BATCH:\s*"(\d+)"\s*$/m);
  assert.ok(m, "the workflow must declare a DEV_BATCH default");
  const batch = Number(m?.[1]);
  assert.ok(batch > 0 && batch <= DEV_BULLETS_MAX, `DEV_BATCH ${batch} must be in (0, DEV_BULLETS_MAX=${DEV_BULLETS_MAX}]`);
  const over = Array.from({ length: DEV_BULLETS_MAX + 5 }, (_, i) => `fix(a${i}): c${i}`);
  const note = composeDigest(input({ devCommits: over, only: "build-note" }));
  assert.equal(
    note.split("\n").filter((l) => /^- fix\(a\d+\)/.test(l)).length,
    DEV_BULLETS_MAX,
    "an unbatched list is capped by the net (the workflow batches below it, so this never fires in production)",
  );
  assert.ok(note.length <= 25000, "the net exists to keep the post inside X's long-form ceiling");
});

// ---- the workflow must not re-introduce a ration ---------------------------------------------
// These are string assertions on CI-only shell, which no unit test executes. They are deliberately blunt: each one
// is a limit that demonstrably dropped reportable work, and if it comes back the reason should be a decision, not
// an unnoticed edit.

test("the workflow posts every composed item: no one-post cap, no five-commit truncation, no docs filter", () => {
  const yml = readFileSync(new URL("../.github/workflows/x-post.yml", import.meta.url), "utf8");
  assert.ok(!/head -5/.test(yml), "`head -5` truncated the commit backlog to five and dropped the rest");
  assert.ok(!/\^\(chore\|docs\?\)/.test(yml), "the old subject filter dropped every docs: commit");
  assert.ok(!/if \[ ! -s out\/digest\.txt \]/.test(yml), "the old suppression made the build note reachable only when the science tier was empty");
  assert.ok(/--only build-note/.test(yml), "the build note must be composed on its own, not as a fallthrough");
  assert.ok(/for f in \$QUEUED/.test(yml), "there must be a loop that posts every composed item");
  assert.ok(/MAX_POSTS_PER_RUN/.test(yml), "a runaway ceiling stays (it protects the feed; it is not a ration)");
  const cap = Number(yml.match(/^\s*MAX_POSTS_PER_RUN:\s*"(\d+)"\s*$/m)?.[1]);
  assert.ok(Number.isFinite(cap) && cap >= 10, `the runaway ceiling must stay generous, got ${cap}`);
  assert.ok(/DEV_COMMIT_EXCLUDE/.test(yml), "subject filtering is configurable now, not hardcoded");
});

// ---- a build note must always be POSTABLE, or the un-rationed loop stalls forever ------------------
// post-x-text.ts runs overclaimViolations over the FINAL text and REFUSES on a hit, exiting non-zero; the workflow's
// posting loop breaks on failure so the build-note cursor cannot advance past an unsent item. Each decision is
// correct alone. Together they mean one unpostable subject would poison its whole batch permanently: every window
// re-composes the same note, is refused, and the backlog never clears -- the starvation this change was meant to end,
// reintroduced through the honesty guard. So the composer drops any subject that would make the note unpostable,
// and `rejectedDevSubjects` exists so main() can SAY which ones and why instead of dropping them quietly.

test("a subject carrying an affirmative over-claim is dropped, so the note post-x-text.ts sees is postable", () => {
  const subjects = [
    "feat(p17): first-light FFI feasibility",
    "docs: a novel approach to vetoes",
    "fix(p23): confirm the candidate list",
    "ci: run the pipeline test",
  ];
  const text = composeDigest(input({ devCommits: subjects, only: "build-note" }));
  assert.deepEqual(overclaimViolations(text), [], "the composed note must never be refused downstream");
  assert.match(text, /- ci: run the pipeline test/, "a clean subject still survives alongside the dropped ones");
  for (const banned of ["first-light", "novel", "confirm the candidate"]) {
    assert.ok(!text.includes(banned), `"${banned}" must not reach the feed`);
  }
  assertTweetSafe(text);
});

test("a HEDGED subject is KEPT: the drop targets affirmative wording, not the vocabulary itself", () => {
  const subject = "fix(p57): do not confirm a candidate from one sector";
  const text = composeDigest(input({ devCommits: [subject], only: "build-note" }));
  assert.match(text, /- fix\(p57\): do not confirm a candidate from one sector/, "a negated sentence is honest, not a claim");
  assert.deepEqual(overclaimViolations(text), []);
  assert.deepEqual(rejectedDevSubjects([subject]), [], "and so it is not reported as a rejection");
});

test("every rejection carries a reason, including the known hyphenated false positive, so nothing vanishes silently", () => {
  const rejected = rejectedDevSubjects([
    "ci: run the pipeline test",
    "fix(x-post): batch the backlog oldest-first",
    "chore: reduce the wallet cost",
    "feat: shipped today",
    "",
  ]);
  assert.equal(rejected.length, 3, "the clean subject and the blank line are not rejections");
  assert.ok(
    rejected.some((r) => r.subject.includes("oldest-first") && /over-claim/.test(r.reason)),
    "\\bfirst\\b matches inside a hyphenated 'oldest-first'; it is dropped AND the log says so",
  );
  assert.ok(rejected.some((r) => /spend\/key/.test(r.reason)), "the spend/key drop names its reason");
  assert.ok(rejected.some((r) => /time-implying/.test(r.reason)), "the time-word drop names its reason");
  assert.ok(!rejected.some((r) => r.subject === "ci: run the pipeline test"), "a postable subject is never reported");
});

test("INVARIANT: no combination of commit subjects can compose a note the posting guard would refuse", () => {
  // Every over-claim stem the guard knows, plus the red-line vocabulary, plus two realistic clean subjects so the
  // note is non-empty and the assertion is about content rather than about silence.
  const hostile = [
    "feat: the first automated veto",
    "docs: novel candidates",
    "fix: confirm every orbit",
    "chore: unprecedented depth",
    "refactor: landmark rewrite",
    "test: historic run",
    "feat: discover new signals",
    "ci: batch oldest-first",
    "fix: wallet cost",
    "docs: shipped today",
    "chore(deps): bump undici from 6.19.2 to 6.20.0",
    "feat(p89): multi-epoch PSF diff-imaging veto harness (real 2x2 over labelled KP / FP-EB)",
  ];
  const text = composeDigest(input({ devCommits: hostile, only: "build-note" }));
  assert.ok(text.length > 0, "the two clean subjects must still produce a note");
  assert.deepEqual(overclaimViolations(text), [], "a refused note would stall the cursor and starve every later batch");
  assert.match(text, /- chore\(deps\): bump undici from 6\.19\.2 to 6\.20\.0/, "a long realistic subject survives intact (the workflow may exclude it by env; the composer does not)");
  assertTweetSafe(text);
});
