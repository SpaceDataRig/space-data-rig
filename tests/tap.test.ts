// Offline tests for the NASA Exoplanet Archive TAP client's autonomous selection:
// the pscomppars `tic_id` string must lift into the numeric `tic` that the
// token-free TESS-SPOC S3 tier depends on, and `requireTic` must add the
// TIC-presence clause to the query. fetch is mocked, so no network is required.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";

test("fetchConfirmedPlanets lifts tic_id string into numeric tic and normalizes depth", async () => {
  const captured: { url?: string } = {};
  const rows = [
    { pl_name: "HD 221416 b", hostname: "HD 221416", tic_id: "TIC 441462736", ra: 353.03, dec: -21.8, pl_orbper: 3.9, st_rad: 1.3, pl_rade: 10, pl_trandep: 0.9, sy_tmag: 7.36, discoverymethod: "Transit" },
    { pl_name: "No TIC b", hostname: "No TIC", ra: 1, dec: 1, pl_orbper: 2, st_rad: 1, pl_rade: 5, pl_trandep: 0.5, sy_tmag: 8.0, discoverymethod: "Transit" },
  ];
  globalThis.fetch = (async (url: string) => {
    captured.url = url;
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as never;
  const r = await fetchConfirmedPlanets({ maxTmag: 11, limit: 10 });
  assert.equal(r.source, "nasa-tap");
  const withTic = r.planets.find((p) => p.hostname === "HD 221416");
  assert.equal(withTic?.tic, 441462736, "tic_id string should parse to a number");
  const noTic = r.planets.find((p) => p.hostname === "No TIC");
  assert.equal(noTic?.tic, undefined, "a missing tic_id must not fabricate a tic");
  // depth normalized percent -> ppm (0.9% -> 9000ppm)
  assert.ok(Math.abs((withTic?.pl_trandep ?? 0) - 9000) < 1e-6);
});

test("fetchConfirmedPlanets filters to TIC-bearing rows client-side (never via SQL is-not-null)", async () => {
  const urls: string[] = [];
  const rows = [
    { pl_name: "A b", hostname: "A", tic_id: "TIC 1", pl_orbper: 2, st_rad: 1, pl_rade: 5, sy_tmag: 8, discoverymethod: "Transit" },
    { pl_name: "B b", hostname: "B", pl_orbper: 3, st_rad: 1, pl_rade: 5, sy_tmag: 9, discoverymethod: "Transit" },
  ];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as never;
  const plain = await fetchConfirmedPlanets({ limit: 5 });
  const ticOnly = await fetchConfirmedPlanets({ limit: 5, requireTic: true });
  // the WAF rejects an SQL `is not null`; the clause must never appear in the query
  assert.equal(decodeURIComponent(urls[1]).includes("tic_id is not null"), false, "must not add an SQL is-not-null clause");
  assert.equal(plain.planets.length, 2, "default keeps every row");
  assert.equal(ticOnly.planets.length, 1, "requireTic keeps only the TIC-bearing row");
  assert.equal(ticOnly.planets[0].hostname, "A");
});

// ---- deterministic publication order (audit-6 follow-up) -------------------------------------------

test("fetchConfirmedPlanets order is a pure function of content, not of the order TAP returned rows in", async () => {
  // REGRESSION. Every planet of one host shares sy_tmag, so sorting by magnitude alone tied them ALL;
  // Array#sort is stable, so the tie order was whatever the archive happened to send, and the query carries
  // no ORDER BY. p60 consequently published HR 858 c/d and HD 25463 b/c swapped between two runs over an
  // unchanged catalog. That byte churn is not cosmetic: other reports record the sha256 of these files as
  // their inputs, so a reordered-but-identical report invalidated those stamps and made the
  // report-freshness gate flap stale on data that had not changed.
  const host = (name: string, period: number) => ({
    pl_name: name, hostname: "HR 858", tic_id: "TIC 1", ra: 1, dec: 1,
    pl_orbper: period, st_rad: 1, pl_rade: 5, sy_tmag: 7.14, discoverymethod: "Transit",
  });
  const fainter = { pl_name: "Fainter b", hostname: "Fainter", tic_id: "TIC 2", ra: 2, dec: 2, pl_orbper: 4, st_rad: 1, pl_rade: 5, sy_tmag: 9.5, discoverymethod: "Transit" };
  const brighter = { pl_name: "Brighter b", hostname: "Brighter", tic_id: "TIC 3", ra: 3, dec: 3, pl_orbper: 5, st_rad: 1, pl_rade: 5, sy_tmag: 5.0, discoverymethod: "Transit" };

  const namesFrom = async (rows: unknown[]): Promise<(string | undefined)[]> => {
    globalThis.fetch = (async () => new Response(JSON.stringify(rows), { status: 200 })) as never;
    const r = await fetchConfirmedPlanets({ limit: 50 });
    return r.planets.map((p) => p.pl_name);
  };

  const a = await namesFrom([host("HR 858 d", 11.230511), host("HR 858 c", 5.973865), fainter, brighter]);
  const b = await namesFrom([brighter, fainter, host("HR 858 c", 5.973865), host("HR 858 d", 11.230511)]);
  assert.deepEqual(a, b, "the same rows must publish in the same order whichever way TAP returned them");
  // magnitude still dominates, and same-magnitude ties break on pl_name
  assert.deepEqual(a, ["Brighter b", "HR 858 c", "HR 858 d", "Fainter b"]);
});

test("fetchConfirmedPlanets breaks an identical pl_name tie on orbital period, so the order is total", async () => {
  const dup = (period: number) => ({
    pl_name: "dup", hostname: "H", tic_id: "TIC 9", ra: 1, dec: 1,
    pl_orbper: period, st_rad: 1, pl_rade: 5, sy_tmag: 6, discoverymethod: "Transit",
  });
  globalThis.fetch = (async () => new Response(JSON.stringify([dup(9), dup(3), dup(6)]), { status: 200 })) as never;
  const r = await fetchConfirmedPlanets({ limit: 10 });
  assert.deepEqual(r.planets.map((p) => p.pl_orbper), [3, 6, 9]);
});
