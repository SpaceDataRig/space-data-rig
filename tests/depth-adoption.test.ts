// Depth adoption guard + the record's internal consistency (src/detect/depthAdoption.ts, the critic check it
// feeds). Audit b1, 2026-10-18, found by asking a third-party question of the live data: does every published
// number in this record describe the same transit?
//
// Measured on production before any fix: 84 of 90 findings carried `depthPpt` and `depthFrac` that disagreed --
// the same quantity in two units, because src/cf/workflow.ts replaced only one of them with the per-sector shape
// fit. The worst was KELT-24 b: box depth 6100 ppm, published depth 38 ppm, on a planet whose depth the
// catalogue knows independently. Its own quoted SNR (252.5 over 40 points) implies 153 ppm scatter against the
// box depth -- physical for TESS -- and 0.96 ppm against the published depth -- below the photon floor. So the
// record refuted itself, and the frontend card printed the refuted number.
//
// These tests pin the guard that refuses such an adoption, the pair staying in step, and the critic recording
// the relation without being allowed to move a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideDepthAdoption,
  applyDepthDecision,
  depthEstimatorRatio,
  detectionSnrOf,
  DEPTH_ADOPTION_MAX_FACTOR,
} from "../src/detect/depthAdoption.ts";
import { reviewCandidate } from "../src/critic/review.ts";
import { scienceProjection, type BundleManifest } from "../src/bundle/bundle.ts";
import type { TransitCandidate, ArchivePlanet } from "../src/core/types.ts";

/** KELT-24 b as it stood on the live rig when the audit found it. */
const BOX = 0.0061; // 6100 ppm -- what BLS measured and what the SNR was computed from
const BAD_FIT = 0.000038; // 38 ppm -- what the per-sector fit returned and the workflow published

function cand(over: Partial<TransitCandidate> = {}): TransitCandidate {
  return {
    targetId: "KELT-24 b",
    periodDays: 5.582222764393189,
    epochBjd: 2458684.761,
    durationHours: 4.3546,
    depthPpt: BOX * 1000,
    depthFrac: BOX,
    snr: 252.5,
    noiseSigmaFrac: 1.528e-4, // 152.8 ppm: the scatter that makes snr = depth/sigma*sqrt(nIn) close
    power: 1.18e-6,
    nPointsInTransit: 40,
    folded: [],
    ...over,
  };
}

test("an estimator that disagrees by two orders of magnitude is refused, and the gated depth survives", () => {
  const d = decideDepthAdoption(BOX, BAD_FIT);
  assert.equal(d.adopted, false);
  assert.equal(d.depthFrac, BOX, "refusing must not silently substitute anything");
  assert.equal(d.depthSource, "bls-box");
  assert.match(d.reason, /160\.5x/, d.reason);
  assert.match(d.reason, /beyond the 5x adoption bound/, d.reason);
});

test("a refinement that agrees is adopted, in both directions of disagreement", () => {
  const thinner = decideDepthAdoption(BOX, BOX / 2.2);
  assert.equal(thinner.adopted, true, "a shape fit 2.2x shallower is a refinement, not a different transit");
  assert.equal(thinner.depthSource, "per-sector-median");
  const thicker = decideDepthAdoption(BOX, BOX * 2.2);
  assert.equal(thicker.adopted, true);
  // The bound is symmetric: a fit that comes out 4x DEEPER is exactly as untrustworthy as one 4x shallower.
  assert.equal(decideDepthAdoption(BOX, BOX / 4).adopted, true);
  assert.equal(decideDepthAdoption(BOX, BOX / (DEPTH_ADOPTION_MAX_FACTOR + 0.01)).adopted, false);
});

test("an estimate that is not a number degrades to keeping the measured depth", () => {
  for (const junk of [null, undefined, NaN, 0, -1e-4, Infinity]) {
    const d = decideDepthAdoption(BOX, junk as number | null | undefined);
    assert.equal(d.adopted, false, `${String(junk)} cannot be adopted`);
    assert.equal(d.depthFrac, BOX);
    assert.match(d.reason, /no usable per-sector depth/, d.reason);
  }
});

test("applying a decision keeps the two depth representations in step -- the defect this exists for", () => {
  const c = cand();
  applyDepthDecision(c, decideDepthAdoption(c.depthFrac, BAD_FIT), BAD_FIT);
  assert.equal(c.depthPpt, c.depthFrac * 1000, "the pair may never again disagree about the same quantity");
  assert.equal(c.depthFrac, BOX);
  assert.equal(c.depthSource, "bls-box");
  assert.equal(c.perSectorDepthFrac, BAD_FIT, "the refused estimate stays visible instead of vanishing");

  const c2 = cand();
  applyDepthDecision(c2, decideDepthAdoption(c2.depthFrac, 0.0025), 0.0025);
  assert.equal(c2.depthFrac, 0.0025, "a fit 2.4x shallower is a refinement, and gets adopted");
  assert.equal(c2.depthPpt, 2.5);
  assert.equal(c2.depthSource, "per-sector-median");
  assert.ok(Math.abs(depthEstimatorRatio(c2)! - 0.0025 / BOX) < 1e-12, "the record keeps BOTH estimators, so the disagreement stays visible after adoption");
  assert.equal(c2.blsBoxDepthFrac, BOX, "an adopted refinement must not erase the depth that was gated on");
});

