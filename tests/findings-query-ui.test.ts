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
  QUERY_PAGE,
} from "../web/findings-query-ui.js";
import { parseFindingQuery, queryFindings } from "../src/core/finding-query.ts";
import type { Finding } from "../src/core/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(resolve(root, "web", "app.js"), "utf8");

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

test("resultMeta states the honest scope, and the load-more cue tracks hasMore", () => {
  // Even when a filter matched every row, the sentence reports the two counts -- it never claims "(no filter)",
  // which would be ambiguous (an empty query and an all-matching filter both give matched===total).
  assert.equal(
    resultMeta({ total: 103, matched: 103, hasMore: true }, 24),
    "Server matched 103 of 103 catalog rows - showing 24, load more for older",
  );
  assert.equal(
    resultMeta({ total: 103, matched: 7, hasMore: false }, 7),
    "Server matched 7 of 103 catalog rows - showing all 7",
  );
  assert.ok(!/no filter/i.test(resultMeta({ total: 8, matched: 8, hasMore: false }, 8)), "never prints a misleading 'no filter'");
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

// The plots lazy-load guard, found broken in browser QA: data-loaded="0" (string) is truthy, so the old
// `!plots.dataset.loaded` never fired and NEITHER the static SVGs NOR the v0.2 P2 live fold rendered on a real
// click. Pin the corrected comparison and forbid the regression back to the truthy-string test.
test("plots lazy-load guard compares data-loaded to '1' (a truthy '0' string must not block the fill)", () => {
  assert.match(APP, /if \(willOpen && plots\.dataset\.loaded !== "1"\) \{/, "the fill branch must gate on the loaded FLAG, not the truthiness of the '0' string");
  assert.doesNotMatch(APP, /if \(willOpen && !plots\.dataset\.loaded\)/, "the old truthy-string guard must not return");
  assert.match(APP, /plots\.innerHTML = \(f \? foldPlotHtml\(f\) : ""\) \+ plotsHtml\(id\);/, "the open handler prepends the live fold before the static SVGs");
});

