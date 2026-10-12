// Stage-2 astrophysical false-positive screen: calibrated transit-depth regime + its wiring into the
// candidate contract. Offline, pure, deterministic. The central honesty invariant is that a real, deep
// confirmed planet (observed max ~166590 ppm) must NEVER be excluded -- only signals deeper than every
// known planet are rejected; the sparse deep band is at most downgraded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDepthRegime, CALIBRATED_DEPTH, type DepthCalibration } from "../src/candidate/falsePositive.ts";
import { buildCandidateRecord, assertHonest, type BuildInput, type CandidateRecord } from "../src/candidate/candidateRecord.ts";
import type { BlendRisk, GeometryResult, Detectability, NoveltyResult } from "../src/review/externalReview.ts";

test("the default calibration is the MEASURED one, not a magic constant", () => {
  assert.equal(CALIBRATED_DEPTH.hardCeilingPpm, 200000, "hard ceiling is ~1.2x the observed deepest confirmed planet");
  assert.equal(CALIBRATED_DEPTH.deepSuspectPpm, 40000, "deep-suspect starts just above the measured p99.5");
  assert.match(CALIBRATED_DEPTH.source, /n=4207/, "provenance records the calibration sample size");
  assert.match(CALIBRATED_DEPTH.source, /p21-depth-calibrate/, "provenance points at the script that measured it");
});

test("depth regimes are monotonic: plausible -> suspect -> not-planetary", () => {
  assert.equal(classifyDepthRegime(1200).regime, "planet-plausible");
  assert.equal(classifyDepthRegime(30000).regime, "planet-plausible", "3% is NOT automatically an EB: p99 of real planets sits here");
  assert.equal(classifyDepthRegime(40001).regime, "deep-suspect");
  assert.equal(classifyDepthRegime(100000).regime, "deep-suspect");
  assert.equal(classifyDepthRegime(200001).regime, "not-planetary");
  assert.equal(classifyDepthRegime(272639).regime, "not-planetary", "the p19/p17 27% eclipsing-binary signal is the target of this screen");
});

test("a real deep confirmed planet is never excluded, only capped below high", () => {
  const deepest = classifyDepthRegime(166590); // observed MAX depth among 4207 confirmed planets
  assert.equal(deepest.planetPlausible, true, "must not reject the deepest genuine planet in the catalog");
  assert.equal(deepest.regime, "deep-suspect");
});

test("only beyond-the-whole-population depths are flatly not-planetary", () => {
  assert.equal(classifyDepthRegime(166590).planetPlausible, true);
  assert.equal(classifyDepthRegime(200000).planetPlausible, true, "at the ceiling, inclusive, is still not rejected");
  assert.equal(classifyDepthRegime(200001).planetPlausible, false);
});

test("an unmeasured depth never deletes a candidate", () => {
  const u = classifyDepthRegime(NaN);
  assert.equal(u.regime, "unknown");
  assert.equal(u.planetPlausible, true, "missing data cannot reject; the contract still refuses to grant high");
});

test("an injected calibration is applied deterministically", () => {
  const cal: DepthCalibration = { hardCeilingPpm: 1000, deepSuspectPpm: 500, source: "test" };
  assert.equal(classifyDepthRegime(400, cal).regime, "planet-plausible");
  assert.equal(classifyDepthRegime(600, cal).regime, "deep-suspect");
  assert.equal(classifyDepthRegime(1500, cal).regime, "not-planetary");
});

// ---- wiring into the Stage-0 candidate contract ----

const host = { tic: 999000111, ra: 10.5, dec: -20.25, tmag: 9.4 };
const novel = (over: Partial<NoveltyResult> = {}): NoveltyResult => ({ inConfirmed: false, inToi: false, confirmedScanned: 5000, toiScanned: 8000, ...over });
const blendLow: BlendRisk = { tier: "low", needsGroundBased: false, contaminationPct: 1, nInAperture: 0, brightestContrastMag: 6, rationale: "x" };
const geomOk: GeometryResult = { starRadiusRsun: 1, aOverRs: 8, expectedT14Hours: 2.1, deltaPct: 0.02, consistent: true };
const detAbove: Detectability = { pointsInTransit: 6, snrProxy: 12, belowOurFloor: false, reason: "ok" };
const sig = { fap: 0.001, rho: 0.3 };

const inputAtDepth = (depthPpm: number, withDepthScreen = true): BuildInput => ({
  host,
  detection: { periodDays: 3.5, epochBjd: 2459000.5, durationHours: 2.1, depthPpm, snr: 14, nSectors: 3, nPointsInTransit: 40 },
  novelty: novel(),
  significance: sig,
  vetting: { blend: blendLow, geometry: geomOk, centroidOffsetArcsec: 0.3, oddEvenAsymmetryFrac: 0.1, secondaryEclipseDepthFrac: 0, detectability: detAbove, depth: withDepthScreen ? classifyDepthRegime(depthPpm) : null },
  nextTransitsBjd: [2459100.1],
  dataTier: "real",
  catalogSource: { confirmed: "pscomppars", toi: "toi", asOfUtc: "2026-01-01T00:00:00.000Z" },
  nowIso: "2026-01-01T00:00:00.000Z",
});

test("contract: a beyond-ceiling depth is bucketed not-planetary, with no follow-up", () => {
  const r = buildCandidateRecord(inputAtDepth(272639));
  assert.equal(r.tier, "not-planetary");
  assert.deepEqual(r.followupNeeds, []);
  assert.equal(r.discoveryClaim, false);
});

test("contract: deep-suspect caps an otherwise-clean signal below high", () => {
  const r = buildCandidateRecord(inputAtDepth(100000));
  assert.notEqual(r.tier, "high", "a brown-dwarf/EB-dominated depth cannot be granted high on depth alone");
  assert.ok(r.followupNeeds.some((n) => /eclipsing-binary/.test(n)));
});

test("contract: a planet-plausible depth still reaches high when every other axis is clean", () => {
  const r = buildCandidateRecord(inputAtDepth(1200));
  assert.equal(r.tier, "high");
});

test("assertHonest refuses a fabricated high tier carrying a deep-suspect depth", () => {
  const bad: CandidateRecord = { ...buildCandidateRecord(inputAtDepth(100000)), tier: "high" };
  assert.throws(() => assertHonest(bad), /deep-suspect|unmeasured-depth/);
});