test("a non-positive BOX depth forfeits adoption entirely, even when the fit offers a positive number", () => {
  // Seen on the live rig minutes after the guard shipped (TOI-1487.01, 06:33Z): the BLS box landed on a BUMP, so
  // the measured depth was -104.92 ppm while the per-sector shape fit offered +46.16 ppm. The first version of
  // this module treated "no comparable box" as the safe branch and published the fitted value -- asserting a
  // transit the detector's own measurement denies. Absence of a comparison is not proof that adoption is safe.
  const BOX_BUMP = -1.0492e-4;
  const FIT = 4.616e-5;
  for (const box of [BOX_BUMP, 0, NaN, -Infinity]) {
    const d = decideDepthAdoption(box as number, FIT);
    assert.equal(d.adopted, false, `${String(box)} gives nothing to refine`);
    assert.equal(d.depthFrac, box, "the measured depth is kept verbatim, positive or not");
    assert.equal(d.depthSource, "bls-box");
    assert.match(d.reason, /did not measure a positive depth/, d.reason);
  }
  // And the pair the record publishes still has to agree with itself.
  const c = cand({ depthFrac: BOX_BUMP, depthPpt: BOX_BUMP * 1000 });
  applyDepthDecision(c, decideDepthAdoption(c.depthFrac, FIT), FIT);
  assert.equal(c.depthPpt, c.depthFrac * 1000);
  assert.equal(c.depthFrac, BOX_BUMP, "the fit is recorded, never substituted, when there is no positive box");
  assert.equal(c.perSectorDepthFrac, FIT, "what the estimator offered stays visible as the refused estimate");
});

test("depthEstimatorRatio stays silent when only one estimator exists", () => {
  assert.equal(depthEstimatorRatio(cand()), null, "a legacy or single-fit record must not read as a disagreement");
});

test("an adopted refinement re-prices the significance instead of inheriting the box's", () => {
  // The residue the 5x cap left behind, measured on the live rig at 06:34Z: TOI-1978.01 adopted a 2784 ppm depth
  // and kept quoting SNR 109, which on its own scatter is the significance of a 10287 ppm depth. All five
  // adoptions in the first hour after the guard shipped had the same mismatch -- 5 of 5, not a tail.
  const c = cand();
  const refined = 0.0025;
  applyDepthDecision(c, decideDepthAdoption(c.depthFrac, refined), refined);
  assert.equal(c.detectionSnr, 252.5, "the statistic the search gated on stays in the record");
  assert.ok(Math.abs(c.snr - 252.5 * (refined / BOX)) < 1e-9, `expected ${252.5 * (refined / BOX)}, got ${c.snr}`);
  // The published pair must be invertible by a reader holding only the published fields. The fixture's SNR and
  // scatter are rounded off the live record (252.5 / 152.8 ppm), so the round trip is checked relatively -- a
  // mismatch of the kind this guards against is a factor of 2.4, not a part in a thousand.
  const implied = (c.snr * (c.noiseSigmaFrac as number)) / Math.sqrt(c.nPointsInTransit);
  assert.ok(Math.abs(implied / c.depthFrac - 1) < 1e-3, `snr ${c.snr} implies ${implied}, published depth ${c.depthFrac}`);

  // A refusal changes neither number: nothing was republished, so nothing needs re-pricing.
  const kept = cand();
  applyDepthDecision(kept, decideDepthAdoption(kept.depthFrac, BAD_FIT), BAD_FIT);
  assert.equal(kept.snr, 252.5);
  assert.equal(kept.detectionSnr, 252.5, "no refinement means the two SNRs are one number");
});

