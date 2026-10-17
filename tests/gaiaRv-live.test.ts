// Live-data regression for Gaia independent corroboration (MANDATORY gate per repo discipline: the real external
// table must be shown to behave like the pure function predicts -- a passing synthetic test is not proof). Reads the
// committed fixture tests/fixtures/live-gaia-rv.json (captured by `npm run fixtures:capture-gaia` from REAL Gaia DR3
// rows) and re-runs the PURE rvAstrometryVsCandidate on it. No network in CI.
//
// The load-bearing POSITIVE-CONTROL claim: these are CONFIRMED transiting planets, so Gaia must NOT independently
// corroborate any of their transit periods as a STELLAR-mass eclipsing binary. A "supported" verdict on a real planet
// would be a false kill (the alias/period logic grabbing an unrelated orbit) -- the exact failure the measure-before-gate
// rule forbids. Any occurrence must fail this test loudly so it is investigated, never silently shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rvAstrometryVsCandidate } from "../src/data/gaiaRv.ts";
import type { CorroborationInput } from "../src/data/gaiaRv.ts";

interface Case {
  plName: string;
  periodDays: number;
  gaiaSourceId: string;
  orbit: CorroborationInput["orbit"];
  epochs: CorroborationInput["epochs"];
  flags: CorroborationInput["flags"];
  ebExclusion: string;
  blendCorroborated: boolean;
  periodMatched: boolean;
}

const fx = JSON.parse(readFileSync(new URL("./fixtures/live-gaia-rv.json", import.meta.url), "utf8")) as {
  schema: string; source: string; withGaiaData: number; count: number; cases: Case[];
};

test("fixture is a real Gaia capture with data-bearing positive-control hosts", () => {
  assert.equal(fx.schema, "sdr-gaia-rv/1");
  assert.match(fx.source, /Gaia DR3/);
  assert.ok(fx.count > 0, "fixture must contain at least one real captured host");
  assert.equal(fx.count, fx.cases.length);
  assert.ok(fx.withGaiaData > 0, "at least one host must carry real Gaia RV/orbit data (else the control is trivial)");
});

test("re-running the PURE verdict on real captured rows reproduces the stored decision exactly (logic <-> data fidelity)", () => {
  for (const c of fx.cases) {
    const v = rvAstrometryVsCandidate({ candidatePeriodDays: c.periodDays, orbit: c.orbit, epochs: c.epochs, flags: c.flags });
    assert.equal(v.ebExclusion, c.ebExclusion, `${c.plName}: pure verdict drifted from the captured one`);
    assert.equal(v.blendCorroborated, c.blendCorroborated);
    assert.equal(v.periodMatched, c.periodMatched);
  }
});

test("POSITIVE CONTROL: Gaia NEVER corroborates a confirmed planet's transit period as a stellar-mass EB", () => {
  const falseCorroborated = fx.cases.filter((c) => c.ebExclusion === "supported");
  assert.equal(
    falseCorroborated.length, 0,
    `Gaia called ${falseCorroborated.map((c) => c.plName).join(", ")} an EB -- a real planet wrongly corroborated as a false positive; investigate the period-alias/mass logic before ANY gating`,
  );
});

test("the conservative invariant holds on real rows: blendCorroborated only ever co-occurs with 'supported'", () => {
  for (const c of fx.cases) {
    assert.ok(!c.blendCorroborated || c.ebExclusion === "supported", `${c.plName}: corroborated flag set without a 'supported' exclusion`);
  }
});

test("every captured host actually has some independent Gaia evidence (the capture is of DATA-bearing cases by design)", () => {
  for (const c of fx.cases) {
    const has = c.orbit != null || c.epochs.length > 0 || (c.flags != null && (c.flags.hasRvs || c.flags.nonSingleStarBits > 0));
    assert.ok(has, `${c.plName}: stored as data-bearing but carries none`);
  }
});
