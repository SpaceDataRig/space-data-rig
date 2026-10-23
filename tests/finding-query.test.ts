// v0.2 P0: the findings query is a pure projection, so it is testable offline on hand-built rows.
// The load-bearing assertions are (a) an EMPTY query returns the list UNCHANGED -- a committed figure reads
// /api/findings with no params and needs the whole catalog in the store's own order -- and (b) filter/sort/page
// engage only when a caller asks. Nothing here runs a detector or touches a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFindingQuery, queryFindings, depthPpmOf, ignoredFindingParams, clampedFindingParams, MAX_LIMIT } from "../src/core/finding-query.ts";
import type { Finding } from "../src/core/types.ts";

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
    candidate: {
      targetId: p.targetId,
      periodDays: p.periodDays,
      depthFrac: p.depthFrac,
      snr: p.snr,
    } as Finding["candidate"],
  } as Finding;
}

const rows: Finding[] = [
  f({ id: "a", targetId: "TIC 111", periodDays: 1.2, depthFrac: 0.001, snr: 15, createdAt: "2026-01-05T00:00:00Z" }),
  f({ id: "b", targetId: "TIC 222", periodDays: 3.4, depthFrac: 0.005, snr: 40, verdict: "accepted", origin: "revalidation", score: 88, createdAt: "2026-01-09T00:00:00Z", crossmatch: { matchedKnownPlanet: true, knownPlanetName: "WASP-121 b" } }),
  f({ id: "c", targetId: "TIC 333", periodDays: 8.0, depthFrac: 0.0008, snr: 9, verdict: "rejected", origin: "blind-toi", score: 12, createdAt: "2026-01-07T00:00:00Z" }),
  f({ id: "d", targetId: "KIC 444", periodDays: 2.0, depthFrac: 0.002, snr: 22, origin: "blind-toi", verdictReason: "shallow bump, needs follow-up", createdAt: "2026-01-02T00:00:00Z" }),
];

test("empty query returns the whole catalog in the store's own order (backward-compat for the figure reader)", () => {
  const r = queryFindings(rows, {});
  assert.deepEqual(r.rows.map((x) => x.id), ["a", "b", "c", "d"], "order preserved, nothing reordered");
  assert.equal(r.rows.length, 4);
  assert.equal(r.hasMore, false);
});

test("verdict and origin filters", () => {
  assert.deepEqual(queryFindings(rows, { verdict: "accepted" }).rows.map((x) => x.id), ["b"]);
  assert.deepEqual(queryFindings(rows, { verdict: "rejected" }).rows.map((x) => x.id), ["c"]);
  assert.deepEqual(queryFindings(rows, { origin: "blind-toi" }).rows.map((x) => x.id), ["c", "d"]);
  // a pre-rotation row with absent origin reads as revalidation (so both b, explicit, and a, absent, match);
  // default sort is recent desc, and b (01-09) is newer than a (01-05).
  const onlyReval = queryFindings(rows, { origin: "revalidation" }).rows.map((x) => x.id);
  assert.deepEqual(onlyReval, ["b", "a"]);
});

test("period, depth-ppm and snr ranges filter on the real candidate fields", () => {
  assert.deepEqual(queryFindings(rows, { periodMax: 2 }).rows.map((x) => x.id), ["a", "d"]);
  assert.deepEqual(queryFindings(rows, { periodMin: 3, periodMax: 9 }).rows.map((x) => x.id), ["b", "c"], "recent desc: b(01-09) then c(01-07)");
  // depth 800-2000 ppm: a=1000, d=2000, c=800; b=5000 excluded
  assert.deepEqual(queryFindings(rows, { depthMinPpm: 800, depthMaxPpm: 2000 }).rows.map((x) => x.id).sort(), ["a", "c", "d"]);
  assert.deepEqual(queryFindings(rows, { snrMin: 20 }).rows.map((x) => x.id), ["b", "d"]);
});

test("tic substring and free-text q reach the known-planet name and the verdict reason", () => {
  assert.deepEqual(queryFindings(rows, { tic: "222" }).rows.map((x) => x.id), ["b"]);
  assert.deepEqual(queryFindings(rows, { q: "wasp-121" }).rows.map((x) => x.id), ["b"]);
  assert.deepEqual(queryFindings(rows, { q: "follow-up" }).rows.map((x) => x.id), ["d"]);
});

test("sort engages with a constraint and defaults to newest-first; dir flips it", () => {
  const recent = queryFindings(rows, { limit: 50 }).rows.map((x) => x.id);
  assert.deepEqual(recent, ["b", "c", "a", "d"], "recent desc: 01-09,01-07,01-05,01-02");
  const byDepth = queryFindings(rows, { sort: "depth", limit: 50 }).rows.map((x) => x.id);
  assert.deepEqual(byDepth, ["b", "d", "a", "c"], "depth desc: 5000,2000,1000,800");
  const periodAsc = queryFindings(rows, { sort: "period", dir: "asc", limit: 50 }).rows.map((x) => x.id);
  assert.deepEqual(periodAsc, ["a", "d", "b", "c"], "period ascending");
});

