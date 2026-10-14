// Offline tests for the crowding metric (blend-veto acceptance follow-up). Pure geometry + binning;
// the Gaia fetch is in the script. Checks galactic-latitude against known reference directions and the
// neighbour-in-aperture / binning logic.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  galacticLatitudeDeg,
  absGalacticLatitude,
  neighborsInAperture,
  crowdingBin,
  crowdingOf,
  type GaiaNeighbor,
} from "../src/candidate/crowding.ts";

test("galactic latitude of the north galactic pole is +90", () => {
  const b = galacticLatitudeDeg(192.8595, 27.1283);
  assert.ok(Math.abs(b - 90) < 0.1, `expected ~90, got ${b}`);
});

test("galactic latitude of the Galactic Centre (Sgr A*) is ~0", () => {
  const b = galacticLatitudeDeg(266.4168, -28.9366);
  assert.ok(Math.abs(b) < 1.0, `expected |b|<1, got ${b}`);
});

test("absolute galactic latitude is in [0,90] and never negative", () => {
  for (const [ra, dec] of [[0, 0], [90, 45], [180, -60], [300, 80], [12, -12]]) {
    const ab = absGalacticLatitude(ra, dec);
    assert.ok(ab >= 0 && ab <= 90, `|b| out of range at ${ra},${dec}: ${ab}`);
  }
});

test("neighborsInAperture keeps only rows within the aperture", () => {
  const nb: GaiaNeighbor[] = [
    { gmag: 12, sepArcsec: 3 },
    { gmag: 14, sepArcsec: 20 },
    { gmag: 15, sepArcsec: 30 },
    { gmag: 13, sepArcsec: NaN },
  ];
  const inAp = neighborsInAperture(nb, 21);
  assert.deepEqual(inAp.map((n) => n.sepArcsec), [3, 20]);
});

test("crowdingBin thresholds: isolated <=1, moderate <=4, crowded >4", () => {
  assert.equal(crowdingBin(0), "isolated");
  assert.equal(crowdingBin(1), "isolated");
  assert.equal(crowdingBin(2), "moderate");
  assert.equal(crowdingBin(4), "moderate");
  assert.equal(crowdingBin(5), "crowded");
});

test("crowdingOf assembles nearest sep, count, |b| and bin", () => {
  const nb: GaiaNeighbor[] = [
    { gmag: 12, sepArcsec: 2.5 },
    { gmag: 13, sepArcsec: 8 },
    { gmag: 14, sepArcsec: 40 }, // outside 21" aperture
  ];
  const m = crowdingOf(266.4168, -28.9366, nb, 21);
  assert.equal(m.nInAperture, 2);
  assert.equal(m.nearestSepArcsec, 2.5);
  assert.equal(m.bin, "moderate");
  assert.ok(m.absB < 1.0, `near the plane, |b| should be small, got ${m.absB}`);
});

test("crowdingOf with no neighbours is isolated with infinite nearest sep", () => {
  const m = crowdingOf(30, 30, [], 21);
  assert.equal(m.nInAperture, 0);
  assert.equal(m.nearestSepArcsec, Infinity);
  assert.equal(m.bin, "isolated");
});
