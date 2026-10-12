// Stage-3 prioritization + observability. Offline, deterministic. The positional-astronomy math is checked
// via TIME-INDEPENDENT invariants (at a geographic pole altitude equals declination), so we are validating
// the geometry, not a hand-tuned expected number. The ranking is checked for the honesty properties that
// matter: excluded tiers score zero, undetermined inputs stay neutral, and stronger evidence never lowers
// the priority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { altitudeAtDeg, nextTransitBjdAfter, prioritize, bjdToJd, type ObserveSite } from "../src/candidate/prioritize.ts";
import type { CandidateRecord } from "../src/candidate/candidateRecord.ts";

const pole: ObserveSite = { name: "north pole", latitudeDeg: 90, longitudeDegEast: 0 };
const site: ObserveSite = { name: "mid-lat", latitudeDeg: 33, longitudeDegEast: -120 };

function rec(over: Partial<{ snr: number; tmag: number; ra: number; dec: number; epochBjd: number; periodDays: number; tier: CandidateRecord["tier"] }>): CandidateRecord {
  const o = { snr: 15, tmag: 9, ra: 290, dec: 33, epochBjd: 2459000, periodDays: 5, tier: "moderate" as CandidateRecord["tier"], ...over };
  return {
    host: { tic: 1, ra: o.ra, dec: o.dec, tmag: o.tmag },
    detection: { periodDays: o.periodDays, epochBjd: o.epochBjd, durationHours: 2, depthPpm: 1000, snr: o.snr, nSectors: 1, nPointsInTransit: 5 },
    tier: o.tier,
    discoveryClaim: false,
  } as unknown as CandidateRecord;
}

test("bjdToJd shifts by the 2400000.5 BJD epoch", () => {
  assert.equal(bjdToJd(0), 2400000.5);
});

test("at the north pole a target's altitude equals its declination, independent of time", () => {
  for (const bjd of [2459000, 2459123.7, 2458800.1]) {
    assert.ok(Math.abs(altitudeAtDeg(0, 40, bjd, pole) - 40) < 1e-6);
    assert.ok(Math.abs(altitudeAtDeg(120, 15, bjd, pole) - 15) < 1e-6);
  }
});

test("altitude stays within [-90,90] across a sweep", () => {
  for (let ra = 0; ra < 360; ra += 37) for (let dec = -90; dec <= 90; dec += 25) {
    const a = altitudeAtDeg(ra, dec, 2459111.25, site);
    assert.ok(a >= -90.0001 && a <= 90.0001, `alt ${a} out of range for ra=${ra} dec=${dec}`);
  }
});

test("nextTransitBjdAfter returns the first epoch at or after now", () => {
  assert.equal(nextTransitBjdAfter(100, 7, 100), 100, "exactly at an epoch counts");
  assert.equal(nextTransitBjdAfter(100, 7, 100.5), 107);
  assert.equal(nextTransitBjdAfter(100, 7, 105), 107);
  assert.ok(Number.isNaN(nextTransitBjdAfter(100, 0, 105)), "zero period is unusable");
});

test("prioritize refuses to rank a not-planetary or not-novel signal", () => {
  for (const tier of ["not-planetary", "not-novel"] as const) {
    const p = prioritize(rec({ tier }), 2459000, site);
    assert.equal(p.priorityBand, "not-rankable");
    assert.equal(p.priorityScore, 0);
  }
});

test("prioritize is deterministic for a fixed (record, now, site)", () => {
  const a = prioritize(rec({}), 2459000.4, site);
  const b = prioritize(rec({}), 2459000.4, site);
  assert.deepEqual(a, b);
});

test("stronger measured evidence never lowers the priority score", () => {
  const weak = prioritize(rec({ snr: 8 }), 2459000, site);
  const strong = prioritize(rec({ snr: 30 }), 2459000, site);
  assert.ok(strong.priorityScore >= weak.priorityScore, `snr monotonic broken: ${strong.priorityScore} < ${weak.priorityScore}`);
});

test("an unmeasured SNR/magnitude stays neutral and is named in factors", () => {
  const p = prioritize(rec({ snr: NaN, tmag: NaN }), 2459000, site);
  assert.ok(p.factors.some((f) => /neutral/.test(f)));
  assert.ok(p.priorityScore >= 0 && p.priorityScore <= 1);
});

test("observableFromSite is consistent with the reported mid-transit altitude", () => {
  const p = prioritize(rec({}), 2459000, site);
  if (p.altitudeAtMidTransitDeg != null) {
    assert.equal(p.observableFromSite, p.altitudeAtMidTransitDeg >= 20);
  } else {
    assert.equal(p.observableFromSite, false);
  }
});