test("limit and offset page with an honest hasMore", () => {
  const p1 = queryFindings(rows, { limit: 2, offset: 0, sort: "depth" });
  assert.deepEqual(p1.rows.map((x) => x.id), ["b", "d"]);
  assert.equal(p1.matched, 4);
  assert.equal(p1.hasMore, true);
  const p2 = queryFindings(rows, { limit: 2, offset: 2, sort: "depth" });
  assert.deepEqual(p2.rows.map((x) => x.id), ["a", "c"]);
  assert.equal(p2.hasMore, false);
});

test("parseFindingQuery clamps and drops dirty values; depthPpmOf matches the served view", () => {
  assert.equal(depthPpmOf(rows[1]), 5000);
  const q = parseFindingQuery({ verdict: "nonsense", origin: "blind-toi", limit: "99999", offset: "-5", periodMin: "abc", snrMin: "30", sort: "depth", dir: "up" });
  assert.equal(q.verdict, undefined, "unrecognised verdict dropped");
  assert.equal(q.origin, "blind-toi");
  assert.equal(q.limit, MAX_LIMIT, "limit clamped to the ceiling");
  assert.equal(q.offset, 0, "negative offset floored to zero");
  assert.equal(q.periodMin, undefined, "non-numeric ignored");
  assert.equal(q.snrMin, 30);
  assert.equal(q.sort, "depth");
  assert.equal(q.dir, undefined, "unrecognised dir dropped (sort default handles it)");
});

// ---- audit-14 N1: unrecognized-but-supplied params are echoed, never silently applied or silently dropped ----

test("ignoredFindingParams reports exactly the supplied-but-untrusted keys, mirroring parse's drop rules", () => {
  assert.deepEqual(ignoredFindingParams({}), [], "no params, nothing ignored");
  assert.deepEqual(ignoredFindingParams({ verdict: "accepted", origin: "blind-toi", sort: "depth", dir: "asc", limit: "24" }), [], "all-valid query ignores nothing");
  assert.deepEqual(ignoredFindingParams({ verdict: "accesped" }), ["verdict"], "a typo verdict is reported, not silently trusted");
  assert.deepEqual(ignoredFindingParams({ origin: "  " }), [], "whitespace-only is 'not supplied', not 'ignored'");
  // every vocabulary axis + a numeric axis, all bad at once -- the report is the full set the endpoint did not apply
  assert.deepEqual(
    ignoredFindingParams({ verdict: "x", origin: "y", sort: "z", dir: "up", periodMin: "abc", snrMin: "nope", limit: "many" }).sort(),
    ["dir", "limit", "origin", "periodMin", "snrMin", "sort", "verdict"],
  );
  // the SAME key is echoed only when its value actually failed; a valid sibling stays silent
  assert.deepEqual(ignoredFindingParams({ verdict: "rejected", periodMin: "1.5", snrMin: "bad" }), ["snrMin"]);
});

test("N1: an untrusted verdict still returns the whole catalog AND says so (no silent all-match)", () => {
  // parse drops it (empty-query identity preserved) ...
  const q = parseFindingQuery({ verdict: "notavalue" });
  assert.equal(q.verdict, undefined);
  const r = queryFindings(rows, q);
  assert.deepEqual(r.rows.map((x) => x.id), ["a", "b", "c", "d"], "rows unchanged by the transparency fix");
  // ... but the handler's ignored echo (driven by the same pure fn) flags the dead criterion.
  assert.deepEqual(ignoredFindingParams({ verdict: "notavalue" }), ["verdict"]);
});

// ---- audit-14 N2: `tic` is an identifier, so a numeric query matches a whole digit run, not a loose substring ----

test("tic matches a whole numeric identifier run, never an incidental substring", () => {
  const hosts: Finding[] = [
    f({ id: "h1", targetId: "TIC 222", periodDays: 1, depthFrac: 0.001, snr: 10 }),
    f({ id: "h2", targetId: "TIC 2228", periodDays: 1, depthFrac: 0.001, snr: 10 }), // h1's digits are a substring of h2
    f({ id: "h3", targetId: "S2221", periodDays: 1, depthFrac: 0.001, snr: 10 }),   // "222" is buried inside 2221
    f({ id: "h4", targetId: "TOI-6265.01", periodDays: 1, depthFrac: 0.001, snr: 10 }),
  ];
  assert.deepEqual(queryFindings(hosts, { tic: "222" }).rows.map((x) => x.id), ["h1"], "tic=222 must NOT sweep in 2228 or S2221");
  assert.deepEqual(queryFindings(hosts, { tic: "2228" }).rows.map((x) => x.id), ["h2"], "the full run matches");
  assert.deepEqual(queryFindings(hosts, { tic: "6265" }).rows.map((x) => x.id), ["h4"], "the TIC digit inside TOI-6265.01");
  assert.deepEqual(queryFindings(hosts, { tic: "62" }).rows.map((x) => x.id), [], "a partial digit prefix is not an identifier");
  // a spaced / alphabetic query keeps the contains behaviour (no digit-run semantics to apply)
  assert.deepEqual(queryFindings(hosts, { tic: "tic 222" }).rows.map((x) => x.id), ["h1", "h2"], "non-numeric stays case-insensitive contains");
});

