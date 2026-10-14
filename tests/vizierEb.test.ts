// Offline tests for the VizieR eclipsing-binary access (P52 negative class). Parsing is validated against a
// captured GCVS VOTABLE fixture (real column order); the live network fetch is the script, not tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseEbVotable, eclipsingOnly, buildEbListUrl, buildEbConeUrl } from "../src/data/vizierEb.ts";

const fixture = readFileSync(new URL("../tests/fixtures/gcvs-eb-sample.xml", import.meta.url), "utf8");

test("parseEbVotable extracts positional rows with ra/dec/period/name", () => {
  const rows = parseEbVotable(fixture);
  assert.equal(rows.length, 4);
  const algol = rows.find((r) => r.name === "beta Per");
  assert.ok(algol, "beta Per (Algol) present");
  assert.equal(algol!.ra, 51.073);
  assert.equal(algol!.dec, 40.956);
  assert.equal(algol!.varType, "EA");
  assert.ok(Math.abs((algol!.periodDays ?? 0) - 2.86732) < 1e-4);
});

test("parseEbVotable drops non-positional sub-table rows (col0 not a number)", () => {
  const rows = parseEbVotable(fixture);
  // every kept row has a valid RA in [0,360) and Dec in [-90,90]
  for (const r of rows) {
    assert.ok(r.ra >= 0 && r.ra < 360, `bad RA ${r.ra}`);
    assert.ok(r.dec > -90 && r.dec < 90, `bad Dec ${r.dec}`);
  }
  assert.ok(!rows.some((r) => r.name === "VarType"), "header text rows filtered out");
});

test("parseEbVotable tolerates an empty / no-data VOTABLE (cone returns none)", () => {
  assert.deepEqual(parseEbVotable("<VOTABLE><RESOURCE/></VOTABLE>"), []);
});

test("eclipsingOnly keeps the E* variability classes", () => {
  const all = parseEbVotable(fixture);
  const eb = eclipsingOnly(all);
  assert.equal(eb.length, 3); // EA, EA, EW -- the "M" (T And) is excluded
  assert.ok(eb.every((e) => /^E/i.test(e.varType)));
});

test("URL builders point at GCVS with position columns", () => {
  const list = buildEbListUrl(50);
  assert.ok(list.includes("B/gcvs") && list.includes("-out.max=50") && list.includes("_RAJ2000"));
  const cone = buildEbConeUrl(51.073, 40.956, 1);
  assert.ok(cone.includes("-c=51.073%2040.956") && cone.includes("-c.rs=1"));
});
