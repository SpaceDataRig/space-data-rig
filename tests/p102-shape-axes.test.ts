// R36: p102 measures the odd/even + harmonic-sibling SHAPE axes for real on the committed curves and retires the NaN
// stand-in on odd/even. This test pins that the measurement is real, self-consistent, honest (red lines false) and
// NON-VACUOUS -- the shape axis must both PASS and FAIL some real hosts (otherwise it discriminates nothing), and the
// representative host's measured odd/even value must actually flow into the gate (a passing value must disappear from
// the gate's unmet list, proving the gate consumed the real number rather than a placeholder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p102-shape-axes-real.json"), "utf8"));
const rows = R.rows as { host: string; snr: number; recoveredPeriod: number; oddEvenDetermined: boolean; oddEvenDiffFrac: number; oddEvenPass: boolean; aliasSiblings: number; catalogKnown: boolean }[];

test("p102 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("the gate refuses the representative (tier none, claim not allowed)", () => {
  assert.ok(R.gateStrongest, "gateStrongest present");
  assert.equal(R.gateStrongest.tier, "none");
  assert.equal(R.gateStrongest.discoveryClaimAllowed, false);
});

test("published aggregates are exactly re-derivable from the per-host rows", () => {
  assert.equal(R.nHosts, rows.length);
  assert.equal(R.oddEvenDeterminable, rows.filter((r) => r.oddEvenDetermined).length);
  assert.equal(R.oddEvenPass, rows.filter((r) => r.oddEvenPass).length);
  assert.equal(R.oddEvenFailShape, rows.filter((r) => r.oddEvenDetermined && !r.oddEvenPass).length);
  assert.equal(R.hostsWithHarmonicSiblings, rows.filter((r) => r.aliasSiblings > 0).length);
});

test("the shape axis genuinely discriminates on real photometry (not a rubber stamp)", () => {
  assert.ok(R.oddEvenDeterminable >= 2, "odd/even determinable on several real curves");
  // some real hosts clear the asymmetry bar...
  assert.ok(R.oddEvenPass >= 1, "at least one real host passes the shape bar");
  // ...and some genuinely fail it, so the measured value is doing work, not always-true.
  assert.ok(R.oddEvenFailShape >= 1, "at least one real host fails the shape bar (axis discriminates)");
});

test("the representative is a DETERMINED host and its real odd/even value flowed into the gate", () => {
  const s = R.strongestHost;
  assert.ok(s, "representative present");
  assert.equal(s.oddEvenDetermined, true, "representative must have a determinable shape test");
  assert.ok(Number.isFinite(s.oddEvenDiffFrac), "representative odd/even is a real number, not NaN");
  // If it passes the bar, no unmet line may complain about odd/even -- proving the gate consumed the measured value.
  if (s.oddEvenPass) {
    assert.ok(!R.gateStrongest.unmet.some((u: string) => /odd\/even/i.test(u)), "a passing measured odd/even must not appear as unmet");
  }
});

test("every row is a sane detrended real measurement", () => {
  for (const r of rows) {
    assert.ok(r.snr > 0, `${r.host}: non-positive SNR`);
    assert.ok(r.recoveredPeriod > 0, `${r.host}: non-positive period`);
    if (r.oddEvenDetermined) assert.ok(Number.isFinite(r.oddEvenDiffFrac), `${r.host}: determined but NaN frac`);
  }
});

test("the protocol odd/even bar is the frozen 0.2 (pinned, not silently loosened)", () => {
  assert.equal(R.maxOddEvenAsymmetryFrac, 0.2);
});
