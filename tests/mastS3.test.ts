// Offline tests for the token-free TESS-SPOC S3 light-curve client.
// Key construction is pure and checked against a real verified example; the
// network paths use a mocked fetch so no download (or a MAST/AWS account) is
// needed. The one test that exercises real FITS bytes runs only when the cached
// product is present (npm run p0:mast), so fresh clones and CI stay green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  formatTic16,
  spocTargetDir,
  resolveSpocKey,
  spocObjectUrl,
  sectorsForCoord,
  fetchSpocBytes,
  fetchSpocLightCurve,
  createSpocSectorFetcher,
} from "../src/data/mastS3.ts";

const CACHE = "out/probe-lc.fits"; // TIC 25155310, sector 0004, PDCSAP 2-min
const have = existsSync(CACHE);

// ---- deterministic key construction (pure, no network) ----

test("formatTic16 zero-pads to 16 digits and rejects bad input", () => {
  assert.equal(formatTic16(1024880), "0000000001024880");
  assert.equal(formatTic16(25155310), "0000000025155310");
  assert.throws(() => formatTic16(NaN), /bad TIC/);
});

test("spocTargetDir shards the padded TIC into four 4-digit groups", () => {
  assert.equal(spocTargetDir(1024880), "0000/0000/0102/4880");
  assert.equal(spocTargetDir(25155310), "0000/0000/2515/5310");
});

test("resolveSpocKey reproduces the verified sector-4 light-curve key", () => {
  assert.equal(
    resolveSpocKey(1024880, 4),
    "mast/hlsp/tess-spoc/s0004/target/0000/0000/0102/4880/hlsp_tess-spoc_tess_phot_0000000001024880-s0004_tess_v1_lc.fits",
  );
  // the target-pixel sibling differs only by the trailing token
  assert.equal(resolveSpocKey(1024880, 4, "tp").endsWith("_tess_v1_tp.fits"), true);
});

test("spocObjectUrl prefixes the unsigned bucket host", () => {
  assert.equal(spocObjectUrl("mast/hlsp/tess-spoc/a.fits"), "https://stpubdata.s3.amazonaws.com/mast/hlsp/tess-spoc/a.fits");
});

// ---- sector lookup (mocked fetch) ----

test("sectorsForCoord extracts, dedups and sorts sector values from nested JSON", async () => {
  const body = JSON.stringify({ code: 200, data: { sessions: [{ sector: "87" }, { sector: 6 }, { nested: [{ sector: 33 }, { sector: 6 }] }] } });
  const lc = await sectorsForCoord(96.7977, -3.76, { fetchImpl: (async () => new Response(body, { status: 200 })) as never });
  assert.deepEqual(lc, [6, 33, 87]);
});

test("sectorsForCoord rejects non-finite coordinates", async () => {
  await assert.rejects(() => sectorsForCoord(NaN, 0), /bad coordinates/);
});

test("sectorsForCoord returns [] on a non-2xx response", async () => {
  const lc = await sectorsForCoord(10, 10, { fetchImpl: (async () => new Response("nope", { status: 500 })) as never });
  assert.deepEqual(lc, []);
});

// ---- object download (mocked fetch) ----

test("fetchSpocBytes returns null for a 404 (target not in the SPOC program)", async () => {
  const key = resolveSpocKey(999999, 1);
  const bytes = await fetchSpocBytes(key, { fetchImpl: (async () => new Response("Not Found", { status: 404 })) as never });
  assert.equal(bytes, null);
});

test("fetchSpocBytes returns null for a non-FITS body (login wall / error page)", async () => {
  const bytes = await fetchSpocBytes("k", { fetchImpl: (async () => new Response("<html>not fits</html>", { status: 200 })) as never });
  assert.equal(bytes, null);
});

test("fetchSpocBytes memoises by key when given a shared byteCache (audit-4 P1: one star, several catalog rows)", async () => {
  const key = resolveSpocKey(25155310, 4);
  // A body that passes the download guard: >= 2880 bytes and the FITS "SIMPLE" magic in the first six bytes.
  const fits = new Uint8Array(2880);
  fits.set(new TextEncoder().encode("SIMPLE"), 0);
  let calls = 0;
  const mockFetch = (async () => {
    calls++;
    return new Response(fits, { status: 200 });
  }) as never;

  const cache = new Map<string, Promise<Uint8Array | null>>();
  const a = await fetchSpocBytes(key, { fetchImpl: mockFetch, byteCache: cache });
  const b = await fetchSpocBytes(key, { fetchImpl: mockFetch, byteCache: cache });
  assert.ok(a && b, "both calls resolve the bytes");
  assert.equal(calls, 1, "a shared byteCache downloads the immutable object ONCE for the whole group");

  // Without a cache the same two calls hit the network twice -- proving the cache is what dedups, and that
  // existing callers (who pass no byteCache) keep the old behaviour byte-for-byte.
  const before = calls;
  await fetchSpocBytes(key, { fetchImpl: mockFetch });
  await fetchSpocBytes(key, { fetchImpl: mockFetch });
  assert.equal(calls, before + 2, "no cache => no dedup");
});

