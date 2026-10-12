import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";

// A real TGLC s0001 product (Gaia DR3 6479517581213243264, TIC 139091033), downloaded token-free from
// the public stpubdata bucket and committed so this test proves the parser against REAL bytes with no
// network in CI. CC BY 4.0 (Han et al. 2023).
const bytes = new Uint8Array(readFileSync("tests/fixtures/tglc-sample-s0001.fits"));

test("parses a real TGLC file into a normalized light curve", () => {
  const lc = tglcBytesToLightCurve(bytes, "TGLC-test");
  assert.ok(lc, "expected a parsed light curve");
  assert.ok(lc!.points.length > 100, `expected many cadences, got ${lc!.points.length}`);
  assert.equal(lc!.mission, "TESS");
  // times strictly increasing
  for (let i = 1; i < lc!.points.length; i++) assert.ok(lc!.points[i].time > lc!.points[i - 1].time, "time not monotonic");
  // normalized: median flux ~ 1.0
  const fluxes = lc!.points.map((p) => p.flux).sort((a, b) => a - b);
  const med = fluxes[fluxes.length >> 1];
  assert.ok(Math.abs(med - 1) < 1e-6, `expected median ~1.0, got ${med}`);
});

test("selects a flux column that actually has data and records honest provenance", () => {
  const lc = tglcBytesToLightCurve(bytes, "TGLC-test")!;
  // this star's PSF columns are all-NaN, so the parser must fall through to a populated column
  assert.match(lc.source!, /column 'cal_aper_flux'/);
  assert.match(lc.source!, /REAL photometry/);
  assert.match(lc.source!, /Han et al\. 2023/);
});

test("deterministic: two parses are identical", () => {
  const a = tglcBytesToLightCurve(bytes, "x")!;
  const b = tglcBytesToLightCurve(bytes, "x")!;
  assert.equal(a.points.length, b.points.length);
  assert.equal(a.points[0].flux, b.points[0].flux);
  assert.equal(a.points[a.points.length - 1].time, b.points[b.points.length - 1].time);
});

test("rejects non-FITS bytes", () => {
  assert.throws(() => tglcBytesToLightCurve(new Uint8Array([1, 2, 3, 4, 5]), "junk"));
});

test("converts the reduced-BJD time column to ABSOLUTE BJD_TDB (for Stage-3 observability)", () => {
  const lc = tglcBytesToLightCurve(bytes, "TGLC-test")!;
  // Sector 1 real data: reduced time ~1325-1353; the parser must add BJDREFI=2457000 -> true BJD ~2.458e6
  assert.ok(lc.points[0].time > 2450000 && lc.points[0].time < 2470000, `expected absolute BJD, got ${lc.points[0].time}`);
  assert.match(lc.source!, /absolute BJD_TDB via BJDREFI=2457000 applied/);
});

test("reads host metadata from the PRIMARY header for the novelty gate", () => {
  const m = tglcHeaderMeta(bytes);
  // TICID is a quoted string in the header; the parser must surface it as the safe integer 139091033
  assert.equal(m.tic, 139091033);
  assert.equal(m.sector, 1);
  assert.ok(m.ra != null && Math.abs(m.ra - 319.3695096649233) < 1e-6, `ra=${m.ra}`);
  assert.ok(m.dec != null && Math.abs(m.dec - -47.03374652357791) < 1e-6, `dec=${m.dec}`);
  assert.ok(m.tmag != null && Math.abs(m.tmag - 8.138207467213718) < 1e-6, `tmag=${m.tmag}`);
});
