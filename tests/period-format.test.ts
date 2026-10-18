// src/core/periodFormat.ts exists because the rig published "P=16.00d" for a period that was a discrete BLS grid
// node. The node spacing grows as P^2, so at long periods those two decimal places were not measured precision.
// These tests pin the arithmetic, not merely the presence of the functions: a formatter that quietly returns the
// legacy two-decimal string would re-introduce the exact over-claim while every test still passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLS_DEFAULT_OVERSAMPLE,
  MIN_SECTOR_BASELINE_DAYS,
  conservativeResolutionDays,
  decimalsFor,
  formatPeriodDaysWithUnit,
  gridPeriodResolutionDays,
  oneSigFig,
  renderPeriodDays,
} from "../src/core/periodFormat.ts";

test("grid resolution scales as P^2, which is why a fixed number of decimals cannot be right for every period", () => {
  const at2 = gridPeriodResolutionDays(2, 27);
  const at16 = gridPeriodResolutionDays(16, 27);
  assert.equal(at2, 4 / (BLS_DEFAULT_OVERSAMPLE * 27));
  assert.equal(at16, 256 / (BLS_DEFAULT_OVERSAMPLE * 27));
  // 16^2 / 2^2 = 64x coarser. A formatter that printed both to 0.01 d is lying about one of them.
  assert.ok(Math.abs(at16 / at2 - 64) < 1e-9, `expected a 64x ratio, got ${(at16 / at2).toFixed(3)}`);
  assert.ok(at16 > 1, "the 16-day node on a single sector is more than a day apart, the number the feed printed");
});

test("the conservative bound assumes the SHORTEST plausible baseline, so it can only ever under-claim precision", () => {
  const conservative = conservativeResolutionDays(16);
  const optimistic = gridPeriodResolutionDays(16, 400); // a long multi-sector baseline resolves far better
  assert.equal(conservative, gridPeriodResolutionDays(16, MIN_SECTOR_BASELINE_DAYS));
  assert.ok(conservative > optimistic, "assuming a short baseline must give a LARGER uncertainty");
  // A larger uncertainty must yield AT MOST as many decimal places -- decimalsFor is non-increasing in u, so the
  // conservative bound can only ever quote fewer digits than the real one would support.
  assert.ok(
    decimalsFor(conservative) <= decimalsFor(optimistic),
    `the conservative bound must not quote MORE digits than the real one: ${decimalsFor(conservative)} vs ${decimalsFor(optimistic)}`,
  );
  assert.ok(decimalsFor(conservative) < decimalsFor(optimistic), "and here it genuinely is coarser");
});

test("oneSigFig and decimalsFor implement the usual uncertainty convention", () => {
  assert.equal(oneSigFig(1.19), 1);
  assert.equal(oneSigFig(0.0178), 0.02);
  assert.equal(oneSigFig(0.5), 0.5);
  assert.ok(Number.isNaN(oneSigFig(0)) && Number.isNaN(oneSigFig(NaN)) && Number.isNaN(oneSigFig(-3)));
  assert.equal(decimalsFor(1), 0);
  assert.equal(decimalsFor(0.02), 2);
  assert.equal(decimalsFor(0.5), 1);
  assert.equal(decimalsFor(0.0004), 4, "clamped at four places rather than running away");
});

test("a period is rendered to the digits its grid actually resolved", () => {
  // The case that shipped: a node at exactly 16 d on a ~27 d baseline.
  const long = renderPeriodDays(16, gridPeriodResolutionDays(16, 27));
  assert.equal(long.value, "16", "no decimal places may be claimed where the grid step exceeds 1 day");
  assert.equal(long.uncertainty, "1");
  assert.equal(long.text, "16 +/- 1");
  assert.equal(formatPeriodDaysWithUnit(16, gridPeriodResolutionDays(16, 27)), "16 +/- 1 d");

  // A short period genuinely does resolve to hundredths, and must keep them.
  const short = renderPeriodDays(1.956772524382509, gridPeriodResolutionDays(1.956772524382509, 27));
  assert.equal(short.value, "1.96");
  assert.equal(short.text, "1.96 +/- 0.02");
});

test("suppressing the uncertainty still suppresses the digits, not just the term", () => {
  const r = renderPeriodDays(16, gridPeriodResolutionDays(16, 27), false);
  assert.equal(r.text, "16", "a headline that says '16-day signal' must not silently be '16.00-day signal'");
  assert.ok(!r.text.includes("+/-"), "the +/- term is what was asked to be left out");
  assert.equal(r.uncertainty, "1", "but the bound stays available for a caller that wants to state it elsewhere");
});

test("a record with no resolution falls back to the conservative bound rather than to two decimals", () => {
  const r = renderPeriodDays(16, undefined);
  assert.equal(r.value, "16", "the legacy toFixed(2) behaviour is exactly what must not come back");
  const r2 = renderPeriodDays(16, NaN);
  assert.equal(r2.value, "16");
  const r3 = renderPeriodDays(1.956772524382509, undefined);
  assert.equal(r3.value, "1.96", "short periods still keep their real precision under the same bound");
});

test("a nonsense period renders as a question mark instead of a confident number", () => {
  for (const bad of [NaN, Infinity, -1, 0]) {
    const r = renderPeriodDays(bad, 1);
    assert.equal(r.text, "?", `period ${bad} must not produce a number`);
  }
});

test("every rendered string is pure ASCII, because scripts/post-x-text.ts refuses any other byte", () => {
  for (const p of [0.83, 1.96, 16, 123.456]) {
    for (const res of [undefined, 0.001, 1.2, NaN]) {
      const t = formatPeriodDaysWithUnit(p, res);
      assert.ok(!/[^\x00-\x7F]/.test(t), `non-ASCII in "${t}" would make the whole post be refused`);
      // Written as an escape so this file stays ASCII-clean like everything else in the repository.
      assert.ok(!t.includes("\u00b1"), "the Unicode plus-minus is not sendable; the ASCII form is");
    }
  }
});
