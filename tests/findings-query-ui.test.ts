// v0.2 P0b: the browser query console assembles its request in web/findings-query-ui.js. Following the audit-4
// lesson (a browser behaviour proven only by string-matching app.js can ship wrong on real data), these are
// BEHAVIOUR tests on the pure builder, PLUS a parity test that feeds the builder's exact output into the REAL
// server-side parser (src/core/finding-query.ts, the code both worker.ts and server.ts route /api/findings
// through). If a parameter name the browser emits ever drifts from a name the server reads, this fails offline --
// long before a reader with a 100+-row catalog notices their filter silently did nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildFindingsParams,
  findingsQueryPath,
  resultMeta,
  hasConstraints,
  isHarmonicAlias,
  dedupeById,
  applyFindingsPage,
  applyFailedPage,
  QUERY_PAGE,
} from "../web/findings-query-ui.js";
import { parseFindingQuery, queryFindings } from "../src/core/finding-query.ts";
import type { Finding } from "../src/core/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(resolve(root, "web", "app.js"), "utf8");
const LIVE_MANIFESTS = JSON.parse(readFileSync(resolve(root, "tests", "fixtures", "live-manifests.json"), "utf8"));

// ---- the pure builder ------------------------------------------------------

test("an empty form still pages: exactly limit + offset, nothing else", () => {
  const p = buildFindingsParams({}, 0);
  assert.deepEqual(p, { limit: String(QUERY_PAGE), offset: "0" });
});

test("empty text/select fields are omitted, never sent blank", () => {
  const p = buildFindingsParams({ verdict: "", origin: "  ", q: "", tic: "", sort: "", dir: "" }, 0);
  assert.deepEqual(p, { limit: String(QUERY_PAGE), offset: "0" }, "whitespace collapses to 'not set'");
});

test("text values are trimmed and forwarded under the server's key names", () => {
  const p = buildFindingsParams({ q: "  wasp-121 b  ", tic: " 111 ", verdict: "accepted", origin: "blind-toi" }, 0);
  assert.equal(p.q, "wasp-121 b");
  assert.equal(p.tic, "111");
  assert.equal(p.verdict, "accepted");
  assert.equal(p.origin, "blind-toi");
});

test("numeric axes are sent only when finite; a stray word drops just that axis", () => {
  const good = buildFindingsParams({ periodMin: "1.5", periodMax: "9", depthMin: "800", depthMax: "2000", snrMin: "20" }, 0);
  assert.equal(good.periodMin, "1.5");
  assert.equal(good.periodMax, "9");
  assert.equal(good.depthMin, "800");
  assert.equal(good.depthMax, "2000");
  assert.equal(good.snrMin, "20");
  const dirty = buildFindingsParams({ periodMin: "abc", snrMin: "   ", depthMax: "1000" }, 0);
  assert.equal(dirty.periodMin, undefined, "'abc' is dropped, not trusted");
  assert.equal(dirty.snrMin, undefined, "blank numeric is not sent");
  assert.equal(dirty.depthMax, "1000", "the one clean axis survives a dirty sibling");
});

test("offset is floored to a non-negative integer", () => {
  assert.equal(buildFindingsParams({}, -5).offset, "0");
  assert.equal(buildFindingsParams({}, NaN).offset, "0");
  assert.equal(buildFindingsParams({}, 48.7).offset, "48");
});

test("the path is deterministic (keys sorted) and URL-encodes free text", () => {
  const path = findingsQueryPath(buildFindingsParams({ q: "hello world&x=1", verdict: "accepted" }, 24));
  assert.ok(path.startsWith("/api/findings?"), path);
  assert.ok(path.includes("q=hello+world%26x%3D1") || path.includes("q=hello%20world"), "free text is encoded");
  const keys = path.slice(path.indexOf("?") + 1).split("&").map((kv) => kv.split("=")[0]);
  assert.deepEqual(keys, [...keys].sort(), "keys are emitted in sorted order so the same form yields the same URL");
});

test("hasConstraints ignores the always-sent paging", () => {
  assert.equal(hasConstraints({}), false, "limit+offset alone is not a constraint");
  assert.equal(hasConstraints({ verdict: "accepted" }), true);
});

test("resultMeta: a filtered query reports matched-of-total; the cue tracks hasMore", () => {
  assert.equal(
    resultMeta({ total: 103, matched: 103, hasMore: true }, 24, { filtered: true }),
    "Server matched 103 of 103 catalog rows - showing 24, load more for older",
  );
  assert.equal(
    resultMeta({ total: 103, matched: 7, hasMore: false }, 7, { filtered: true }),
    "Server matched 7 of 103 catalog rows - all 7 shown",
  );
});

