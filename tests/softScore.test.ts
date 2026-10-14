import { test } from "node:test";
import assert from "node:assert/strict";
import { blendLikelihood, falseVetoAtThreshold, type SoftVetoCase } from "../src/candidate/softScore.ts";
import { reviewCandidate } from "../src/critic/review.ts";
import type { TransitCandidate } from "../src/core/types.ts";
import type { ReviewInput } from "../src/critic/review.ts";

function cand(): TransitCandidate {
  return { targetId: "t", periodDays: 3, epochBjd: 2457000, durationHours: 2, depthPpt: 1, depthFrac: 0.001, snr: 12, power: 9, nPointsInTransit: 8 };
}

// ---- blendLikelihood: continuous, monotonic, ignores absent/non-finite signals ----
test("blendLikelihood is undetermined with no signals", () => {
  const r = blendLikelihood({});
  assert.equal(r.determined, false);
  assert.equal(Number.isFinite(r.score), false);
  assert.equal(r.nSignals, 0);
});

test("blendLikelihood maps psf offset to a 0..1 risk (saturates at the reference)", () => {
  assert.equal(blendLikelihood({ psfOffsetArcsec: 0 }).score, 0);
  assert.equal(blendLikelihood({ psfOffsetArcsec: 8 }).score, 1); // >= 4" reference -> fully blend-like
  const lo = blendLikelihood({ psfOffsetArcsec: 1 }).score;
  const hi = blendLikelihood({ psfOffsetArcsec: 3 }).score;
  assert.ok(lo < hi, "monotonic in offset");
});

test("blendLikelihood maps dilution factor: low host fraction = blend-like", () => {
  const d = blendLikelihood({ dilutionFactor: 0.42 });
  assert.ok(Math.abs(d.score - 0.58) < 1e-9, `expected ~0.58 got ${d.score}`); // 1 - 0.42
  assert.equal(blendLikelihood({ dilutionFactor: 1 }).score, 0);
});

test("blendLikelihood averages available signals and ignores NaN", () => {
  const r = blendLikelihood({ psfOffsetArcsec: NaN, dilutionFactor: 0.5 });
  assert.equal(r.nSignals, 1);
  assert.equal(r.score, 0.5);
  const two = blendLikelihood({ centroidShiftArcsec: 2, dilutionFactor: 1 }); // risk 1 and risk 0 -> mean 0.5
  assert.equal(two.nSignals, 2);
  assert.equal(two.score, 0.5);
});

// ---- falseVetoAtThreshold: publishes the honest cost (how many known planets it wrongly flags) ----
test("falseVetoAtThreshold counts false-vetoes on planets and catches on blends", () => {
  const cases: SoftVetoCase[] = [
    { isBlend: false, score: 0.1 }, // planet kept
    { isBlend: false, score: 0.6 }, // planet FALSE-VETOED
    { isBlend: true, score: 0.7 }, // blend caught
    { isBlend: true, score: 0.2 }, // blend missed
    { isBlend: true, score: NaN },  // ignored
  ];
  const m = falseVetoAtThreshold(cases, 0.5);
  assert.equal(m.nPlanets, 2);
  assert.equal(m.falseKills, 1);
  assert.equal(m.falseVetoRate, 0.5);
  assert.equal(m.nBlends, 2);
  assert.equal(m.caughtBlends, 1);
  assert.equal(m.blendCatchRate, 0.5);
});

// ---- critic: the soft score is an ADVISORY weight, it NEVER flips the verdict ----
test("critic: absent blendScore leaves the review identical (no soft check)", () => {
  const input: ReviewInput = { candidate: cand(), aliasMultiple: 1, catalog: [], nTransitsObserved: 4, vetting: { centroidShiftArcsec: 0.2 } };
  const r = reviewCandidate(input);
  assert.equal(r.checks.some((c) => c.name.includes("blend-likelihood")), false);
});

test("critic: blendScore changes ranking score but NEVER the verdict", () => {
  const mk = (blendScore?: number): ReviewInput => ({
    candidate: cand(), aliasMultiple: 1, catalog: [], nTransitsObserved: 4,
    vetting: { centroidShiftArcsec: 0.2, ...(blendScore != null ? { blendScore } : {}) },
  });
  const no = reviewCandidate(mk());
  const low = reviewCandidate(mk(0));
  const high = reviewCandidate(mk(1));
  // verdict is byte-identical across all three (the soft score never gates)
  assert.equal(low.verdict, no.verdict);
  assert.equal(high.verdict, no.verdict);
  // a fully blend-like score downweights the ranking score vs a clean one
  assert.ok(high.score <= low.score, `expected ${high.score} <= ${low.score}`);
  assert.ok(low.checks.some((c) => c.name.includes("blend-likelihood")));
  // with blendScore = 0 the score is unchanged from the undefined case (0 * weight = no effect)
  assert.equal(low.score, no.score);
});

test("critic: a soft blend-likelihood can never, on its own, produce a rejection", () => {
  // even a clean candidate with a maximal blend-likelihood stays non-rejected by that field alone
  const r = reviewCandidate({ candidate: cand(), aliasMultiple: 1, catalog: [], nTransitsObserved: 4, vetting: { blendScore: 1 } });
  assert.notEqual(r.verdict, "rejected");
});