test("fetchSpocLightCurve falls through to null when every sector 404s", async () => {
  const lc = await fetchSpocLightCurve(12345, [1, 2, 3], "TIC 12345", {
    fetchImpl: (async () => new Response("Not Found", { status: 404 })) as never,
  });
  assert.equal(lc, null);
});

test(
  "fetchSpocLightCurve parses real SPOC bytes and labels them REAL photometry",
  { skip: have ? false : "no cached product; run npm run p0:mast" },
  async () => {
    const fits = readFileSync(CACHE);
    const lc = await fetchSpocLightCurve(25155310, [4], "TIC 25155310", {
      fetchImpl: (async () => new Response(new Uint8Array(fits), { status: 200 })) as never,
    });
    assert.ok(lc, "expected a light curve");
    assert.equal(lc!.mission, "TESS");
    assert.ok(lc!.points.length > 1000, `expected >1k points, got ${lc!.points.length}`);
    // the critic truthSource discriminator matches this exact uppercase marker
    assert.equal(lc!.source!.includes("REAL photometry"), true);
    assert.equal(lc!.source!.includes("Caldwell et al. 2020"), true);
  },
);

test(
  "fetchSpocLightCurve serves several rows on ONE star from a single download, each with its OWN label (audit-4 P1)",
  { skip: have ? false : "no cached product; run npm run p0:mast" },
  async () => {
    const fits = readFileSync(CACHE);
    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      return new Response(new Uint8Array(fits), { status: 200 });
    }) as never;
    const cache = new Map<string, Promise<Uint8Array | null>>();

    // HR 858 b/c/d are three catalog rows on ONE TIC: identical immutable bytes, three distinct labels.
    const b = await fetchSpocLightCurve(25155310, [4], "HR 858 b", { fetchImpl: mockFetch, byteCache: cache });
    const c = await fetchSpocLightCurve(25155310, [4], "HR 858 c", { fetchImpl: mockFetch, byteCache: cache });
    assert.equal(calls, 1, "the shared byteCache downloads the FITS once for the whole group");
    assert.ok(b && c, "both rows resolve a light curve");
    // The label is applied AFTER the cache read, per row -- so caching bytes cannot contaminate targetId.
    assert.equal(b!.targetId, "HR 858 b");
    assert.equal(c!.targetId, "HR 858 c");
    // ...and the photometry is identical, so points/dataHash do not depend on how many times we fetched.
    assert.equal(b!.points.length, c!.points.length);
    assert.deepEqual(b!.points.slice(0, 3), c!.points.slice(0, 3));
  },
);

// ---- first-class multi-sector fetch helper (additive; parallel + per-key byte cache) ----

test("createSpocSectorFetcher.fetchSectors returns [] and never throws when every sector 404s", async () => {
  const f = createSpocSectorFetcher({ fetchImpl: (async () => new Response("Not Found", { status: 404 })) as never });
  const curves = await f.fetchSectors(12345, [1, 2, 3], "TIC 12345");
  assert.deepEqual(curves, []);
});

test(
  "createSpocSectorFetcher returns resolved sectors, drops 404s, and serves repeats from cache",
  { skip: have ? false : "no cached product; run npm run p0:mast" },
  async () => {
    const fits = readFileSync(CACHE);
    let calls = 0;
    const mockFetch = (async (url: string) => {
      calls++;
      // sector 9 misses; sectors 4 and 5 return the real cached bytes
      if (String(url).includes("-s0009_")) return new Response("Not Found", { status: 404 });
      return new Response(new Uint8Array(fits), { status: 200 });
    }) as never;
    const f = createSpocSectorFetcher({ fetchImpl: mockFetch, concurrency: 3 });

    const first = await f.fetchSectors(25155310, [4, 5, 9], "TIC 25155310");
    assert.equal(first.length, 2, "two resolved sectors in order, the 404 omitted");
    assert.ok(first.every((lc) => lc.points.length > 1000 && lc.source!.includes("REAL photometry")));
    assert.equal(calls, 3, "one fetch per distinct sector key");

    const before = calls;
    const second = await f.fetchSectors(25155310, [4, 5, 9], "TIC 25155310");
    assert.equal(second.length, 2);
    assert.equal(calls, before, "cache: a repeat run triggers zero new downloads");
  },
);
