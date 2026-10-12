// Stage-4 ephemeris-coincidence collapse. Offline, deterministic. The core honesty property: several
// DIFFERENT host stars reporting the SAME (period, epoch) must collapse to one group flagged as a suspected
// common systematic -- that is evidence about the data, not N independent planets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseCoincident, foldedEpochDelta, DEFAULT_COINCIDENCE, type EphemerisGroup } from "../src/candidate/dedup.ts";
import type { CandidateRecord } from "../src/candidate/candidateRecord.ts";

function rec(tic: number, periodDays: number, epochBjd: number, snr: number): CandidateRecord {
  return {
    host: { tic, ra: 0, dec: 0, tmag: 10 },
    detection: { periodDays, epochBjd, durationHours: 2, depthPpm: 1000, snr, nSectors: 1, nPointsInTransit: 5 },
    tier: "low",
    discoveryClaim: false,
  } as unknown as CandidateRecord;
}

test("foldedEpochDelta wraps phase, not raw time", () => {
  // two epochs one full period apart are the SAME phase -> ~0
  assert.ok(foldedEpochDelta(2458349.18, 2458349.18 + 5, 5) < 1e-9);
  // just under half a period apart -> ~0.4
  assert.ok(Math.abs(foldedEpochDelta(100, 100.4, 5) - 0.4) < 1e-9);
  // 0.6 days apart on a 5d period is the SAME as 4.4 the other way -> folded to 0.6
  assert.ok(Math.abs(foldedEpochDelta(100, 104.4, 5) - 0.6) < 1e-9);
  assert.equal(foldedEpochDelta(NaN, 100, 5), Infinity);
});

test("distinct hosts sharing one ephemeris collapse to a suspected common systematic", () => {
  const groups = collapseCoincident([rec(1, 10.1313, 2458349.1827, 43), rec(2, 10.1313, 2458349.1827, 24)]);
  assert.equal(groups.length, 1, "the two identical-ephemeris rows are one group");
  const g: EphemerisGroup = groups[0];
  assert.equal(g.distinctHosts, 2);
  assert.equal(g.suspectedCommonSystematic, true);
  assert.equal(g.members.length, 2, "members are kept, not dropped");
  assert.equal(g.representative.host.tic, 1, "highest-SNR host is the representative");
});

test("different periods are not merged", () => {
  const groups = collapseCoincident([rec(1, 10.1313, 2458349.1827, 43), rec(2, 4.7951, 2458349.1827, 14)]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => !g.suspectedCommonSystematic));
});

test("same period but well-separated phase stays independent", () => {
  // 2 days apart in phase on a 10d period >> t0Tol -> separate
  const groups = collapseCoincident([rec(1, 10.1313, 2458349.1827, 43), rec(2, 10.1313, 2458351.1827, 24)]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => !g.suspectedCommonSystematic));
});

test("unusable ephemeris never merges (stays a singleton)", () => {
  const groups = collapseCoincident([rec(1, NaN, 2458349.1827, 43), rec(2, NaN, 2458349.1827, 24)]);
  assert.equal(groups.length, 2, "garbage periods are not clustered together");
});

test("groups are ordered by representative SNR descending", () => {
  const groups = collapseCoincident([
    rec(1, 10.1, 2458349.0, 5),
    rec(2, 4.8, 2458349.0, 50),
    rec(3, 20.2, 2458349.0, 20),
  ]);
  assert.deepEqual(groups.map((g) => g.representative.detection.snr), [50, 20, 5]);
});

test("default tolerance is documented + finite", () => {
  assert.ok(DEFAULT_COINCIDENCE.periodTolPct > 0 && DEFAULT_COINCIDENCE.periodTolPct < 5);
  assert.ok(DEFAULT_COINCIDENCE.t0TolDays > 0 && DEFAULT_COINCIDENCE.t0TolDays < 1);
});