test("resultMeta: 'no filter' is decided by the FORM (hasConstraints), never by matched===total", () => {
  // audit-13 P2-5: an empty query and an all-matching filter both give matched===total, so the phrase can only be
  // trusted when it is driven by what the reader actually typed. With filtered:false it says "Full catalog";
  // with a filter that kept every row it still says "matched ... of ...", never falsely claiming no filter ran.
  assert.equal(resultMeta({ total: 8, matched: 8, hasMore: false }, 8, { filtered: false }), "Full catalog: 8 rows - all 8 shown");
  const allMatch = resultMeta({ total: 8, matched: 8, hasMore: false }, 8, { filtered: true });
  assert.match(allMatch, /matched 8 of 8/, "a filter catching every row is reported as a match, not 'no filter'");
  assert.ok(!/no filter|full catalog/i.test(allMatch), "a filtered view must never read as unfiltered");
});

test("resultMeta: the load-more cue names the active sort, only saying 'older' under recent", () => {
  // audit-13 P2-4: a catalog sorted by depth/snr/TIC pages in that key's order, so "load more for older" would
  // falsely imply time ordering. The default recent sort keeps the familiar wording.
  assert.equal(
    resultMeta({ total: 103, matched: 103, hasMore: true }, 24, { sort: "depth", filtered: true }),
    "Server matched 103 of 103 catalog rows - showing 24, load more for the next by depth",
  );
  assert.match(resultMeta({ total: 5, matched: 5, hasMore: true }, 3, { sort: "recent", filtered: true }), /load more for older$/);
});

test("isHarmonicAlias: only a resolved alias (finite multiple != 1) is an alias", () => {
  // audit-13 P1-1: aliasMultiple===1 means "BLS period was already correct" (src/detect/pipeline.ts, review.ts
  // odd-even pass), so x1 cards have NO alias to report and must not be stamped "harmonic alias x1".
  assert.equal(isHarmonicAlias({ aliasMultiple: 1 }), false, "x1 = clean period, not an alias");
  assert.equal(isHarmonicAlias({ aliasMultiple: 2 }), true, "x2 = a real resolved alias");
  assert.equal(isHarmonicAlias({ aliasMultiple: 0.5 }), true, "a submultiple is an alias too");
  assert.equal(isHarmonicAlias({ aliasMultiple: "3" }), true, "a numeric string is coerced");
  assert.equal(isHarmonicAlias({}), false, "missing aliasMultiple is not an alias");
  assert.equal(isHarmonicAlias({ aliasMultiple: null }), false);
  assert.equal(isHarmonicAlias({ aliasMultiple: NaN }), false, "a non-finite value cannot be an alias");
  assert.equal(isHarmonicAlias({ aliasMultiple: "abc" }), false, "a non-numeric value is not an alias");
  assert.equal(isHarmonicAlias(null), false);
});

test("dedupeById: keeps the first occurrence per id, leaves unkeyed rows untouched", () => {
  // audit-13 P2-6: the same finding can land on two consecutive pages when the catalog shifts between requests.
  const rows = [{ id: "a" }, { id: "b" }, { id: "a", stale: true }, { id: "c" }, { id: "b" }];
  assert.deepEqual(dedupeById(rows).map((r) => r.id), ["a", "b", "c"]);
  assert.equal(dedupeById(rows)[0], rows[0], "the FIRST copy is kept, not the re-send");
  assert.deepEqual(dedupeById([]), []);
  assert.equal(dedupeById(undefined as unknown as unknown[]).length, 0, "a non-array degrades to empty, never throws");
});

test("LIVE DATA: the 3 real sealed manifests are clean periods, so none is a harmonic alias", () => {
  // audit-13 P1-1, driven by production fixtures (the audit-4 lesson: prove a predicate on REAL data, not a string).
  const bundles = LIVE_MANIFESTS.bundles as Array<{ findingId: string; manifest: { aliasMultiple: number } }>;
  assert.ok(bundles.length >= 1, "the live fixture must carry at least one sealed bundle");
  for (const b of bundles) {
    assert.equal(b.manifest.aliasMultiple, 1, `${b.findingId} is stored as a clean x1 period`);
    assert.equal(isHarmonicAlias(b.manifest), false, `${b.findingId} must NOT be flagged as a harmonic alias`);
  }
});


// ---- PARITY: the builder's output is a query the server actually parses ----

function f(p: Partial<Finding> & { targetId: string; periodDays: number; depthFrac: number; snr: number }): Finding {
  return {
    id: p.id ?? p.targetId,
    targetId: p.targetId,
    verdict: p.verdict ?? "needs-more-data",
    verdictReason: p.verdictReason ?? "",
    crossmatch: p.crossmatch ?? { matchedKnownPlanet: false },
    origin: p.origin,
    score: p.score,
    createdAt: p.createdAt ?? "2026-01-01T00:00:00Z",
    candidate: { targetId: p.targetId, periodDays: p.periodDays, depthFrac: p.depthFrac, snr: p.snr } as Finding["candidate"],
  } as Finding;
}

