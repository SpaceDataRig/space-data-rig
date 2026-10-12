// Stage-4 cross-sector corroboration layers. Offline, deterministic, NO network.
// The load-bearing properties this pins:
//   * L3 drops an ephemeris shared by MULTIPLE hosts (a sector-common systematic, not N planets);
//   * L4 keeps only a host whose coincident ephemeris RECURS across >=2 independent sectors;
//   * a single-host, single-sector spike survives L1/L2/L3 but is rejected at L4;
//   * the counts are monotone non-increasing across layers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLayerFilters, survivingHostsByLayer, type SectorDetection } from "../src/candidate/corroboration.ts";

function det(tic: number, sector: number, periodDays: number, epochBjd: number, fapPassed = true): SectorDetection {
  return { tic, sector, periodDays, epochBjd, fapPassed };
}

test("L1 counts distinct hosts; L2 drops hosts with no FAP-passing detection", () => {
  const dets = [
    det(1, 1, 5, 100, true),
    det(2, 1, 3, 60, false), // this host's only detection fails the FAP gate
  ];
  const c = applyLayerFilters(dets);
  assert.equal(c.hostsL1, 2);
  assert.equal(c.hostsL2, 1); // host 2 removed at L2
});

test("L3 rejects an ephemeris shared by multiple hosts (sector-common systematic)", () => {
  // three unrelated hosts all light up at P=10.13 d, same absolute epoch -> ONE dip copied onto many stars
  const dets = [
    det(11, 1, 10.1313, 2458349.1827),
    det(12, 1, 10.1313, 2458349.1827),
    det(13, 1, 10.1313, 2458349.1828),
    det(14, 1, 4.0, 900), // a lone single-host detection with its own distinct ephemeris
  ];
  const c = applyLayerFilters(dets);
  assert.equal(c.hostsL1, 4);
  assert.equal(c.hostsL2, 4);
  assert.equal(c.hostsL3, 1); // only host 14 survives; the 11/12/13 shared cluster is dropped as a systematic
  assert.equal(c.hostsL4, 0); // host 14 is single-sector -> cannot be corroborated
});

test("L4 keeps a host whose coincident ephemeris recurs across >=2 sectors", () => {
  // a real planet: same host, coincident ephemeris (epoch offset by exactly one period) in two sectors
  const dets = [
    det(14, 1, 4.0, 900.0),
    det(14, 2, 4.0, 904.0), // 904 = 900 + 1*P -> same phase, folded epoch ~ 0
  ];
  const c = applyLayerFilters(dets);
  assert.equal(c.hostsL1, 1);
  assert.equal(c.hostsL3, 1); // single host, never flagged multi-host systematic
  assert.equal(c.hostsL4, 1); // corroborated across sectors 1 and 2
});

test("a single-host single-sector spike survives L1/L2/L3 but is rejected at L4", () => {
  const dets = [det(21, 3, 2.7, 1234.5)];
  const c = applyLayerFilters(dets);
  assert.equal(c.hostsL1, 1);
  assert.equal(c.hostsL2, 1);
  assert.equal(c.hostsL3, 1);
  assert.equal(c.hostsL4, 0);
});

test("L4 rejects same-host multi-sector detections that are NOT ephemeris-coincident", () => {
  // a host observed twice but with a half-period epoch offset (incoherent) -> not corroboration
  const dets = [
    det(31, 1, 5.0, 100.0),
    det(31, 2, 5.0, 102.5), // 102.5 is P/2 off -> folded epoch 2.5 d > 0.05 d tolerance
  ];
  const c = applyLayerFilters(dets);
  assert.equal(c.hostsL3, 1);
  assert.equal(c.hostsL4, 0);
});

test("counts are monotone non-increasing and survivingHostsByLayer agrees with the counts", () => {
  const dets = [
    det(1, 1, 5, 100, true),
    det(1, 2, 5, 105, true),
    det(2, 1, 5, 100, true), // shares host 1's ephemeris -> multi-host cluster -> L3 drops both
    det(3, 1, 2.0, 50, false), // fails FAP -> gone at L2
  ];
  const c = applyLayerFilters(dets);
  assert.ok(c.hostsL1 >= c.hostsL2 && c.hostsL2 >= c.hostsL3 && c.hostsL3 >= c.hostsL4);
  assert.equal(c.hostsL1, 3);
  assert.equal(c.hostsL2, 2); // hosts 1 and 2 pass FAP; host 3 fails
  assert.equal(c.hostsL3, 0); // hosts 1 & 2 form a multi-host shared-ephemeris cluster -> both dropped
  assert.equal(c.hostsL4, 0);
  const s = survivingHostsByLayer(dets);
  assert.deepEqual(s.l1, new Set([1, 2, 3]));
  assert.deepEqual(s.l2, new Set([1, 2]));
  assert.equal(s.l3.size, 0);
  assert.equal(s.l4.size, 0);
});
