// Gaia independent-corroboration module (src/data/gaiaRv.ts) -- offline, deterministic, PURE. Network + ADQL
// live in the fetch layer and the p88 script; here we drive the real pure functions on synthetic TAP columnar
// payloads and pin the load-bearing HONESTY property: only POSITIVE Gaia evidence (a stellar-mass companion whose
// orbit matches the candidate period) may corroborate an eclipsing binary; absence / off-period / unmeasured mass
// is ALWAYS the honest "unknown" and must never be read as a favourable grade.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  columnarToRows, mapRvEpochRows, mapOrbitRows, mapFlagsRow, rvAstrometryVsCandidate,
  orbitBySourceAdql, epochsBySourceAdql, flagsBySourceAdql,
} from "../src/data/gaiaRv.ts";
import type { CorroborationInput, GaiaOrbit } from "../src/data/gaiaRv.ts";

// A columnar TAP-JSON payload ({metadata:[{name}],data:[[...]]}) -- exactly the shape Gaia's FORMAT=json emits.
function col(names: string[], rows: unknown[][]): unknown {
  return { metadata: names.map((name) => ({ name })), data: rows };
}

const ORBIT_COLS = ["source_id", "nss_solution_type", "period", "eccentricity", "semi_amplitude_primary", "semi_amplitude_secondary", "mass_ratio", "significance", "rv_n_obs_primary", "astrometric_n_obs_al"];
const EPOCH_COLS = ["rv_obs_time", "radial_velocity", "radial_velocity_error", "rejected_by_variability"];

test("columnarToRows keys each row by column name; nulls survive as null (mapped to NaN downstream)", () => {
  const rows = columnarToRows(col(["a", "b"], [[1, null], [2, "x"]]));
  assert.deepEqual(rows, [{ a: 1, b: null }, { a: 2, b: "x" }]);
  assert.deepEqual(columnarToRows(null), []);
  assert.deepEqual(columnarToRows({ metadata: [], data: [] }), []);
});