const rows: Finding[] = [
  f({ id: "a", targetId: "TIC 111", periodDays: 1.2, depthFrac: 0.001, snr: 15, createdAt: "2026-01-05T00:00:00Z" }),
  f({ id: "b", targetId: "TIC 222", periodDays: 3.4, depthFrac: 0.005, snr: 40, verdict: "accepted", origin: "revalidation", score: 88, createdAt: "2026-01-09T00:00:00Z", crossmatch: { matchedKnownPlanet: true, knownPlanetName: "WASP-121 b" } }),
  f({ id: "c", targetId: "TIC 333", periodDays: 8.0, depthFrac: 0.0008, snr: 9, verdict: "rejected", origin: "blind-toi", score: 12, createdAt: "2026-01-07T00:00:00Z" }),
  f({ id: "d", targetId: "KIC 444", periodDays: 2.0, depthFrac: 0.002, snr: 22, origin: "blind-toi", verdictReason: "shallow bump, needs follow-up", createdAt: "2026-01-02T00:00:00Z" }),
];

// Every axis the panel exposes, run as browser->server would: the SAME params the UI emits, parsed by the
// server's parseFindingQuery, then applied by queryFindings. A key-name mismatch would silently return all rows.
test("PARITY: browser params round-trip through the server parser and filter as intended", () => {
  const cases: Array<[Record<string, string>, string[]]> = [
    [{ verdict: "accepted" }, ["b"]],
    [{ origin: "blind-toi" }, ["c", "d"]],
    [{ tic: "222" }, ["b"]],
    [{ q: "follow-up" }, ["d"]],
    [{ periodMin: "3", periodMax: "9" }, ["b", "c"]],
    [{ depthMin: "800", depthMax: "2000" }, ["a", "c", "d"]],
    [{ snrMin: "20" }, ["b", "d"]],
  ];
  for (const [form, want] of cases) {
    const parsed = parseFindingQuery(buildFindingsParams(form, 0));
    const got = queryFindings(rows, parsed).rows.map((x) => x.id).sort();
    assert.deepEqual(got, want, `form ${JSON.stringify(form)} -> expected ${want}, got ${got}`);
    // paging must engage: the builder always sends limit, so the server reports it honoured a page size
    assert.equal(parsed.limit, QUERY_PAGE, "the emitted limit is what the server parses");
  }
});

test("PARITY: sort=depth + dir=asc from the panel reaches the server's ordering", () => {
  const parsed = parseFindingQuery(buildFindingsParams({ sort: "depth", dir: "asc" }, 0));
  assert.deepEqual(queryFindings(rows, parsed).rows.map((x) => x.id), ["c", "a", "d", "b"]);
});

// ---- structural: the builder is WIRED into the render path, not just defined ----

test("app.js wires the query console into the board (imports the builder, branches renderBoard, reads the form)", () => {
  assert.match(APP, /import \{[^}]*\bbuildFindingsParams\b[^}]*\bfindingsQueryPath\b[^}]*\bresultMeta\b[^}]*\} from "\/findings-query-ui\.js"/, "app.js must import the shared builder");
  assert.match(APP, /if \(findingsQuery\.active\) return renderQueryBoard\(\);/, "renderBoard must branch to the server-query view");
  assert.match(APP, /await fetchJSON\(findingsQueryPath\(params\)\)/, "the console must fetch the built /api/findings path");
  assert.match(APP, /buildFindingsParams\(findingsQuery\.form, offset\)/, "and page with offset through the builder");
});

// ---- audit-14 N4: the console's state transitions are BEHAVIOUR-tested, not string-matched ----
// audit-13 proved the race/merge/clear logic by regex-matching app.js source -- the audit-4 anti-pattern this
// module's own header forbids. That logic now lives in the pure applyFindingsPage / applyFailedPage, so these tests
// feed REAL response envelopes and assert the resulting rows/counts. A response that would mis-merge, double a row,
// or strand stale cards after a failure now fails offline, on the exact function the browser runs.

test("applyFindingsPage: a fresh query (offset 0) REPLACES the rows, taking counts from the server envelope", () => {
  const state = { rows: [{ id: "old" }] };
  const res = { findings: [{ id: "a" }, { id: "b" }], total: 103, matched: 7, hasMore: true };
  assert.deepEqual(applyFindingsPage(state, res, 0), { rows: [{ id: "a" }, { id: "b" }], total: 103, matched: 7, hasMore: true });
});

