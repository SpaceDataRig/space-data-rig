// Candidate snapshot boundary validator. Offline, deterministic. The load-bearing test: a row that dares
// to carry discoveryClaim=true (or any non-false value) must be REJECTED -- the whole point of the boundary
// is that no over-claim can slip into the public candidate board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot, CANDIDATE_SCHEMA, CANDIDATE_DISCLAIMER, type CandidateRow, type CandidateSnapshot } from "../src/candidate/snapshot.ts";

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    tic: 139114989, ra: 319.8, dec: -46.9, tmag: 13.69,
    periodDays: 10.1313, epochBjd: 2458349.1827, depthPpm: 12000, snr: 43.6,
    tier: "low", depthRegime: "planet-plausible", priorityBand: "medium", priorityScore: 0.55,
    nextTransitBjd: 2461327.79, daysUntilNext: 1.9, altitudeDeg: -62.1, observable: false, siteName: "Maunakea (reference site)",
    distinctHostsSharingEphemeris: 1, suspectedCommonSystematic: false, corroboratedSectors: 1,
    discoveryClaim: false,
    ...over,
  };
}

function snap(over: Partial<CandidateSnapshot> = {}): CandidateSnapshot {
  return {
    schema: CANDIDATE_SCHEMA,
    generatedAt: "2026-10-12T09:00:00.000Z",
    sectors: [1, 2, 3],
    referenceSite: "Maunakea (reference site)",
    disclaimer: CANDIDATE_DISCLAIMER,
    calibrationNote: "n=4207 confirmed depths",
    summary: { rawDetections: 8, planetPlausible: 2, independentEphemerides: 2, multiHostSystematicGroups: 0, corroboratedHosts: 0 },
    candidates: [row()],
    ...over,
  };
}

test("a well-formed snapshot validates and round-trips", () => {
  const v = validateSnapshot(snap());
  assert.equal(v.ok, true);
});

test("HONESTY INVARIANT: a row claiming a discovery is rejected", () => {
  const bad = snap({ candidates: [row({ discoveryClaim: true as unknown as false })] });
  const v = validateSnapshot(bad);
  assert.equal(v.ok, false);
  assert.ok((v as { errors: string[] }).errors.some((e) => /discoveryClaim MUST be false/.test(e)));
});

test("a row with discoveryClaim omitted (undefined) is also rejected", () => {
  const r = row() as unknown as Record<string, unknown>;
  delete r.discoveryClaim;
  const v = validateSnapshot(snap({ candidates: [r as unknown as CandidateRow] }));
  assert.equal(v.ok, false);
});

test("wrong or missing schema is rejected", () => {
  assert.equal(validateSnapshot(snap({ schema: "sdr-candidates/0" as never })).ok, false);
  assert.equal(validateSnapshot({ ...snap(), schema: undefined }).ok, false);
});

test("out-of-range priorityScore is rejected", () => {
  assert.equal(validateSnapshot(snap({ candidates: [row({ priorityScore: 1.5 })] })).ok, false);
  assert.equal(validateSnapshot(snap({ candidates: [row({ priorityScore: -0.1 })] })).ok, false);
});

test("missing candidates array and non-object input are rejected", () => {
  assert.equal(validateSnapshot({ ...snap(), candidates: undefined }).ok, false);
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot("nope").ok, false);
});

test("null next-transit / altitude are allowed (unmeasurable, honestly null)", () => {
  const v = validateSnapshot(snap({ candidates: [row({ nextTransitBjd: null, altitudeDeg: null, daysUntilNext: null })] }));
  assert.equal(v.ok, true);
});

test("a suspected common systematic row still validates (flagged, not hidden)", () => {
  const v = validateSnapshot(snap({ candidates: [row({ distinctHostsSharingEphemeris: 4, suspectedCommonSystematic: true })] }));
  assert.equal(v.ok, true);
});
