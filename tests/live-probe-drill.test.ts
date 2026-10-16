// audit-3 P1-B: the live-probe's failure mode, verified offline. The weekly workflow only alerts when
// p8-live-probe exits 1 on schema/row-count drift -- so "the probe exists" is not enough; the DETECTION
// logic must be proven to actually trip. These fixtures run the real judge functions (no network) and
// assert every drift class the probe claims to catch really produces a FAIL, and that evaluate() maps a
// single drift to the alert exit code the CI gates on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeNasa, judgeExofop, judgeGaia, evaluate, selfTest, type Check } from "../scripts/p8-live-probe.ts";

const GAIA_COLS = ["source_id", "ra", "dec", "phot_g_mean_mag", "parallax"];

test("NASA probe detects a dropped consumed column and a row-count collapse (healthy still passes)", () => {
  const good = Array.from({ length: 120 }, () => ({ pl_name: "b", hostname: "H", sy_tmag: 10, pl_orbper: 3 }));
  assert.equal(judgeNasa(good).ok, true);
  assert.equal(judgeNasa(Array.from({ length: 120 }, () => ({ pl_name: "b", hostname: "H", sy_tmag: 10 }))).ok, false);
  assert.equal(judgeNasa([{ pl_name: "b", hostname: "H", sy_tmag: 10, pl_orbper: 3 }]).ok, false);
});

test("ExoFOP probe detects a renamed header column (the exact upstream-drift scenario)", () => {
  const rows = Array.from({ length: 1200 }, () => "1,2,3,4").join("\n");
  assert.equal(judgeExofop(`TOI,TIC ID,TESS Disposition,other\n${rows}`).ok, true);
  assert.equal(judgeExofop(`TOI,TIC Number,TESS Disposition,other\n${rows}`).ok, false); // "TIC ID" renamed
});

test("Gaia probe detects rounded source_id, wrong shape, and an empty cone", () => {
  const ok = { metadata: GAIA_COLS.map((name) => ({ name })), data: [["123", 1, 2, 3, 4]] };
  assert.equal(judgeGaia(ok).ok, true);
  assert.equal(judgeGaia({ metadata: GAIA_COLS.map((name) => ({ name })), data: [[4.5e18, 1, 2, 3, 4]] }).ok, false);
  assert.equal(judgeGaia({ rows: [] }).ok, false);
  assert.equal(judgeGaia({ metadata: GAIA_COLS.map((name) => ({ name })), data: [] }).ok, false);
});

test("evaluate() alerts (exit 1) on a single drift, treats all-network as inconclusive (exit 2), healthy = 0", () => {
  const drift: Check[] = [
    { name: "nasa-exoplanet-archive", ok: true, detail: "ok" },
    { name: "gaia-tap", ok: false, detail: "missing columns: parallax" },
  ];
  assert.equal(evaluate(drift), 1);
  assert.equal(evaluate([0, 1, 2].map((i) => ({ name: `u${i}`, ok: false, detail: "network: down" }))), 2);
  assert.equal(evaluate([0, 1, 2].map((i) => ({ name: `u${i}`, ok: true, detail: "ok" }))), 0);
});

test("the built-in offline self-test drill passes (no drift class is silently missed)", () => {
  assert.equal(selfTest(), 0);
});
