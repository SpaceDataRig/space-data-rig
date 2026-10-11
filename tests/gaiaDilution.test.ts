import assert from "node:assert/strict";
import { parseColumnarGaia, dilutionFromNeighbors, angularSepArcsec, type GaiaSource } from "../src/data/gaiaDilution.ts";

// A real-shaped Gaia TAP JSON payload: FORMAT=json returns COLUMNAR {metadata:[{name}],data:[[..]]}.
const FIXTURE = {
  metadata: [
    { name: "source_id" }, { name: "ra" }, { name: "dec" },
    { name: "phot_g_mean_mag" }, { name: "phot_bp_mean_mag" }, { name: "phot_rp_mean_mag" }, { name: "ruwe" },
  ],
  data: [
    [1, 93.5, -80.7, 8.0, 8.5, 7.5, 1.1],
    [2, 93.5001, -80.7, 12.0, 12.5, 11.5, 1.0],
    [3, 94.0, -80.7, 9.0, 9.5, 8.5, 1.2], // far away (0.5 deg) -> outside aperture
    ["x", null, null, null, null, null, null], // malformed row -> must be dropped
  ],
};

// 1. Columnar parse maps by metadata name and drops rows without finite ra/dec/gmag.
{
  const rows = parseColumnarGaia(FIXTURE);
  assert.equal(rows.length, 3, `expected 3 valid rows, got ${rows.length}`);
  assert.equal(rows[0].gmag, 8.0);
  assert.equal(rows[1].sourceId, "2");
  assert.ok(rows.every((r) => Number.isFinite(r.ra) && Number.isFinite(r.gmag)));
}
assert.deepEqual(parseColumnarGaia({ nope: 1 }), [], "garbage input -> empty, no throw");
assert.deepEqual(parseColumnarGaia(null), [], "null -> empty");

// 2. Separation in arcsec: 1/3600 deg along a meridian ~ 1 arcsec at the equator.
{
  const sep = angularSepArcsec(10, 0, 10, 1 / 3600);
  assert.ok(Math.abs(sep - 1) < 1e-3, `~1 arcsec expected, got ${sep}`);
}

// 3. No neighbours in aperture -> perfectly clean (dilution factor 1, not determined).
{
  const host: GaiaSource = { sourceId: "h", ra: 0, dec: 0, gmag: 9, bpmag: 9, rpmag: 9, ruwe: 1 };
  const r = dilutionFromNeighbors(9, 0, 0, [host], 10, host.sourceId);
  assert.equal(r.nInAperture, 0);
  assert.equal(r.dilutionFactor, 1);
  assert.ok(!r.determined);
}

// 4. One equal-brightness neighbour -> exactly half the light is a blend (factor 0.5, 100% contamination).
{
  const nb: GaiaSource = { sourceId: "n", ra: 0.00005, dec: 0, gmag: 9, bpmag: 9, rpmag: 9, ruwe: 1 };
  const r = dilutionFromNeighbors(9, 0, 0, [nb], 30);
  assert.ok(Math.abs(r.dilutionFactor - 0.5) < 1e-9, `equal-mag blend -> 0.5, got ${r.dilutionFactor}`);
  assert.ok(Math.abs(r.contaminationPct - 100) < 1e-6);
  assert.ok(r.determined);
}

// 5. A faint neighbour dilutes only a little; a bright far neighbour must be excluded by the aperture.
{
  const faint: GaiaSource = { sourceId: "f", ra: 0.00003, dec: 0, gmag: 14, bpmag: 14, rpmag: 14, ruwe: 1 }; // 5 mag fainter
  const farBright: GaiaSource = { sourceId: "fb", ra: 0.01, dec: 0, gmag: 6, bpmag: 6, rpmag: 6, ruwe: 1 }; // outside 20"
  const r = dilutionFromNeighbors(9, 0, 0, [faint, farBright], 20);
  assert.equal(r.nInAperture, 1, "the bright distant source must be excluded");
  assert.ok(r.dilutionFactor > 0.99 && r.dilutionFactor < 1, `5-mag fainter neighbour -> near-clean, got ${r.dilutionFactor}`);
  assert.ok(r.brightestContrastMag > 4.9, "recorded contrast is the faint neighbour");
}

console.log("gaiaDilution.test.ts OK");
