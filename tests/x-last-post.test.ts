// x-last-post regression tests -- pure, offline (no network: the script's entry guard keeps main() from running
// on import, and these only exercise the exported predicates). They exist because this read SHIPPED BROKEN: it
// requested max_results=1, which X API v2 rejects with HTTP 400 (legal range 5..100), so the silence watchdog
// silently never fired. These pin exactly that class of bug -- the request shape and the newest-timestamp pick --
// as behavior assertions on realistic payload fixtures, not "the function exists" string checks.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pct, tweetsQuery, userIdFromMe, newestCreatedAt } from "../scripts/x-last-post.ts";

// ---- the shipped bug: an illegal page size ----

test("tweetsQuery uses a max_results v2 actually accepts (guards the HTTP-400 regression)", () => {
  const q = tweetsQuery();
  const n = Number(q.max_results);
  assert.ok(Number.isInteger(n) && n >= 5 && n <= 100, `max_results ${q.max_results} must be an integer in [5,100]`);
  assert.notEqual(q.max_results, "1", "max_results=1 was the bug: v2 rejects it with HTTP 400");
  assert.equal(q["tweet.fields"], "created_at", "created_at is the only field the silence gap is derived from");
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