test("mapOrbitRows: source_id stays a STRING, period is converted years -> days, non-orbit nulls -> NaN", () => {
  const rows = mapOrbitRows(col(ORBIT_COLS, [["4611686018427387904", "SB1", 2.0, 0.1, 50000, null, 0.9, 9.9, 12, 40]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, "4611686018427387904"); // 19-digit id not rounded by Number()
  assert.equal(rows[0].solutionType, "SB1");
  assert.ok(Math.abs(rows[0].periodDays - 730.5) < 1e-6, "2 yr -> ~730.5 d");
  assert.equal(rows[0].kPrimaryMps, 50000);
  assert.ok(Number.isNaN(rows[0].kSecondaryMps), "null secondary -> NaN, not 0");
});

test("mapRvEpochRows skips rows with no RV value and parses the reject flag", () => {
  const rows = mapRvEpochRows(col(EPOCH_COLS, [[1000, 25.4, 3.2, false], [1100, null, 4.0, true], [1200, -8.1, 2.5, 1]]));
  assert.equal(rows.length, 2, "the null-RV row is dropped");
  assert.equal(rows[0].rvMps, 25.4);
  assert.equal(rows[0].rejected, false);
  assert.equal(rows[1].rejected, true, "1/true both read as rejected");
});

test("mapFlagsRow: has_rvs + non_single_star bitmask; empty result -> null", () => {
  const f = mapFlagsRow(col(["has_rvs", "non_single_star"], [[true, 6]]));
  assert.deepEqual(f, { hasRvs: true, nonSingleStarBits: 6 });
  assert.equal(mapFlagsRow(col(["has_rvs", "non_single_star"], [])), null);
});

function orbit(over: Partial<GaiaOrbit>): GaiaOrbit {
  return { sourceId: "1", solutionType: "SB2", periodDays: 3, eccentricity: 0, kPrimaryMps: 0, kSecondaryMps: 0, massRatio: 1, significance: 0, rvNObsPrimary: 0, astrometricNObsAl: 0, ...over };
}
function input(over: Partial<CorroborationInput>): CorroborationInput {
  return { candidatePeriodDays: 3, orbit: null, epochs: [], flags: null, ...over };
}

test("STELLAR-mass companion whose orbit matches the candidate -> independently corroborates an EB (the veto fires)", () => {
  const v = rvAstrometryVsCandidate(input({ orbit: orbit({ periodDays: 3.05, kPrimaryMps: 60000, solutionType: "SB2" }) }));
  assert.equal(v.ebExclusion, "supported");
  assert.equal(v.blendCorroborated, true);
  assert.equal(v.periodMatched, true);
  assert.match(v.note, /eclipsing binary|stellar/i);
});

test("PLANET-mass companion on the candidate period -> DISfavors an EB (corroboration of planetary nature)", () => {
  const v = rvAstrometryVsCandidate(input({ orbit: orbit({ periodDays: 2.95, kPrimaryMps: 800 }) }));
  assert.equal(v.ebExclusion, "excluded");
  assert.equal(v.blendCorroborated, false);
  assert.equal(v.periodMatched, true);
});

test("Gaia orbit exists but on a DIFFERENT period -> honest unknown (independent data, no bearing on this candidate)", () => {
  const v = rvAstrometryVsCandidate(input({ candidatePeriodDays: 3, orbit: orbit({ periodDays: 200, kPrimaryMps: 80000 }) }));
  assert.equal(v.ebExclusion, "unknown");
  assert.equal(v.blendCorroborated, false);
  assert.equal(v.periodMatched, false);
});

test("NO Gaia data at all -> unknown, and NEVER a favourable grade (this is the whole point of the conservative bias)", () => {
  for (const v of [rvAstrometryVsCandidate(input({})), rvAstrometryVsCandidate(input({ epochs: [], flags: { hasRvs: false, nonSingleStarBits: 0 } }))]) {
    assert.equal(v.ebExclusion, "unknown");
    assert.equal(v.blendCorroborated, false);
  }
});

test("host flagged non-single / RV-variable but NO orbital solution -> unknown (some companion, uncharacterised)", () => {
  const v = rvAstrometryVsCandidate(input({ flags: { hasRvs: true, nonSingleStarBits: 2 }, epochs: [{ rvObsTime: 1, rvMps: 5, rvErrMps: 2, rejected: false }] }));
  assert.equal(v.ebExclusion, "unknown");
  assert.match(v.note, /no orbital solution|non-single/i);
});

test("period alias 2x is accepted within tolerance; matched orbit with unmeasured K stays unknown", () => {
  // candidate 3d, orbit 6d == 2x alias -> matches; K unmeasured -> cannot grade mass.
  const v = rvAstrometryVsCandidate(input({ candidatePeriodDays: 3, orbit: orbit({ periodDays: 6.0, kPrimaryMps: NaN }) }));
  assert.equal(v.periodMatched, true);
  assert.equal(v.ebExclusion, "unknown");
});

test("the verdict is deterministic and pure for identical inputs", () => {
  const i = input({ orbit: orbit({ periodDays: 3.02, kPrimaryMps: 45000 }) });
  assert.deepEqual(rvAstrometryVsCandidate(i), rvAstrometryVsCandidate(i));
});

test("ADQL builders cast int64 source_id to varchar, reject a non-numeric id, and avoid reserved columns", () => {
  const o = orbitBySourceAdql("4611686018427387904");
  assert.match(o, /cast\(source_id as varchar\)/);
  assert.match(o, /nss_two_body_orbit/);
  assert.ok(!/\bdistance\b/.test(o), "reserved word `distance` must not appear");
  assert.match(epochsBySourceAdql("123"), /vari_epoch_radial_velocity/);
  assert.match(flagsBySourceAdql("123"), /gaia_source/);
  assert.throws(() => orbitBySourceAdql("1;2"), /invalid Gaia source_id/);
});
