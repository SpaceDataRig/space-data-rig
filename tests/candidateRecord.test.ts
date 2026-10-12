import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateRecord,
  classifyConfidence,
  assertHonest,
  formatFollowupCard,
  DEFAULT_THRESHOLDS,
  type CandidateDetection,
  type CandidateHost,
  type CandidateSignificance,
  type CandidateVetting,
  type BuildInput,
  type CandidateRecord,
} from "../src/candidate/candidateRecord.ts";
import type { BlendRisk, GeometryResult, Detectability, NoveltyResult } from "../src/review/externalReview.ts";

const host: CandidateHost = { tic: 999000111, ra: 10.5, dec: -20.25, tmag: 9.4 };
const detection: CandidateDetection = { periodDays: 3.5, epochBjd: 2459000.5, durationHours: 2.1, depthPpm: 1200, snr: 14, nSectors: 3, nPointsInTransit: 40 };
const sig: CandidateSignificance = { fap: 0.001, rho: 0.3 };

const novel = (over: Partial<NoveltyResult> = {}): NoveltyResult => ({ inConfirmed: false, inToi: false, confirmedScanned: 5000, toiScanned: 8000, ...over });
const blendLow: BlendRisk = { tier: "low", needsGroundBased: false, contaminationPct: 1, nInAperture: 0, brightestContrastMag: 6, rationale: "x" };
const blendUndet: BlendRisk = { tier: "undetermined", needsGroundBased: true, contaminationPct: NaN, nInAperture: 0, brightestContrastMag: NaN, rationale: "x" };
const geomOk: GeometryResult = { starRadiusRsun: 1, aOverRs: 8, expectedT14Hours: 2.1, deltaPct: 0.02, consistent: true };
const geomBad: GeometryResult = { starRadiusRsun: 1, aOverRs: 8, expectedT14Hours: 5, deltaPct: 0.6, consistent: false };
const detAbove: Detectability = { pointsInTransit: 6, snrProxy: 12, belowOurFloor: false, reason: "ok" };
const detBelow: Detectability = { pointsInTransit: 1, snrProxy: 2, belowOurFloor: true, reason: "sample-starved at this cadence" };

const cleanVetting = (): CandidateVetting => ({ blend: blendLow, geometry: geomOk, centroidOffsetArcsec: 0.3, oddEvenAsymmetryFrac: 0.1, secondaryEclipseDepthFrac: 0, detectability: detAbove });

const baseInput = (over: Partial<BuildInput> = {}): BuildInput => ({
  host, detection, novelty: novel(), significance: sig, vetting: cleanVetting(),
  nextTransitsBjd: [2459100.1, 2459103.6], dataTier: "real",
  catalogSource: { confirmed: "pscomppars", toi: "toi", asOfUtc: "2026-01-01T00:00:00.000Z" },
  nowIso: "2026-01-01T00:00:00.000Z", ...over,
});

test("high: novel + gates passed + all vetting clean", () => {
  const r = buildCandidateRecord(baseInput());
  assert.equal(r.tier, "high");
  assert.equal(r.discoveryClaim, false);
  // even a high candidate must ask for independent corroboration
  assert.ok(r.followupNeeds.some((n) => /independently-scheduled transit/.test(n)));
});

test("not-novel: a confirmed host is not a discovery candidate", () => {
  const r = buildCandidateRecord(baseInput({ novelty: novel({ inConfirmed: true }) }));
  assert.equal(r.tier, "not-novel");
  assert.deepEqual(r.followupNeeds, []);
});

test("sub-floor: an undetectable-at-this-cadence signal is labelled about OUR detector", () => {
  const cls = classifyConfidence(novel(), detection, sig, { ...cleanVetting(), detectability: detBelow });
  assert.equal(cls.tier, "sub-floor");
});

test("undetermined centroid downgrades high to moderate (silence never promotes)", () => {
  const v = cleanVetting();
  delete v.centroidOffsetArcsec;
  const r = buildCandidateRecord(baseInput({ vetting: v }));
  assert.equal(r.tier, "moderate");
  assert.ok(r.followupNeeds.some((n) => /centroid offset/.test(n)));
});

test("undetermined blend downgrades to moderate", () => {
  const v = cleanVetting();
  v.blend = blendUndet;
  const r = buildCandidateRecord(baseInput({ vetting: v }));
  assert.equal(r.tier, "moderate");
});

test("inconsistent geometry downgrades to moderate", () => {
  const v = cleanVetting();
  v.geometry = geomBad;
  const r = buildCandidateRecord(baseInput({ vetting: v }));
  assert.equal(r.tier, "moderate");
});

test("catalog-unavailable prevents high and flags novelty as not established", () => {
  const r = buildCandidateRecord(baseInput({ novelty: novel({ confirmedScanned: -1, toiScanned: -1 }) }));
  assert.notEqual(r.tier, "high");
  assert.ok(r.reasons.some((x) => /novelty not established/.test(x)));
});

test("low: SNR below the gate", () => {
  const r = buildCandidateRecord(baseInput({ detection: { ...detection, snr: 4 } }));
  assert.equal(r.tier, "low");
});

test("low: calibrated FAP above the gate", () => {
  const r = buildCandidateRecord(baseInput({ significance: { fap: 0.4, rho: 0.5 } }));
  assert.equal(r.tier, "low");
});

test("assertHonest rejects a fabricated high-confidence claim on a non-novel signal", () => {
  const bad: CandidateRecord = { ...buildCandidateRecord(baseInput()), tier: "high", novelty: novel({ inConfirmed: true }) };
  assert.throws(() => assertHonest(bad), /non-novel/);
});

test("assertHonest rejects any flipped discovery claim", () => {
  const bad = { ...buildCandidateRecord(baseInput()), discoveryClaim: true as unknown as false };
  assert.throws(() => assertHonest(bad), /discovery claim/);
});

test("deterministic for fixed input", () => {
  assert.deepEqual(buildCandidateRecord(baseInput()), buildCandidateRecord(baseInput()));
});

test("followup card states candidate-not-discovery and lists needs", () => {
  const card = formatFollowupCard(buildCandidateRecord(baseInput()));
  assert.match(card, /candidate, not a discovery claim/);
  assert.match(card, /To raise confidence/);
  assert.match(card, /Confidence tier: high/);
});

test("defaults mirror production gates", () => {
  assert.equal(DEFAULT_THRESHOLDS.minSnr, 7);
  assert.equal(DEFAULT_THRESHOLDS.maxFap, 0.05);
});
