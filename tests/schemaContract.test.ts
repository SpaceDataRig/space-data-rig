// Schema-contract tests (audit finding #7: brittle external data deps, no contract test).
// These do NOT hit the network. They pin the exact strings/column names the pipeline depends on so
// that an upstream rename -- or a change to a source-label string that the honesty tags key off --
// becomes a RED test instead of silently mislabelled cards or silently-empty columns.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isRealPhotometry,
  PSOMPPARS_COLUMNS,
  PSOMPPARS_READ_FIELDS,
  EXOFOP_REQUIRED_HEADERS,
} from "../src/data/dataTier.ts";
import { parseToiTable, isPlaceable } from "../src/data/toiDispositions.ts";
import { getFallbackCatalog } from "../src/data/exoplanetArchive.ts";

// ---- the real/stand-in discriminator ----

test("isRealPhotometry is exactly the /real photometry/i contract the producers + consumers share", () => {
  // Producers: token-free S3 tier labels real curves with "(REAL photometry)"; the fallback labels a stand-in.
  const real = "stitched 2 TESS-SPOC sector(s), span 54.1 d (REAL photometry)";
  const standIn = "synthetic stand-in for MAST TESS 2-min (seed=7000, AR1 rho=0.31); catalog source=nasa-tap";
  assert.equal(isRealPhotometry(real), true);
  assert.equal(isRealPhotometry(standIn), false);
  assert.equal(isRealPhotometry(undefined), false);
  // Contract: the canonical helper must agree with the regex the web provenance panel still mirrors.
  for (const s of [real, standIn, "Real Photometry", "no such phrase", ""]) {
    assert.equal(isRealPhotometry(s), /real photometry/i.test(s));
  }
});

// ---- NASA pscomppars column contract ----

test("every pscomppars field the code READS is one it REQUESTS (subset of PSOMPPARS_COLUMNS)", () => {
  const requested = new Set<string>(PSOMPPARS_COLUMNS);
  for (const field of PSOMPPARS_READ_FIELDS) {
    assert.ok(requested.has(field), `reads '${field}' but never selects it -- would come back undefined`);
  }
});

test("the shipped fallback catalog honours the field contract downstream relies on", () => {
  const { planets, source } = getFallbackCatalog();
  assert.equal(source, "fallback");
  assert.ok(planets.length > 0);
  for (const p of planets) {
    // These are the columns the fetch filter + downstream consumer read: period, brightness, depth.
    assert.ok(Number.isFinite(p.pl_orbper ?? NaN), `${p.pl_name}: missing pl_orbper`);
    assert.ok(Number.isFinite(p.sy_tmag ?? NaN), `${p.pl_name}: missing sy_tmag`);
    assert.ok(p.pl_trandep == null || p.pl_trandep > 0, `${p.pl_name}: pl_trandep should be ppm (>0)`);
  }
});

// ---- ExoFOP TOI-table header contract: an upstream rename must fail LOUD, not silent ----

function headerWith(ticName = "TIC ID"): string {
  return EXOFOP_REQUIRED_HEADERS.map((h) => (h === "TIC ID" ? ticName : h)).join(",");
}
const ROW = "261136679,1001.01,06:30:00.00,+15:00:00.00,3.2"; // tic, toi, ra, dec, period (matches REQUIRED order)

test("parseToiTable reads a full header built from the contract, then a required rename fails closed", () => {
  const fullHeader =
    "TIC ID,TOI,TESS Disposition,TFOPWG Disposition,TESS Mag,RA,Dec,Epoch (BJD),Period (days),Duration (hours),Depth (ppm),Stellar Radius (R_Sun),Stellar Mass (M_Sun),Sectors";
  const good =
    '261136679,1001.01,KP,CP,8.1,06:30:00.00,+15:00:00.00,2459000.5,3.2,2.0,1200,0.96,0.99,14';
  assert.equal(parseToiTable(`${fullHeader}\n${good}\n`).length, 1);

  // Rename the mandatory "TIC ID" column upstream -> the tic column is gone -> every row drops to NaN.
  const renamed = fullHeader.replace("TIC ID", "id");
  assert.equal(parseToiTable(`${renamed}\n${good}\n`).length, 0); // fail CLOSED, not garbage

  // Header built from the contract's required names is consumed correctly (order-independent lookup).
  const rows = parseToiTable(`${headerWith()}\n${ROW}\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tic, 261136679);
  assert.equal(isPlaceable(rows[0]), false); // partial row (no epoch) is not placeable -- degrades safely
});
