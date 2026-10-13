// Offline proof that common-mode removal strips a SHARED instrumental signal but PRESERVES a
// single star's transit -- the load-bearing property that makes it a false-positive lever rather
// than a signal destroyer. Deterministic synthetic ensembles; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { removeCommonMode, commonModeTemplate } from "../src/detect/commonMode.ts";
import type { LightCurve } from "../src/core/types.ts";

const N = 40; // cadences
const DT = 0.02; // ~28.8 min, comfortably above the default 0.0005 d bin tolerance
const T0 = 2458000;

/** A flat star with tiny deterministic noise (~+-50 ppm) so a shared dip clearly dominates. */
function flatStar(id: string, n = N): LightCurve {
  const seed = id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const points = [];
  for (let k = 0; k < n; k++) {
    const noise = (((seed * 31 + k * 7) % 13) - 6) * 1e-5; // ~+-60 ppm, deterministic
    points.push({ time: T0 + k * DT, flux: 1 + noise });
  }
  return { targetId: id, mission: "synthetic", cadenceSec: 1728, points };
}

function ensemble(n: number): LightCurve[] {
  return Array.from({ length: n }, (_, i) => flatStar(`STAR-${i}`));
}

function fluxAt(lc: LightCurve, k: number): number {
  return lc.points[k]!.flux;
}

// 1. A dip shared by EVERY star at the same cadences is a coherent instrumental artifact: the template
//    should absorb it and the corrected curves should return to flat.
test("removeCommonMode strips an ensemble-wide shared dip", () => {
  const lcs = ensemble(10);
  for (const lc of lcs) for (const k of [10, 11, 12]) lc.points[k]!.flux -= 0.02; // 20000 ppm shared dip

  const r = removeCommonMode(lcs);
  assert.equal(r.applied, true, "10-star ensemble should be applied");
  assert.ok(r.maxAbsTemplatePpm > 15000, `template should capture the ~20000 ppm dip, got ${r.maxAbsTemplatePpm.toFixed(0)}`);

  for (const lc of r.curves) {
    for (const k of [10, 11, 12]) {
      assert.ok(Math.abs(fluxAt(lc, k) - 1) < 1e-3, `shared dip should be gone at cadence ${k}, got ${fluxAt(lc, k).toFixed(5)}`);
    }
  }
});

// 2. A transit on ONE star is a minority signal: the median across the ensemble must NOT absorb it, so the
//    dip survives removal while the other stars stay flat. This is the property that keeps completeness intact.
test("removeCommonMode preserves a single star's transit", () => {
  const lcs = ensemble(10);
  const target = 3;
  for (const k of [20, 21, 22]) lcs[target]!.points[k]!.flux -= 0.01; // 10000 ppm on ONE star only

  const r = removeCommonMode(lcs);
  assert.equal(r.applied, true);
  assert.ok(r.maxAbsTemplatePpm < 1000, `template must NOT absorb a lone transit, got ${r.maxAbsTemplatePpm.toFixed(0)} ppm`);

  for (const k of [20, 21, 22]) {
    assert.ok(Math.abs(fluxAt(r.curves[target]!, k) - 0.99) < 1e-3, `transit must survive at cadence ${k}, got ${fluxAt(r.curves[target]!, k).toFixed(5)}`);
  }
  // an unrelated star stays flat at those cadences
  assert.ok(Math.abs(fluxAt(r.curves[0]!, 21) - 1) < 1e-3);
});

// 3. Below minStars there is no reliable common mode: the transform must be an EXACT no-op, never a partial
//    correction that could silently distort a small ensemble.
test("removeCommonMode is an exact no-op below minStars", () => {
  const lcs = ensemble(3);
  for (const lc of lcs) for (const k of [10, 11, 12]) lc.points[k]!.flux -= 0.02;
  const before = lcs.map((lc) => lc.points.map((p) => p.flux));

  const r = removeCommonMode(lcs);
  assert.equal(r.applied, false, "3 stars < minStars(8) must not be applied");
  assert.equal(r.nBins, 0);
  for (let s = 0; s < lcs.length; s++) {
    for (let k = 0; k < N; k++) assert.equal(r.curves[s]!.points[k]!.flux, before[s]![k], "no-op must be byte-identical");
  }
});

// 4. Determinism: the same ensemble yields identical corrected fluxes run to run (the guarantee the money
//    path relies on for every pure module).
test("removeCommonMode is deterministic", () => {
  const mk = () => {
    const lcs = ensemble(8);
    for (const lc of lcs) for (const k of [5, 6]) lc.points[k]!.flux -= 0.015;
    return lcs;
  };
  const a = removeCommonMode(mk()).curves;
  const b = removeCommonMode(mk()).curves;
  for (let s = 0; s < a.length; s++) {
    for (let k = 0; k < N; k++) assert.equal(a[s]!.points[k]!.flux, b[s]!.points[k]!.flux);
  }
});

// 5. commonModeTemplate reports one trusted bin per shared cadence with the full ensemble count, and stays
//    empty (applied=false) for a too-small ensemble -- so a caller can inspect what would be removed.
test("commonModeTemplate reports trusted bins and ensemble size", () => {
  const lcs = ensemble(10);
  for (const lc of lcs) for (const k of [10, 11, 12]) lc.points[k]!.flux -= 0.02;
  const t = commonModeTemplate(lcs);
  assert.equal(t.applied, true);
  assert.equal(t.nStars, 10);
  assert.ok(t.bins.length >= 3, `expected >=3 trusted bins, got ${t.bins.length}`);
  for (const b of t.bins) assert.ok(b.nStars >= 5 && Number.isFinite(b.value), `bin ${JSON.stringify(b)}`);

  const small = commonModeTemplate(ensemble(3));
  assert.equal(small.applied, false);
  assert.equal(small.bins.length, 0);
});

// 6. SPIKE-GATE: removing only anomalously large shared excursions still kills a big ensemble-wide dip but
//    leaves a typical cadence EXACTLY untouched -- so it does not stamp template-estimation noise onto every
//    point, which is the completeness cost the full subtraction showed on real sector-1 data (p31).
test("spike-gated common-mode removes a big shared dip but leaves typical cadences untouched", () => {
  const lcs = ensemble(12);
  for (const lc of lcs) for (const k of [10, 11, 12]) lc.points[k]!.flux -= 0.02; // 20000 ppm shared dip
  const beforeK5 = lcs[0]!.points[5]!.flux;

  const gated = removeCommonMode(lcs, { spikeGateSigma: 3 });
  assert.equal(gated.applied, true);
  for (const lc of gated.curves) {
    for (const k of [10, 11, 12]) assert.ok(Math.abs(fluxAt(lc, k) - 1) < 2e-3, `big dip should be gone at ${k}, got ${fluxAt(lc, k).toFixed(5)}`);
  }
  // a typical cadence is left EXACTLY as it was (its template value is below the gate -> zero correction)
  assert.equal(gated.curves[0]!.points[5]!.flux, beforeK5, "spike-gate must not touch a typical cadence");

  // the gate zeroes the small typical-cadence template values the full subtraction would otherwise apply
  const nz = (t: { bins: { value: number }[] }) => t.bins.filter((b) => Math.abs(b.value) > 0).length;
  const fullT = commonModeTemplate(lcs);
  const gatedT = commonModeTemplate(lcs, { spikeGateSigma: 3 });
  assert.ok(nz(gatedT) < nz(fullT), `spike-gate should zero typical-cadence template values (${nz(gatedT)} nonzero vs full ${nz(fullT)})`);
  assert.ok(nz(gatedT) >= 3, "the three dip cadences must survive the gate");
});
