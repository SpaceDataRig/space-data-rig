// MAST real-photometry integration test. Runs only when a cached TESS product
// is present (npm run p0:mast downloads it); otherwise it reports as skipped,
// so CI and fresh clones stay green without a mandatory 2 MB download.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { fitsToLightCurve } from "../src/data/mast.ts";
import { curatedMastFor, truthFromCatalog } from "../src/data/mastCurated.ts";
import { discoverMastProducts } from "../src/data/mastDiscover.ts";
import { detectTransit } from "../src/detect/pipeline.ts";

const CACHE = "out/probe-lc.fits"; // TIC 25155310 (WASP-126), GL sector 0004, 2-min cadence
const have = existsSync(CACHE);

test("real MAST FITS parses into a sane TESS light curve", { skip: have ? false : "no cached product; run npm run p0:mast" }, () => {
  const bytes = new Uint8Array(readFileSync(CACHE));
  const lc = fitsToLightCurve(bytes, "TIC 25155310");
  assert.equal(lc.mission, "TESS");
  assert.ok(lc.points.length > 10000, `expected >10k real points, got ${lc.points.length}`);
  assert.ok(Math.abs((lc.cadenceSec ?? 0) - 120) <= 2, `2-min product, got cadence ${lc.cadenceSec}s`);
  const span = lc.points[lc.points.length - 1].time - lc.points[0].time;
  assert.ok(span > 20 && span < 40, `sector-4 baseline should span ~27d, got ${span.toFixed(1)}d`);
});

test("BLS finds a strong transit signal in real photometry", { skip: have ? false : "no cached product" }, () => {
  const bytes = new Uint8Array(readFileSync(CACHE));
  const lc = fitsToLightCurve(bytes, "TIC 25155310");
  const det = detectTransit(lc, { minPeriodDays: 0.5, maxPeriodDays: 13 });
  // WASP-126 b: P=3.2888d, depth~7000ppm. On real data the detector faces a
  // genuine alias problem -- assert the recovered period is consistent with the
  // true period OR one of its low-order harmonics (alias), never noise.
  const truth = 3.28883;
  const ratios = det.candidate.periodDays / truth;
  const nearHarmonic = [1, 2, 3, 0.5].some((h) => Math.abs(ratios / h - 1) < 0.02);
  assert.ok(nearHarmonic, `period ${det.candidate.periodDays.toFixed(3)}d not near ${truth}d or a harmonic (ratio ${ratios.toFixed(3)})`);
  assert.ok(det.candidate.snr > 20, `expected strong real signal, snr=${det.candidate.snr.toFixed(1)}`);
});

// ---- curated registry (pure logic, no network) ----

test("curatedMastFor resolves host names case-insensitively and misses cleanly", () => {
  assert.equal(curatedMastFor("WASP-126")?.productUri.includes("tess2018292075959"), true);
  assert.equal(curatedMastFor("wasp-126")?.label.includes("TIC 25155310"), true);
  assert.equal(curatedMastFor("HD 99999"), null);
  assert.equal(curatedMastFor(undefined), null);
});

test("truthFromCatalog derives sane open-loop parameters", () => {
  const t = truthFromCatalog({
    pl_name: "WASP-126 b", hostname: "WASP-126", pl_orbper: 3.28883, pl_trandep: 7005.7, pl_trandur: 3.4368,
    pl_rade: 21.0, st_rad: 1.61, st_mass: 1.25,
  } as never);
  assert.equal(t.periodDays, 3.28883);
  assert.ok(Math.abs(t.depthFrac * 1e6 - 7005.7) < 0.1);
  assert.ok(t.aOverRs > 3 && t.aOverRs < 10, `a/Rs=${t.aOverRs}`);
  assert.ok(Math.abs(t.planetRadiusRatio - (21 * 0.0091577 / 1.61)) < 1e-9);
  assert.equal(t.stellarMassMsun, 1.25);
});

// ---- discovery client (pure logic, mocked fetch, no network) ----

test("discoverMastProducts rejects bad coordinates", async () => {
  await assert.rejects(() => discoverMastProducts(NaN, 0), /bad coordinates/);
});

test("discoverMastProducts returns [] on the anonymous-empty CAOM body", async () => {
  const orig = globalThis.fetch;
  // Verified real behavior: HTTP 200 with body "{}" for anonymous callers.
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as never;
  try {
    assert.deepEqual(await discoverMastProducts(96.7977, -3.76), []);
  } finally {
    globalThis.fetch = orig;
  }
});

test("discoverMastProducts resolves Cone->Products and keeps only light curves", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: URLSearchParams }) => {
    const req = JSON.parse(String(init?.body?.get("request")));
    if (req.service === "Mast.Caom.Cone") {
      return new Response(JSON.stringify({ status: 200, data: [{ obs_id: "s0004", mission_name: "TESS", data_uri: "mast:TESS/observation/x" }] }), { status: 200 });
    }
    if (req.service === "Mast.Caom.Products") {
      return new Response(JSON.stringify({ status: 200, data: [
        { data_uri: "mast:TESS/product/a_lc.fits", description: "SPOC light curve" },
        { data_uri: "mast:TESS/product/a_unc.fits", description: "unrelated" },
      ] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as never;
  try {
    const found = await discoverMastProducts(96.7977, -3.76);
    assert.equal(found.length, 1);
    assert.equal(found[0].dataUri, "mast:TESS/product/a_lc.fits");
  } finally {
    globalThis.fetch = orig;
  }
});
