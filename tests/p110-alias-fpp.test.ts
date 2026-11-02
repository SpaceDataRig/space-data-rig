// R45: p110 retires the LAST NaN stand-in feeding the discovery gate (harmonic/alias FPP). p103 measured the AR(1)
// significance FAR; the alias field was still NaN (p102 only counted siblings). The whole value of p110 is that a
// placeholder becomes a measured number, so this test's core is: the gate no longer reports a NaN alias reason for
// any host. It re-derives aliasFpp = clearing/total per host, pins that all 9 are the p103 multi-sector hosts and
// still tier none, that every measured alias FPP is far above the 0.01 bar (so the bar now binds for a MEASURED
// reason), and -- decisively -- re-runs the frozen gate on a real host's measured evidence and asserts the alias
// unmet-reason carries a number, never "NaN". Red lines stay false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDiscoveryGate } from "../src/discover/discoveryGate.ts";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p110-alias-fpp.json"), "utf8"));
const p103 = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p103-target-gate-table.json"), "utf8"));
const p102 = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p102-shape-axes-real.json"), "utf8"));
const proto = JSON.parse(readFileSync(resolve(process.cwd(), "discovery-protocol.json"), "utf8"));

test("p110 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the last NaN gate stand-in is retired: zero NaN alias reasons remain", () => {
  assert.equal(R.nanAliasReasonsRemaining, 0);
  assert.equal(R.nHosts, 9, "the p103 multi-sector real hosts");
  // the host set is exactly p103's, so this is the SAME table with the alias field filled in
  const a = new Set(R.rows.map((r) => r.host));
  assert.ok(p103.rows.every((h) => a.has(h.host)), "all p103 hosts covered by p110");
});

test("each alias FPP is the measured decoy density and re-derives as clearing/total", () => {
  for (const r of R.rows) {
    assert.ok(r.nAliases > 0, `${r.host} has an alias family`);
    assert.equal(r.aliasFpp, Number((r.aliasesClearing / r.nAliases).toFixed(4)));
    assert.equal(r.gateTier, "none");
    // on real curves the alias ambiguity is large: every measured value is far above the 0.01 bar
    assert.ok(r.aliasFpp > R.aliasBar, `${r.host} aliasFpp ${r.aliasFpp} exceeds bar -> bar binds, measured not NaN`);
    assert.equal(r.meetsAliasBar, false);
  }
  assert.equal(R.aliasBarBinding, 9);
  assert.equal(R.aliasBarMet, 0);
});

test("mean alias FPP re-derived independently from the rows", () => {
  const mean = Number((R.rows.reduce((s, r) => s + r.aliasFpp, 0) / R.rows.length).toFixed(4));
  assert.equal(R.meanAliasFpp, mean);
});

test("re-running the frozen gate on a real host's measured evidence yields a NON-NaN alias reason", () => {
  const row = R.rows.find((r) => r.host === "HD 39091");
  const base = p103.rows.find((h) => h.host === "HD 39091");
  const rec = p102.rows.find((h) => h.host === "HD 39091");
  assert.ok(row && base && rec);
  assert.ok(Math.abs(rec.recoveredPeriod - row.recoveredPeriod) < 1e-6, "recovered period agrees with p102");
  const g = evaluateDiscoveryGate({
    novelty: { inConfirmed: base.catalogKnown, inToi: base.catalogKnown, confirmedScanned: 5200, toiScanned: 4100 },
    corroboration: {
      crossSectorEphemerisCoherentSectors: base.coherentSectors, catalogDuplicate: base.catalogKnown,
      gaiaBlendRuledOut: false, psfOrDiffImagingClear: false, harmonicAliasFpp: row.aliasFpp,
      oddEvenAsymmetryFrac: base.oddEvenDiffFrac === null ? Number.NaN : base.oddEvenDiffFrac,
    },
    significance: { snr: base.stitchedSnr, ar1FalseAlarmProb: base.ar1Far }, prospective: null, signoff: null,
  }, proto);
  assert.equal(g.tier, "none");
  const aliasLine = g.unmet.find((u) => /alias/i.test(u));
  assert.ok(aliasLine, "alias bar still unmet on measured value");
  assert.ok(!/NaN/.test(aliasLine), `alias reason must be a measured number, not NaN: ${aliasLine}`);
});