test("applyFindingsPage: 'load more' (offset > 0) APPENDS and de-duplicates a row the catalog shifted onto both pages", () => {
  const state = { rows: [{ id: "a" }, { id: "b" }] };
  const res = { findings: [{ id: "b", stale: true }, { id: "c" }], total: 103, matched: 3, hasMore: false };
  const next = applyFindingsPage(state, res, 2);
  assert.deepEqual(next.rows.map((r) => r.id), ["a", "b", "c"], "the b from the first page is kept, the re-sent b dropped");
  assert.equal(next.rows[1], state.rows[1], "the FIRST occurrence survives, not the duplicate");
  assert.equal(next.matched, 3);
  assert.equal(next.hasMore, false);
});

test("applyFindingsPage: absent or dirty counts fall back to what the rows actually show, never to a lie", () => {
  const next = applyFindingsPage({ rows: [] }, { findings: [{ id: "x" }, { id: "y" }] }, 0);
  assert.equal(next.total, 2, "no res.total => the rows seen");
  assert.equal(next.matched, 2, "no res.matched => the total");
  assert.equal(next.hasMore, false, "absent hasMore reads false");
});

test("applyFailedPage: a dead FRESH query clears to an honest empty state; a dead load-more keeps what is on screen", () => {
  const shown = { rows: [{ id: "a" }, { id: "b" }], total: 103, matched: 40, hasMore: true };
  assert.deepEqual(applyFailedPage(shown, 0), { rows: [], total: 0, matched: 0, hasMore: false }, "fresh failure clears");
  assert.deepEqual(applyFailedPage(shown, 2), shown, "a failed next-page must NOT discard rows the reader already saw");
});

// ---- wiring: the browser must actually CALL those tested functions (glue a behaviour test cannot reach) ----

// audit-13/14 wiring: the fixes must be WIRED into app.js, not just defined in the pure module. The merge/clear
// LOGIC is behaviour-tested above; here we only assert the call sites and the one genuinely browser-timing guard
// (the monotonic token), which cannot be extracted into a pure function.
test("app.js wires the console fixes: alias gating, race token, the tested reducers, hasConstraints/opts", () => {
  assert.match(APP, /import \{[^}]*\bhasConstraints\b[^}]*\bisHarmonicAlias\b[^}]*\bapplyFindingsPage\b[^}]*\bapplyFailedPage\b[^}]*\} from "\/findings-query-ui\.js"/, "app.js must import the pure predicates and reducers");
  // P1-1: the Evidence alias note is gated on isHarmonicAlias, never the old `aliasMultiple != null` that stamped x1.
  assert.match(APP, /const alias = isHarmonicAlias\(m\) \?/, "evidenceHtml must gate the alias note on the predicate");
  assert.doesNotMatch(APP, /const alias = m\.aliasMultiple != null/, "the old always-stamp-x1 gate must not return");
  // P2-3: a monotonic token identifies the newest request; a superseded page is dropped before the reducer mutates.
  assert.match(APP, /const token = \+\+findingsQuery\.token;/, "fetchFindingsPage must mint a request token");
  assert.match(APP, /if \(token !== findingsQuery\.token\) return;[\s\S]*?applyFindingsPage\(findingsQuery, res, offset\)/, "a stale response must be dropped before the merge reducer runs");
  // P2-3 failure path now delegates the clear/keep decision to the behaviour-tested reducer.
  assert.match(APP, /applyFailedPage\(findingsQuery, offset\)/, "the failure path must call the tested reducer, not inline logic");
  // P2-4/P2-5: resultMeta is fed the form-derived filtered flag and the active sort, not the ambiguous count.
  assert.match(APP, /filtered: hasConstraints\(findingsQuery\.form\)/, "resultMeta filtered flag must come from hasConstraints(form)");
  assert.match(APP, /sort: \(findingsQuery\.form && findingsQuery\.form\.sort\) \|\| "recent"/, "resultMeta must know the active sort");
});


// The plots lazy-load guard, found broken in browser QA: data-loaded="0" (string) is truthy, so the old
// `!plots.dataset.loaded` never fired and NEITHER the static SVGs NOR the v0.2 P2 live fold rendered on a real
// click. Pin the corrected comparison and forbid the regression back to the truthy-string test.
test("plots lazy-load guard compares data-loaded to '1' (a truthy '0' string must not block the fill)", () => {
  assert.match(APP, /if \(willOpen && plots\.dataset\.loaded !== "1"\) \{/, "the fill branch must gate on the loaded FLAG, not the truthiness of the '0' string");
  assert.doesNotMatch(APP, /if \(willOpen && !plots\.dataset\.loaded\)/, "the old truthy-string guard must not return");
  assert.match(APP, /plots\.innerHTML = \(f \? foldPlotHtml\(f\) : ""\) \+ plotsHtml\(id\);/, "the open handler prepends the live fold before the static SVGs");
});

