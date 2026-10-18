// x-last-post regression tests -- pure, offline (no network: the script's entry guard keeps main() from running
// on import, and these only exercise the exported predicates). They exist because this read SHIPPED BROKEN: it
// requested max_results=1, which X API v2 rejects with HTTP 400 (legal range 5..100), so the silence watchdog
// silently never fired. These pin exactly that class of bug -- the request shape and the newest-timestamp pick --
// as behavior assertions on realistic payload fixtures, not "the function exists" string checks.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pct, tweetsQuery, userIdFromMe, newestCreatedAt, isBuildNoteText, newestBuildNoteAt } from "../scripts/x-last-post.ts";
import { BUILD_NOTE_HEADLINES } from "../scripts/science-digest.ts";

// ---- the shipped bug: an illegal page size ----

test("tweetsQuery uses a max_results v2 actually accepts (guards the HTTP-400 regression)", () => {
  const q = tweetsQuery();
  const n = Number(q.max_results);
  assert.ok(Number.isInteger(n) && n >= 5 && n <= 100, `max_results ${q.max_results} must be an integer in [5,100]`);
  assert.notEqual(q.max_results, "1", "max_results=1 was the bug: v2 rejects it with HTTP 400");
  const fields = String(q["tweet.fields"]).split(",");
  assert.ok(fields.includes("created_at"), "created_at is what both the silence gap and the dev cursor are derived from");
  assert.ok(fields.includes("text"), "recognising a BUILD NOTE among recent tweets needs the tweet text, not just its time");
  assert.ok(n >= 50, "a build note is rare on this feed; a small page would never contain one and the dev cursor would silently reset to the shared science cursor, re-starving the tier");
});

// ---- the dev-tier cursor: finding our own BUILD NOTE among recent tweets ----

test("isBuildNoteText matches by headline MEMBERSHIP, not one hardcoded string", () => {
  // composeDigest rotates the headline with pick(), so equality against a single string would break on rotation.
  assert.ok(BUILD_NOTE_HEADLINES.length >= 2, "the rotation is why membership (not equality) is the right test");
  for (const h of BUILD_NOTE_HEADLINES) {
    assert.ok(isBuildNoteText(h), `a headline composeDigest can emit must be recognised: ${h}`);
    assert.ok(isBuildNoteText(`  ${h}\n- fix(x): a bullet`), "leading whitespace and a following body must not break the match");
  }
  assert.ok(!isBuildNoteText(""), "empty is not a build note");
  assert.ok(!isBuildNoteText(null), "absent text is not a build note");
  assert.ok(!isBuildNoteText("Space Data Rig surfaced 3 new UNCONFIRMED transit candidates."), "a science post is not a build note");
  assert.ok(!isBuildNoteText("Space Data Rig status."), "a heartbeat is not a build note");
});

test("newestBuildNoteAt picks the newest note and differs from newestCreatedAt (the two cursors must not collapse)", () => {
  // A realistic page: science posts and a heartbeat interleaved with two build notes, out of order.
  const rows = [
    { id: "1", created_at: "2026-10-17T19:00:33.000Z", text: "A new pass by Space Data Rig reproduced the known exoplanet KELT-9 b (P=1.48d); the analysis is sealed on-chain." },
    { id: "2", created_at: "2026-10-17T16:37:02.000Z", text: "Changes to the machinery behind Space Data Rig:\n- fix(freshness): stop counting a timestamp as verification" },
    { id: "3", created_at: "2026-10-17T17:30:40.000Z", text: "Space Data Rig status." },
    { id: "4", created_at: "2026-10-15T02:00:00.000Z", text: "Under the hood, what changed in how Space Data Rig runs:\n- feat(worker): a reliable trigger" },
  ];
  assert.equal(newestBuildNoteAt(rows), "2026-10-17T16:37:02.000Z", "the newest NOTE, not the newest tweet of any kind");
  assert.equal(newestCreatedAt(rows), "2026-10-17T19:00:33.000Z");
  assert.notEqual(
    newestBuildNoteAt(rows),
    newestCreatedAt(rows),
    "if these collapse, the dev tier is back on the shared cursor that starved it",
  );
});

test("newestBuildNoteAt degrades to empty string so the workflow uses its bounded look-back", () => {
  assert.equal(newestBuildNoteAt([]), "");
  assert.equal(newestBuildNoteAt(undefined), "");
  assert.equal(newestBuildNoteAt(null), "");
  assert.equal(newestBuildNoteAt([{ id: "5", created_at: "2026-10-17T10:00:00.000Z" }]), "", "a row with no text is not a build note");
  assert.equal(
    newestBuildNoteAt([{ id: "6", text: "Changes to the machinery behind Space Data Rig:" }]),
    "",
    "a note with no created_at must not produce a bogus cursor",
  );
});

// ---- newest-timestamp selection, driven by realistic v2 fixtures ----

test("newestCreatedAt returns the most-recent created_at even when the page is out of order", () => {
  // A GET /2/users/:id/tweets data array (newest usually first, but never assume it).
  const page = [
    { id: "3", created_at: "2026-10-17T05:46:45.000Z" },
    { id: "1", created_at: "2026-10-16T04:50:18.000Z" },
    { id: "2", created_at: "2026-10-17T05:47:19.000Z" },
  ];
  assert.equal(newestCreatedAt(page), "2026-10-17T05:47:19.000Z");
});

test("newestCreatedAt degrades to empty string (read unavailable) for no / malformed rows", () => {
  assert.equal(newestCreatedAt([]), "");
  assert.equal(newestCreatedAt(undefined), "");
  assert.equal(newestCreatedAt(null), "");
  assert.equal(newestCreatedAt([{ id: "9" }]), "", "a row without created_at must not produce a bogus timestamp");
});

// ---- the user id shape from /2/users/me ----

test("userIdFromMe reads the id from a real /2/users/me payload and misses cleanly", () => {
  assert.equal(userIdFromMe({ data: { id: "150286483" } }), "150286483");
  assert.equal(userIdFromMe({}), "", "no data -> empty, which the caller treats as an unavailable read");
  assert.equal(userIdFromMe(null), "");
});

// ---- RFC-3986 percent-encoding that the OAuth1 base string depends on ----

test("pct implements RFC-3986: space->%20, marks escaped, unreserved left alone", () => {
  assert.equal(pct("hello world"), "hello%20world");
  assert.equal(pct("!*'()"), "%21%2A%27%28%29", "OAuth escapes the marks encodeURIComponent leaves");
  assert.equal(pct("a-zA-Z0.9_-~"), "a-zA-Z0.9_-~", "unreserved chars are not touched");
  assert.equal(pct("tweet.fields"), "tweet.fields", "dot is unreserved, so the query key signs unchanged");
  assert.equal(pct("2026-10-17T05:46:45Z"), "2026-10-17T05%3A46%3A45Z", "colons must be %3A in the signature base");
});
