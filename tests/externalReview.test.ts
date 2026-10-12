import assert from "node:assert/strict";
import {
  impliedGeometry,
  periodPowerRank,
  blendRiskTier,
  detectabilityFloor,
  makeCatalogStamp,
  reviewExternalCandidate,
  type CandidateClaim,
  type ReviewDeps,
} from "../src/review/externalReview.ts";
import type { BLSResult } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";
import type { GaiaSource, DilutionResult } from "../src/data/gaiaDilution.ts";

// ---- the two externally-claimed candidates, exactly as reviewed in p15 (single source of truth) ----
const AK: CandidateClaim = { label: "Aakanksha", tic: 370612437, gaiaSourceId: "1981360227180249088", periodDays: 3.564921, epochBjd: 2458742.1409, depthPpm: 210, t14Hours: 1.44, rpEarth: 1.04, rpOverRs: 0.0144, impactParam: 0.73, sectors: [16, 17, 56, 57] };
const OR: CandidateClaim = { label: "Orbit", tic: 252721481, gaiaSourceId: "1991778271640247808", periodDays: 4.933533, epochBjd: 2458740.6616, depthPpm: 279, t14Hours: 1.59, rpEarth: 1.1, rpOverRs: 0.0167, impactParam: 0.68, sectors: [16, 17, 57] };

// ---- D. geometry self-consistency reproduces p15's published 1.51 h / 1.70 h ----
{
  const g = impliedGeometry(AK);
  assert.ok(Math.abs(g.expectedT14Hours - 1.51) < 0.12, `Aakanksha expected T14 ~1.51h, got ${g.expectedT14Hours.toFixed(3)}`);
  assert.ok(g.consistent && g.deltaPct < 0.1, "his params are internally consistent");
  const g2 = impliedGeometry(OR);
  assert.ok(Math.abs(g2.expectedT14Hours - 1.7) < 0.12, `Orbit expected T14 ~1.70h, got ${g2.expectedT14Hours.toFixed(3)}`);
  assert.equal(impliedGeometry({ periodDays: 3, rpEarth: 1, rpOverRs: 0, impactParam: 0.5, t14Hours: 1 }).consistent, false, "invalid rpOverRs -> not consistent");
}

// ---- C. power rank: rank 0 only when the claimed period IS the grid peak ----
{
  const grid = [{ period: 1, power: 5 }, { period: 2, power: 9 }, { period: 3, power: 7 }];
  assert.equal(periodPowerRank(grid, 2)!.isGlobalPeak, true);
  assert.equal(periodPowerRank(grid, 2)!.rank, 0);
  assert.equal(periodPowerRank(grid, 3)!.rank, 1, "power-7 is beaten only by power-9");
  assert.equal(periodPowerRank(grid, 2.4)!.nearestGridPeriod, 2, "off-grid target snaps to nearest sample");
  assert.equal(periodPowerRank([], 2), null);
}

// ---- B. blend/EB risk tiering (diagnostic, never a reject) ----
const dil = (over: Partial<DilutionResult>): DilutionResult => ({ dilutionFactor: 1, contaminationPct: 0, nInAperture: 0, brightestContrastMag: NaN, brightestSepArcsec: NaN, hostGmag: 10, determined: true, ...over });
{
  assert.equal(blendRiskTier(dil({ determined: false })).tier, "undetermined");
  assert.equal(blendRiskTier(dil({ determined: false })).needsGroundBased, true);
  assert.equal(blendRiskTier(dil({ contaminationPct: 1.8, nInAperture: 13, brightestContrastMag: 5.4 })).tier, "low");
  assert.equal(blendRiskTier(dil({ contaminationPct: 1.8, nInAperture: 13, brightestContrastMag: 5.4 })).needsGroundBased, false);
  assert.equal(blendRiskTier(dil({ contaminationPct: 40, nInAperture: 2, brightestContrastMag: 1.0 })).tier, "high");
  assert.equal(blendRiskTier(dil({ contaminationPct: 10, nInAperture: 1, brightestContrastMag: 3.0 })).tier, "moderate");
}

// ---- detection floor (roadmap item 2): shallow + coarse sampling falls below OUR untuned box statistic ----
{
  const coarse = detectabilityFloor(210, 1.44, 30); // 210 ppm, 1.44 h at TESS FFI 30-min
  assert.ok(coarse.belowOurFloor, "a 1.44h/210ppm dip at 30-min cadence is at/below our floor");
  assert.ok(Math.abs(coarse.pointsInTransit - 2.88) < 0.05, `~2.9 samples cover the dip, got ${coarse.pointsInTransit}`);
  const fine = detectabilityFloor(210, 1.44, 2); // same planet at 2-min HPF-like cadence
  assert.ok(!fine.belowOurFloor, "the SAME planet is well above our floor at 2-min cadence");
  const starved = detectabilityFloor(20000, 0.5, 30); // even a huge dip cannot be seen if <2 samples
  assert.ok(starved.belowOurFloor, "a sub-cadence dip is unresolvable regardless of depth");
  assert.ok(detectabilityFloor(4000, 2, 2).snrProxy > detectabilityFloor(1000, 2, 2).snrProxy, "snr proxy rises with depth");
}

