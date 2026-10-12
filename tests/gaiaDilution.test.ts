import assert from "node:assert/strict";
import { parseColumnarGaia, dilutionFromNeighbors, angularSepArcsec, gaiaConeAdql, gaiaByIdAdql, distancePcFromParallax, type GaiaSource } from "../src/data/gaiaDilution.ts";

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

// 6. source_id is a 64-bit int; MANY exceed 2^53. The ADQL must CAST it to varchar so the JSON
//    arrives as a STRING and survives JSON.parse (the fix for a silently-rounded "no such star").
{
  const cone = gaiaConeAdql(328.6977, 52.7841, 0.0028);
  assert.ok(/cast\(source_id as varchar\) as source_id/.test(cone), `cone ADQL must cast source_id, got: ${cone}`);
  const by = gaiaByIdAdql("1981360227180249088");
  assert.ok(/cast\(source_id as varchar\) as source_id/.test(by), "by-id ADQL must cast source_id");
  assert.ok(by.includes("1981360227180249088"), "by-id ADQL embeds the full 19-digit id verbatim");
  assert.throws(() => gaiaByIdAdql("1; drop table"), "non-digit id rejected");
}

// 7. The fix, end-to-end through JSON.parse: a quoted (varchar-cast) id keeps all 19 digits.
{
  const raw = '{"metadata":[{"name":"source_id"},{"name":"ra"},{"name":"dec"},{"name":"phot_g_mean_mag"}],'
    + '"data":[["1981360227180249088",328.6977,52.7841,10.52]]}';
  const rows = parseColumnarGaia(JSON.parse(raw));
  assert.equal(rows[0].sourceId, "1981360227180249088", "varchar-cast id survives JSON.parse exactly");
}

// 8. The trap pinned as a regression: the SAME id as a bare JSON NUMBER is silently rounded by
//    JSON.parse -> this is precisely what the cast avoids, so we document it with an assertion.
{
  const raw = '{"metadata":[{"name":"source_id"},{"name":"ra"},{"name":"dec"},{"name":"phot_g_mean_mag"}],'
    + '"data":[[1981360227180249088,328.6977,52.7841,10.52]]}';
  const rows = parseColumnarGaia(JSON.parse(raw));
  assert.notEqual(rows[0].sourceId, "1981360227180249088", "bare-number id loses precision (why we cast)");
}

// 9. dilutionFromNeighbors excludes the host by EXACT big-int string id (no magnitude guess).
{
  const hostId = "1981360227180249088";
  const host: GaiaSource = { sourceId: hostId, ra: 10, dec: 20, gmag: 10.5, bpmag: 10.6, rpmag: 10.4, ruwe: 0.9, parallax: 20.684 };
  const nb: GaiaSource = { sourceId: "1991778271640247808", ra: 10.00003, dec: 20, gmag: 16, bpmag: 16, rpmag: 16, ruwe: 1.1, parallax: 24 };
  const r = dilutionFromNeighbors(10.5, 10, 20, [host, nb], 21, hostId);
  assert.equal(r.nInAperture, 1, "only the neighbour counts; the host is excluded by exact id");
  assert.ok(r.contaminationPct > 0 && r.contaminationPct < 1, `a 5.5-mag fainter neighbour dilutes <1%, got ${r.contaminationPct}`);
}

// 10. distance from parallax (mas -> pc) is NaN-safe.
{
  const d = distancePcFromParallax(20.684);
  assert.ok(Math.abs(d - 48.35) < 0.1, `20.684 mas ~ 48.3 pc, got ${d}`);
  assert.ok(Number.isNaN(distancePcFromParallax(0)) && Number.isNaN(distancePcFromParallax(NaN)));
}

console.log("gaiaDilution.test.ts OK");
