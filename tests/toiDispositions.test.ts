// Offline tests for the token-free ExoFOP TOI-disposition parser (roadmap P0 labelled negative class).
// A tiny embedded CSV fixture mirrors the real header (sexagesimal RA/Dec, quoted comma-separated
// Sectors, and the KP/FP/EB/PC disposition codes) so parsing is verified deterministically, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSexagesimal,
  parseCsvRecords,
  classifyDisposition,
  parseToiTable,
  isPlaceable,
  labelledNegatives,
  confirmedPositives,
} from "../src/data/toiDispositions.ts";

const FIXTURE = [
  "TIC ID,TOI,TESS Disposition,TFOPWG Disposition,TESS Mag,RA,Dec,Epoch (BJD),Period (days),Duration (hours),Depth (ppm),Stellar Radius (R_Sun),Stellar Mass (M_Sun),Sectors",
  // known planet (KP), sexagesimal coords, quoted multi-sector field
  '261136679,1001.01,KP,CP,8.1,06:30:00.00,+15:00:00.00,2459000.5,3.2000,2.0,1200,0.96,0.99,"14,41"',
  // TFOPWG False Positive -> blend-or-fp
  '22712134,6287.01,PC,FP,12.6,02:31:51.31,+28:57:57.64,2459908.580448,1.640758,1.326,2129,1.52,1.22,"18,58"',
  // TESS Eclipsing Binary -> blend-or-fp
  '400000000,77.02,EB,PC,10.4,12:00:00.00,-45:30:00.00,2458800.1,0.9000,1.5,8000,1.10,1.05,5',
  // ambiguous (candidate only) -> other
  '500000000,88.01,CP,APC,11.0,20:00:00.00,+00:10:00.00,2458850.0,5.5000,3.0,500,1.00,1.00,7',
  // known planet but UNPLACEABLE (period 0) -> excluded from positives
  '600000000,99.01,KP,CP,9.0,10:00:00.00,+20:00:00.00,2459100.0,0,1.0,300,0.90,0.90,3',
].join("\n") + "\n";

test("parseSexagesimal converts HMS/DMS to decimal degrees with sign", () => {
  assert.ok(Math.abs(parseSexagesimal("02:31:51.31") - (2 + 31 / 60 + 51.31 / 3600)) < 1e-6);
  assert.ok(Math.abs(parseSexagesimal("-45:30:00.00") - -45.5) < 1e-6);
  assert.ok(Math.abs(parseSexagesimal("+15:00:00.00") - 15) < 1e-6);
  assert.ok(Number.isNaN(parseSexagesimal("")));
});

test("parseCsvRecords honours quoted fields containing commas", () => {
  const recs = parseCsvRecords('a,b\n"1,5",2\n');
  assert.deepEqual(recs[1], ["1,5", "2"]);
});

test("classifyDisposition is conservative (only KP and FP/EB are asserted)", () => {
  assert.equal(classifyDisposition("KP", "CP"), "known-planet");
  assert.equal(classifyDisposition("PC", "FP"), "blend-or-fp");
  assert.equal(classifyDisposition("EB", "PC"), "blend-or-fp");
  assert.equal(classifyDisposition("CP", "APC"), "other");
});

test("parseToiTable reads labels, sexagesimal coords, and quoted sectors", () => {
  const rows = parseToiTable(FIXTURE);
  assert.equal(rows.length, 5);
  const fp = rows.find((r) => r.tic === 22712134)!;
  assert.equal(fp.label, "blend-or-fp");
  assert.deepEqual(fp.sectors, [18, 58]);
  assert.ok(Math.abs(fp.ra - (2 + 31 / 60 + 51.31 / 3600)) < 1e-4);
  assert.ok(Math.abs(fp.dec - (28 + 57 / 60 + 57.64 / 3600)) < 1e-4);
  assert.equal(rows.find((r) => r.tic === 400000000)!.label, "blend-or-fp"); // EB
  assert.equal(rows.find((r) => r.tic === 261136679)!.label, "known-planet"); // KP
  assert.equal(rows.find((r) => r.tic === 500000000)!.label, "other"); // CP/APC
});

test("labelledNegatives and confirmedPositives select only placeable, correctly-labelled rows", () => {
  const rows = parseToiTable(FIXTURE);
  const neg = labelledNegatives(rows).map((r) => r.tic).sort((a, b) => a - b);
  assert.deepEqual(neg, [22712134, 400000000]);
  // the KP row with period 0 is not placeable, so positives == only the good KP row
  const pos = confirmedPositives(rows).map((r) => r.tic);
  assert.deepEqual(pos, [261136679]);
  assert.equal(isPlaceable(rows.find((r) => r.tic === 600000000)!), false);
});

test("parseToiTable returns [] on junk / header-only input", () => {
  assert.deepEqual(parseToiTable(""), []);
  assert.deepEqual(parseToiTable("TIC ID,TOI\n"), []);
});
