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