// ---- catalog stamp (roadmap item 7) is deterministic when the clock is injected ----
{
  const s = makeCatalogStamp({ confirmedScanned: 3243, toiScanned: 2103, confirmedSource: "nasa-tap", toiSource: "nasa-tap", nowMs: 1700000000000 });
  assert.equal(s.asOfUtc, new Date(1700000000000).toISOString());
  assert.equal(s.confirmedScanned, 3243);
}

// ---- orchestration with FAKE channels: the audit logic + honest framing, no network ----
function makeLc(n: number, dtDays: number): LightCurve {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ time: 2458000 + i * dtDays, flux: 1 });
  return { targetId: "TIC test", mission: "TESS", cadenceSec: dtDays * 86400, points: pts };
}
// A stub detector whose global peak is NOT the claimed period -> we do NOT corroborate (our floor).
function stubBls(peakPeriod: number): BLSResult {
  const periodGrid = [
    { period: 0.5934, power: 5.0 }, { period: peakPeriod, power: 7.4 }, { period: 3.5, power: 2.1 },
    { period: 4.9, power: 1.8 }, { period: 7.1295, power: 6.9 },
  ];
  return { periodDays: peakPeriod, epochBjd: 2458742, durationDays: 0.06, depth: 0.0004, power: 7.4, snr: 6.3, nInTransit: 6, folded: [], periodGrid };
}
const hostGaia: GaiaSource = { sourceId: "1981360227180249088", ra: 328.6977, dec: 52.7841, gmag: 10.52, bpmag: 10.7, rpmag: 10.3, ruwe: 0.89, parallax: 20.684 };
const faintNb: GaiaSource = { sourceId: "99999", ra: 328.7005, dec: 52.7845, gmag: 15.9, bpmag: 16, rpmag: 15.8, ruwe: 1.0, parallax: 20 };

async function run() {
  const deps: ReviewDeps = {
    confirmedTics: async () => ({ tics: new Set<number>([111, 222]), scanned: 3243, source: "nasa-tap" }),
    toiTics: async () => ({ tics: new Set<number>([333]), scanned: 2103, source: "nasa-tap" }),
    gaiaById: async () => hostGaia,
    gaiaNeighborhood: async () => [hostGaia, faintNb],
    lightCurves: async () => [makeLc(1400, 30 / 1440), makeLc(700, 30 / 1440)],
    runBls: () => stubBls(7.1295),
    calibratedSignificance: () => ({ fap: 0.083, rho: 0.31 }),
    nowMs: 1700000000000,
  };
  const rep = await reviewExternalCandidate(AK, deps);
  assert.equal(rep.novelty.inConfirmed, false, "not in confirmed list");
  assert.equal(rep.novelty.inToi, false, "not in TOI list -> novelty corroborated");
  assert.ok(Math.abs(rep.host!.distancePc - 48.3) < 0.5, `Gaia distance ~48.3 pc, got ${rep.host!.distancePc.toFixed(2)}`);
  assert.ok(rep.host!.astrometryClean, "RUWE 0.89 -> clean");
  assert.equal(rep.blend!.tier, "low", "only faint neighbours -> low blend risk");
  assert.equal(rep.geometry.consistent, true, "his geometry self-consistent");
  assert.equal(rep.detection.length, 2, "two data paths audited");
  assert.equal(rep.corroborated, false, "our box-BLS peak is NOT his period -> we do not corroborate (honest)");
  assert.equal(rep.detectability.belowOurFloor, true, "and we say plainly: at this cadence it is below OUR floor, not against him");
  assert.equal(rep.detection[0].fap, 0.083, "unified significance: calibrated FAP threaded into the audit");
  assert.equal(rep.catalogStamp.asOfUtc, new Date(1700000000000).toISOString());
}

// ---- a channel that fails still emits what it can (offline degradation) ----
async function runDegraded() {
  const deps: ReviewDeps = {
    confirmedTics: async () => { throw new Error("rate limited"); },
    toiTics: async () => ({ tics: new Set<number>(), scanned: 2103, source: "nasa-tap" }),
    gaiaById: async () => { throw new Error("Gaia down"); },
    gaiaNeighborhood: async () => [],
    lightCurves: async () => [],
    runBls: () => stubBls(1),
    nowMs: 1700000000000,
  };
  const rep = await reviewExternalCandidate(OR, deps);
  assert.equal(rep.host, null, "Gaia failure degrades to null host");
  assert.equal(rep.detection.length, 0, "no light curves -> no detection paths");
  assert.ok(rep.notes.some((n) => n.includes("rate limited")), "the failure is recorded, not silently swallowed");
  assert.equal(rep.geometry.consistent, true, "geometry needs no network and is still computed");
}

await run();
await runDegraded();
console.log("externalReview.test.ts OK");