test("the SNR floor stays in box units, so an adopted refinement moves no verdict", () => {
  // GJ 341 b as it stood at 06:4xZ: box 476 ppm at detection SNR 7.4, refined to 112 ppm (4.24x, inside the
  // bound, so adopted) -- whose own significance is 1.7. The >= 7 floor and the calibrated FAP ensemble are
  // distributions of the box statistic; re-pricing the published depth must not silently re-gate the detection.
  const sigma = (476e-6 / 7.4) * Math.sqrt(40);
  const c = cand({
    targetId: "GJ 341 b", periodDays: 8.0149803, depthFrac: 476e-6, depthPpt: 476e-3,
    snr: 7.4, noiseSigmaFrac: sigma, blsBoxDepthFrac: 476e-6, detectionSnr: 7.4, nPointsInTransit: 40,
  });
  const before = reviewOf(cand({ targetId: "GJ 341 b", periodDays: 8.0149803, depthFrac: 476e-6, depthPpt: 476e-3, snr: 7.4, noiseSigmaFrac: sigma, nPointsInTransit: 40 }));
  applyDepthDecision(c, decideDepthAdoption(476e-6, 112e-6), 112e-6);
  assert.equal(c.depthSource, "per-sector-median");
  assert.ok(Math.abs(c.snr - 7.4 * (112 / 476)) < 1e-9, `published SNR should be 1.74, got ${c.snr}`);
  const after = reviewOf(c);
  assert.equal(after.verdict, before.verdict, "the gate reads the detection statistic, so the verdict does not move");
  const snrCheck = after.checks?.find((k) => k.name === "snr");
  assert.ok(snrCheck?.pass, "7.4 on the box is still above the floor");
  assert.match(snrCheck!.detail, /detection SNR 7\.4 on the box depth \(need >= 7\)/, snrCheck!.detail);
  assert.match(snrCheck!.detail, /112 ppm depth carries SNR 1\.7/, snrCheck!.detail);
  assert.ok(
    !after.checks?.some((k) => k.name.startsWith("depth-vs-significance")),
    "a re-priced record must no longer accuse itself -- this is the regression this test exists for",
  );
});

test("a record that predates the split is read exactly as before", () => {
  // detectionSnr is absent on every record written before this landed; the gate must fall back to `snr`, which on
  // such a record IS the box statistic. No legacy candidate gains or loses a verdict from the new field.
  const legacy = cand();
  assert.equal(legacy.detectionSnr, undefined);
  assert.equal(detectionSnrOf(legacy), 252.5);
});

// ---- the critic records the relation and is not allowed to act on it ----

const catalog: ArchivePlanet[] = [{ pl_name: "KELT-24 b", hostname: "KELT-24 b", pl_orbper: 5.55149296 }];
const reviewOf = (c: TransitCandidate) => reviewCandidate({ candidate: c, aliasMultiple: 1, catalog });

test("a record whose significance describes a different depth says so, without the verdict moving", () => {
  const inconsistent = cand({ depthFrac: BAD_FIT, depthPpt: BAD_FIT * 1000, depthSource: "per-sector-median", perSectorDepthFrac: BAD_FIT });
  const plain = cand();
  const a = reviewOf(inconsistent);
  const b = reviewOf(plain);
  const check = a.checks?.find((k) => k.name === "depth-vs-significance-consistency (informational, non-gating)");
  assert.ok(check, "the mismatch must be recorded");
  assert.equal(check!.pass, false);
  assert.match(check!.detail, /6100 ppm/, check!.detail);
  assert.match(check!.detail, /38 ppm/, check!.detail);
  assert.equal(a.verdict, b.verdict, "an informational check must not change a verdict");
  assert.equal(a.score, b.score, "nor the evidence score");
});

test("a consistent record carries no such accusation", () => {
  const r = reviewOf(cand());
  assert.ok(!r.checks?.some((k) => k.name.startsWith("depth-vs-significance-consistency")), "no false alarm");
});

test("the new check is excluded from the science projection, so already-anchored science is unchanged", () => {
  // Same escape hatch the boundary check uses: scienceProjection drops checks whose name carries "non-gating",
  // so recording a fact about reporting cannot re-price science that is already anchored.
  const bad = cand({ depthFrac: BAD_FIT, depthPpt: BAD_FIT * 1000, depthSource: "per-sector-median", perSectorDepthFrac: BAD_FIT });
  const manifest = {
    schema: "space-data-rig/bundle@1",
    findingId: "F-KELT-24-b",
    targetId: "KELT-24 b",
    createdAt: "2026-10-18T03:05:27.130Z",
    runId: "run-1",
    codeVersion: "v1",
    candidate: {
      periodDays: bad.periodDays, epochBjd: bad.epochBjd, durationHours: bad.durationHours,
      depthPpt: bad.depthPpt, depthFrac: bad.depthFrac, snr: bad.snr, power: bad.power,
      nPointsInTransit: bad.nPointsInTransit,
    },
    verdict: "needs-more-data" as const,
    verdictReason: "test fixture",
    crossmatch: { matchedKnownPlanet: true },
    checks: reviewOf(bad).checks,
    dataProvenance: {},
  } as unknown as BundleManifest;
  const projected = JSON.stringify(scienceProjection(manifest));
  assert.ok(manifest.checks!.some((c) => c.name.startsWith("depth-vs-significance")), "the check exists to be filtered");
  assert.ok(!projected.includes("depth-vs-significance-consistency"), "the informational check must not enter the hashed science");
  assert.ok(!projected.includes("non-gating"), projected.slice(0, 300));
});
