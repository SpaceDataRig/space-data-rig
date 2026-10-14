// Offline tests for the novelty disposition module (priority 5 prerequisite).
// Pure matching logic on synthetic catalog rows; the network fetch is tested by the script, not here.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  angularSeparationArcsec,
  findMatches,
  disposition,
  type CatalogEntry,
  type CandidatePos,
} from "../src/candidate/novelty.ts";

test("angular separation: identical points are 0 arcsec", () => {
  assert.equal(angularSeparationArcsec({ ra: 12.3, dec: -45.6 }, { ra: 12.3, dec: -45.6 }), 0);
});

test("angular separation: 0.01 deg in declination at the equator is 36 arcsec", () => {
  const s = angularSeparationArcsec({ ra: 0, dec: 0 }, { ra: 0, dec: 0.01 });
  assert.ok(Math.abs(s - 36) < 0.5, `expected ~36 arcsec, got ${s}`);
});

test("angular separation: right-ascension gap shrinks with cos(dec) near the pole", () => {
  const eq = angularSeparationArcsec({ ra: 0, dec: 0 }, { ra: 0.01, dec: 0 });
  const hi = angularSeparationArcsec({ ra: 0, dec: 80 }, { ra: 0.01, dec: 80 });
  assert.ok(Math.abs(eq - 36) < 0.5);
  assert.ok(Math.abs(hi - 36 * Math.cos((80 * Math.PI) / 180)) < 1.0, `decos shrink expected, got ${hi}`);
});

test("angular separation is symmetric", () => {
  const a = { ra: 100.2, dec: 12.5 };
  const b = { ra: 100.25, dec: 12.4 };
  assert.ok(Math.abs(angularSeparationArcsec(a, b) - angularSeparationArcsec(b, a)) < 1e-9);
});

const cand: CandidatePos = { tic: 100, ra: 10, dec: 10, periodDays: 5 };
const entries: CatalogEntry[] = [
  { label: "A-sametick", kind: "toi", ra: 10, dec: 10, tic: 100, periodDays: 5.02 }, // same TIC, period ~match
  { label: "B-neighbour", kind: "toi", ra: 10.001, dec: 10, tic: 999, periodDays: 20 }, // within 30", other TIC
  { label: "C-far", kind: "confirmed", ra: 11, dec: 11, tic: 888, periodDays: 5 }, // far away
];

test("findMatches keeps same-TIC and in-radius rows, drops distant ones", () => {
  const m = findMatches(cand, entries, { radiusArcsec: 30 });
  const labels = m.map((x) => x.entry.label).sort();
  assert.deepEqual(labels, ["A-sametick", "B-neighbour"]);
  const a = m.find((x) => x.entry.label === "A-sametick")!;
  assert.equal(a.sameTic, true);
  assert.equal(a.samePeriod, true);
  const b = m.find((x) => x.entry.label === "B-neighbour")!;
  assert.equal(b.sameTic, false);
  assert.equal(b.withinRadius, true);
  assert.equal(b.samePeriod, false);
});

test("findMatches: a same-TIC row far on the sky still matches (TIC is authoritative)", () => {
  const far: CatalogEntry[] = [{ label: "D", kind: "confirmed", ra: 200, dec: -30, tic: 100, periodDays: 5 }];
  const m = findMatches(cand, far, { radiusArcsec: 30 });
  assert.equal(m.length, 1);
  assert.equal(m[0].sameTic, true);
});

test("disposition: announced + samePeriodAnnounced when a match shares the period", () => {
  const d = disposition(cand, entries, { radiusArcsec: 30 });
  assert.equal(d.announced, true);
  assert.equal(d.samePeriodAnnounced, true);
  assert.equal(d.novelLocation, false);
  assert.equal(d.nearestLabel, "A-sametick");
  assert.equal(d.discoveryClaim, false);
});

test("disposition: novelLocation when nothing is at/near the position", () => {
  const d = disposition(cand, [entries[2]], { radiusArcsec: 30 }); // only the far row
  assert.equal(d.announced, false);
  assert.equal(d.novelLocation, true);
  assert.equal(d.samePeriodAnnounced, false);
  assert.equal(d.nearestLabel, null);
});

test("disposition: neighbour present but different period -> announced, not same-period", () => {
  const noPeriod: CatalogEntry[] = [{ label: "B", kind: "toi", ra: 10.001, dec: 10, tic: 999, periodDays: 20 }];
  const d = disposition(cand, noPeriod, { radiusArcsec: 30 });
  assert.equal(d.announced, true);
  assert.equal(d.samePeriodAnnounced, false);
});

test("matching is deterministic for identical inputs", () => {
  const a = disposition(cand, entries, { radiusArcsec: 30 });
  const b = disposition(cand, entries, { radiusArcsec: 30 });
  assert.deepEqual(a, b);
});
