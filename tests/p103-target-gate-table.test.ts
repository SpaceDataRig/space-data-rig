// R37: p103 joins the real per-target axes (cross-sector from p101, odd/even from p102) into ONE earned-gate decision
// table and MEASURES the last missing axis -- a per-target AR(1) significance FAR from a null ensemble matched to each
// committed curve's own noise -- retiring the significance-FAP NaN stand-in. This test pins: red lines false; the gate
// refuses every target (all tier none) for the RIGHT reasons (each blocked by novelty + unmeasured blend, not by the now
// passing significance/shape axes); every published aggregate is exactly re-derivable from the rows; the significance FAR
// is genuinely measured (finite, in [0,1], clears for some targets); and the joined cross-sector / shape axes actually
// discriminate (some pass, some fail) so the table is not a rubber stamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p103-target-gate-table.json"), "utf8"));
const rows = R.rows as {
  host: string; coherentSectors: number; stitchedSnr: number; ar1Far: number; oddEvenDiffFrac: number | null;
  significanceClears: boolean; crossSectorClears: boolean; oddEvenClears: boolean; catalogKnown: boolean;
  gateTier: string; unmet: string[];
}[];
const N = rows.length;

test("p103 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the gate refuses EVERY real target (all tier none) -- no claim leaks through", () => {
  assert.ok(N >= 2, "table is non-empty");
  for (const r of rows) assert.equal(r.gateTier, "none", `${r.host}: must not clear the gate`);
  assert.equal(R.tierNoneCount, N);
});

test("published aggregates are exactly re-derivable from the per-target rows", () => {
  assert.equal(R.nTargets, N);
  assert.equal(R.significanceClears, rows.filter((r) => r.significanceClears).length);
  assert.equal(R.crossSectorClears, rows.filter((r) => r.crossSectorClears).length);
  assert.equal(R.oddEvenClears, rows.filter((r) => r.oddEvenClears).length);
  assert.equal(R.notNovelCount, rows.filter((r) => r.unmet.some((u) => /novel|known|duplicate/i.test(u))).length);
  assert.equal(R.blendUnmeasuredCount, rows.filter((r) => r.unmet.some((u) => /blend/i.test(u))).length);
});

test("the significance FAR is genuinely MEASURED per target (NaN stand-in retired)", () => {
  for (const r of rows) {
    assert.ok(Number.isFinite(r.ar1Far), `${r.host}: AR(1) FAR must be a real number, not the old NaN stand-in`);
    assert.ok(r.ar1Far >= 0 && r.ar1Far <= 1, `${r.host}: FAR must be a probability in [0,1]`);
    assert.ok(r.stitchedSnr > 0, `${r.host}: SNR must be a positive real measurement`);
  }
  // clears requires BOTH a strong SNR and a low FAR on the same real curve -> non-trivial when it happens
  assert.ok(R.significanceClears >= 1, "at least one real target clears the measured significance bar");
  for (const r of rows.filter((x) => x.significanceClears)) {
    assert.ok(r.stitchedSnr >= 7 && r.ar1Far <= 0.001, `${r.host}: significanceClears inconsistent with frozen bars`);
  }
});

test("the joined cross-sector and shape axes DISCRIMINATE (not uniform -> table does real work)", () => {
  assert.ok(R.crossSectorClears >= 1 && R.crossSectorClears < N, "cross-sector clears for some but not all real targets");
  assert.ok(R.oddEvenClears >= 1 && R.oddEvenClears < N, "odd/even shape clears for some but not all real targets");
});

test("each refusal is honest: blocked by novelty + unmeasured blend, never silently dropped", () => {
  for (const r of rows) {
    assert.ok(r.catalogKnown, `${r.host}: a committed SPOC target is a known-planet system`);
    assert.ok(r.unmet.length >= 1, `${r.host}: a tier-none refusal must list which bars were unmet`);
    assert.ok(r.unmet.some((u) => /novel|known|duplicate/i.test(u)), `${r.host}: must be unmet on novelty (already known)`);
    assert.ok(r.unmet.some((u) => /blend/i.test(u)), `${r.host}: must be unmet on the unmeasured blend axis`);
  }
});

test("a measured odd/even value that PASSES must not reappear as an unmet bar (gate consumed the real number)", () => {
  const passers = rows.filter((r) => r.oddEvenClears);
  assert.ok(passers.length >= 1, "at least one target has a real passing odd/even value");
  for (const r of passers) {
    assert.ok(!r.unmet.some((u) => /odd\/even/i.test(u)), `${r.host}: a passing measured odd/even must not appear as unmet`);
  }
});