// ---- audit-15 T1: the round-14 digit-run fix still split a TOI cadence suffix (.01) into a "run" -- the fixture it
// was checked against (TOI-6265.01) only ever exercised the HOST direction. Pin BOTH directions + zero-padding. ----

test("tic is the HOST number: a TESS cadence suffix is never a match, and leading zeros normalize", () => {
  const ids: Finding[] = [
    f({ id: "t1", targetId: "TOI-1821.01", periodDays: 1, depthFrac: 0.001, snr: 10 }),
    f({ id: "t2", targetId: "TOI-2026.01", periodDays: 1, depthFrac: 0.001, snr: 10 }),
    f({ id: "t3", targetId: "TOI-4641.02", periodDays: 1, depthFrac: 0.001, snr: 10 }),
    f({ id: "t4", targetId: "TOI-858.01", periodDays: 1, depthFrac: 0.001, snr: 10 }),
  ];
  assert.deepEqual(queryFindings(ids, { tic: "01" }).rows.map((x) => x.id), [], "tic=01 must NOT match the .01 cadence suffix (live regression: 53/103)");
  assert.deepEqual(queryFindings(ids, { tic: "02" }).rows.map((x) => x.id), [], "tic=02 must NOT match the .02 cadence suffix");
  assert.deepEqual(queryFindings(ids, { tic: "1821" }).rows.map((x) => x.id), ["t1"], "the host number matches");
  assert.deepEqual(queryFindings(ids, { tic: "0858" }).rows.map((x) => x.id), ["t4"], "zero-padded tic=0858 must find host 858 (numeric compare, live was 0)");
});

// ---- audit-15 T2/T4: `dir` is a real criterion, not an inert one ----

test("dir alone engages the query (sort + page) and defaults to desc when no direction is given", () => {
  // dir was in the parser's vocabulary but absent from queryFindings' `active` set, so `?dir=asc` alone dumped the
  // whole catalog UNSORTED with `ignored:[]` -- the exact silent no-op N1 was meant to end, on a VALID value.
  const asc = queryFindings(rows, { dir: "asc" });
  assert.deepEqual(asc.rows.map((x) => x.id), ["d", "a", "c", "b"], "dir=asc engages the default recent sort ASCENDING (d 01-02 .. b 01-09)");
  assert.deepEqual(ignoredFindingParams({ dir: "asc" }), [], "a valid dir is not ignored -- now it genuinely has effect");
  // T4: the collapsed ternary keeps the DESC default when NO direction is supplied
  assert.deepEqual(queryFindings(rows, { sort: "recent" }).rows.map((x) => x.id), ["b", "c", "a", "d"], "default recent DESC, newest first -- unchanged");
});

// ---- audit-15 T3: a CLAMPED paging value is echoed, distinct from a DROPPED one ----

test("clampedFindingParams reports a bounded paging value without conflating it with an ignored drop", () => {
  assert.deepEqual(clampedFindingParams({ limit: "0" }, parseFindingQuery({ limit: "0" })), ["limit"], "limit=0 -> 1 is a clamp and must be said");
  assert.deepEqual(clampedFindingParams({ limit: "-5" }, parseFindingQuery({ limit: "-5" })), ["limit"], "negative floored to 1");
  assert.deepEqual(clampedFindingParams({ limit: "99999" }, parseFindingQuery({ limit: "99999" })), ["limit"], "over MAX_LIMIT is clamped");
  assert.deepEqual(clampedFindingParams({ offset: "-3" }, parseFindingQuery({ offset: "-3" })), ["offset"], "negative offset floored to 0");
  assert.deepEqual(clampedFindingParams({ limit: "24" }, parseFindingQuery({ limit: "24" })), [], "in-band limit is untouched");
  assert.deepEqual(clampedFindingParams({ limit: "many" }, parseFindingQuery({ limit: "many" })), [], "non-numeric is DROPPED -> ignored's job, not clamped's");
});

// audit-16 secondary #5 names this for what it is: a STRUCTURAL wiring check, not a behavioural parity test. The
// echo LOGIC lives in the shared src/core (ignored/clampedFindingParams) and is behaviourally tested above; what can
// diverge per surface is only whether a handler WIRES the shared result into its response, which is what this asserts.
// (Both handlers are then exercised END-TO-END against the deployed edge by the live verification step, not here.)
test("audit-15 wiring (structural): BOTH /api/findings handlers echo ignored AND clamped", () => {
  const worker = readFileSync(resolve(process.cwd(), "src", "cf", "worker.ts"), "utf8");
  const node = readFileSync(resolve(process.cwd(), "src", "api", "server.ts"), "utf8");
  for (const [name, src] of [["worker.ts", worker], ["server.ts", node]] as const) {
    assert.match(src, /ignoredFindingParams\(raw\)/, `${name} computes the ignored echo`);
    assert.match(src, /clampedFindingParams\(raw, q\)/, `${name} computes the clamped echo`);
    assert.match(src, /ignored, clamped/, `${name} places both in the response`);
  }
});

