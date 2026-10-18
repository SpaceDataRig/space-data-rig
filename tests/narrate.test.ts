// Offline tests for the reporter narration's honesty labels (audit #3 + #4).
// Pure string rendering on a hand-built Finding; no network, no model, no pipeline run.
// These lock the two red lines the audit flagged as a self-imposed-rule gap:
//   (a) a user-facing headline/badge must NOT over-claim ("Confirmed: a planet") and MUST say
//       whether its photons are real TESS photometry or a reproducible stand-in (both branches);
//   (b) the recovery number must be shown with its sample size + binomial CI and framed as a
//       CONDITIONAL targeted re-injection, not blind-search capability.
import { test } from "node:test";
import assert from "node:assert/strict";

import { narrateFinding, verdictBadge } from "../src/reporter/narrate.ts";
import type { Finding } from "../src/core/types.ts";

function mkFinding(o: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    targetId: "TIC 999",
    candidate: {
      targetId: "TIC 999",
      periodDays: 6.26,
      epochBjd: 2458000,
      durationHours: 3,
      depthPpt: 0.5,
      depthFrac: 5e-4,
      snr: 12,
      power: 1.1,
      nPointsInTransit: 8,
    },
    verdict: "accepted",
    verdictReason: "blind evidence passed",
    crossmatch: { matchedKnownPlanet: true, knownPlanetName: "pi Men c", knownPeriodDays: 6.26, periodDeltaPct: 0.3 },
    createdAt: "2026-01-01T00:00:00Z",
    ...o,
  } as Finding;
}

test("accepted badge label is RECOVERED, not CONFIRMED (no discovery-grade claim)", () => {
  assert.equal(verdictBadge("accepted").label, "RECOVERED");
  assert.notEqual(verdictBadge("accepted").label, "CONFIRMED");
});

test("headline labels REAL photometry and never says 'Confirmed: a planet'", () => {
  const n = narrateFinding(mkFinding(), { lightCurveSource: "stitched 2 TESS-SPOC sector(s), span 54.1 d (REAL photometry)" });
  assert.match(n.headline, /^\[real TESS photometry\]/);
  assert.doesNotMatch(n.headline, /Confirmed/);
  assert.doesNotMatch(n.headline, /a planet orbiting/);
});

test("headline labels a stand-in curve, and BOTH branches are covered (never hardcoded)", () => {
  const sim = narrateFinding(mkFinding(), { lightCurveSource: "seeded reproducible stand-in" });
  assert.match(sim.headline, /^\[stand-in synthetic curve\]/);
  const real = narrateFinding(mkFinding(), { lightCurveSource: "real photometry here" });
  assert.match(real.headline, /^\[real TESS photometry\]/);
});

test("recovery is shown with sample size + Wilson CI and framed as conditional, not blind capability", () => {
  const f = mkFinding({ recoveryConfidence: 0.5, recoveryTrials: { nTrials: 8, nRecovered: 4 } });
  const n = narrateFinding(f);
  assert.match(n.explainer, /4\/8 trials/);
  assert.match(n.explainer, /Wilson CI/);
  assert.match(n.explainer, /NOT the pipeline's blind-search capability/);
  assert.match(n.stats["Recovery confidence"], /\(4\/8,/);
  assert.match(n.stats["Recovery confidence"], /CI\)/);
});

test("recovery falls back gracefully when trial counts are absent", () => {
  const n = narrateFinding(mkFinding({ recoveryConfidence: 1, recoveryTrials: undefined }));
  assert.equal(n.stats["Recovery confidence"], "100%");
  assert.match(n.explainer, /about 100% of the time/);
});

// ---- audit pass 4 (2026-10-18): the sentence that was false about the sky ----
//
// HOW THIS GOT WRITTEN WRONG ONCE, RECORDED SO THE NEXT READER KNOWS. I first searched for tests of this module
// with the glob `tests/*.ts` from the WORKSPACE root. The repository lives a level below the root, so the glob
// matched nothing and I concluded the prose layer was untested -- then overwrote this file. `git restore` undid it,
// and the five tests above are the original ones. The lesson is not "be careful", it is that a search which cannot
// find a file is not evidence that the file is absent: state the scope of a negative result or do not draw it.
//
// What the audit found is a live defect the existing tests could not have caught, because they fixed the labels and
// the provenance but not the dip/brightening branch. The BLS box statistic is squared (`Swy^2/(Sw(1-Sw))`,
// src/detect/bls.ts), so a periodic BRIGHTENING can win the period grid while `depth` and `snr` keep the sign. Such
// a record is rejected by the critic and stays published, which is right; what was wrong is that the prose written
// over it read "the star's brightness dips by about -105 parts per million ... the fingerprint of a planet crossing
// (transiting) the star" -- a transit that was never measured, asserted in the sentence a human actually reads.
import type { TransitCandidate } from "../src/core/types.ts";
import { narrateRunSummary } from "../src/reporter/narrate.ts";

function cand(over: Partial<TransitCandidate> = {}): TransitCandidate {
  return {
    targetId: "TOI-0001.01",
    periodDays: 3.1415,
    epochBjd: 2459000.5,
    durationHours: 2.5,
    depthPpt: 1.2,
    depthFrac: 1.2e-3,
    snr: 14.2,
    power: 1e-6,
    noiseSigmaFrac: 1.3e-3,
    nPointsInTransit: 24,
    folded: [],
    ...over,
  };
}

function found(c: TransitCandidate, over: Partial<Finding> = {}): Finding {
  return {
    id: "F-TOI-0001-01",
    targetId: c.targetId,
    candidate: c,
    verdict: "needs-more-data",
    verdictReason: "Significant, physically-consistent transit with no catalog match.",
    crossmatch: { matchedKnownPlanet: false },
    recoveryConfidence: 1,
    recoveryTrials: { nTrials: 8, nRecovered: 8 },
    createdAt: "2026-10-18T07:00:00.000Z",
    ...over,
  } as Finding;
}

const REAL = "TESS-SPOC real photometry from the public S3 bucket";

test("a measured dip is narrated WITH the uncertainty the measurement has earned", () => {
  const r = narrateFinding(found(cand()), { lightCurveSource: REAL });
  // P90 measured a median 36.7% absolute error for the box depth against the NASA Exoplanet Archive, and a 48.0%
  // radius for 68% coverage, so the prose may not offer "1200 parts per million" as if it were exact.
  // 1200 ppm at 0.5 systematic (the coverage radius carried to one figure) -> ceil 1 sf -> 700.
  assert.match(
    r.explainer,
    /brightness dips by 1200 parts per million, give or take about 700 ppm once every 3\.14 days/,
    r.explainer,
  );
  assert.equal(r.stats["Transit depth"], "1200 +/- 700 ppm (0.12 +/- 0.07 %)");
  assert.equal(r.stats["Signal strength (SNR)"], "14.2");
  // And it says WHERE the error bar comes from, with its sample size and its coverage meaning, so the number is
  // checkable rather than styled.
  assert.match(r.explainer, /quoted to \+\/\- 700 ppm/, r.explainer);
  assert.match(r.explainer, /on 16 planets with published transit depths/, r.explainer);
  assert.match(r.explainer, /the radius that holds two thirds of them is 48%/, r.explainer);
});

test("the narration never claims more digits than the recorded SNR and the measured floor support", () => {
  // The defect P90 exposed was a bare integer ppm plus a three-decimal percent. No combination of depth and SNR
  // may put that shape back on a card: an unqualified depth, or a percent finer than its own error bar.
  const cases = [
    { depthFrac: 2.68e-4, snr: 29.4 },
    { depthFrac: 1.309e-2, snr: 108.7 },
    { depthFrac: 6.0e-5, snr: 7.4 },
    { depthFrac: 1e-6, snr: 1.5 },
  ];
  for (const c of cases) {
    const r = narrateFinding(found(cand(c)), { lightCurveSource: REAL });
    const stat = r.stats["Transit depth"];
    assert.match(stat, /^\d+ \+\/- \d+ ppm \(/, `${JSON.stringify(c)}: ${stat}`);
    assert.doesNotMatch(stat, /\d+ ppm \(\d+\.\d{3}%\)/, `${JSON.stringify(c)}: ${stat}`);
    assert.doesNotMatch(r.explainer, /dips by about \d+ parts per million once/, "an unqualified depth in prose");
  }
});

test("a brightening is never narrated as a transit", () => {
  // TOI-1487.01 as the live rig held it: box on a bump, depth -104.92 ppm, SNR -8.5, verdict rejected.
  const bump = cand({ depthFrac: -1.0492e-4, depthPpt: -0.10492, snr: -8.5 });
  const r = narrateFinding(found(bump, { verdict: "rejected" }), { lightCurveSource: REAL });

  assert.doesNotMatch(r.explainer, /dips by/, r.explainer);
  assert.doesNotMatch(r.explainer, /fingerprint of a planet crossing/, "a bump must not be described as a planet crossing the star");
  assert.match(r.explainer, /is a BRIGHTENING of about 105 parts per million, not a dimming/, r.explainer);
  assert.match(r.explainer, /not a dip at all \(SNR -9\)/, r.explainer);
  assert.match(r.headline, /No transit measured on a 3\.14-day interval/, r.headline);
  assert.equal(r.stats["Transit depth"], "no dip measured -- the box is a rise of 105 ppm", JSON.stringify(r.stats));
  // No error bar and no percent either: there is no dip here whose precision could be qualified.
  assert.doesNotMatch(r.stats["Transit depth"], /\+\/-|%/, r.stats["Transit depth"]);
});

test("a zero depth is 'no dip measured' too, because a flat box is not a shallow transit", () => {
  const r = narrateFinding(found(cand({ depthFrac: 0, depthPpt: 0, snr: 0 }), { verdict: "rejected" }), { lightCurveSource: REAL });
  assert.doesNotMatch(r.explainer, /dips by/, r.explainer);
  assert.match(r.stats["Transit depth"], /no dip measured/, JSON.stringify(r.stats));
});

test("the period is written with only the digits the grid resolved, on every narrated surface", () => {
  // 16 d on a 27-day baseline at oversample 8 resolves about 1.2 d, so "16.00" claims precision two orders of
  // magnitude better than the search had. The same rule must hold at the fine end, where 0.02 d is real.
  const coarse = narrateFinding(found(cand({ periodDays: 16.0043, periodResolutionDays: 1.2 })), { lightCurveSource: REAL });
  assert.doesNotMatch(coarse.explainer, /16\.00/, coarse.explainer);
  assert.match(coarse.explainer, /once every 16 days/, coarse.explainer);

  const fine = narrateFinding(found(cand({ periodDays: 1.96234, periodResolutionDays: 0.018 })), { lightCurveSource: REAL });
  assert.match(fine.explainer, /once every 1\.96 days/, fine.explainer);
});

test("a period at the search limit is stated as a limit", () => {
  const c = cand({ periodDays: 16, periodResolutionDays: 1.2, atSearchBoundary: true, searchMaxPeriodDays: 16 });
  const r = narrateFinding(found(c), { lightCurveSource: REAL });
  assert.match(r.stats["Planet year (period)"], /at the 16-day search limit; the true period may be longer/, JSON.stringify(r.stats));
  assert.match(r.explainer, /repeats no more often than every 16 days/, r.explainer);
});

test("an accepted row that cross-matches names the planet it reproduced", () => {
  const r = narrateFinding(
    found(cand(), { verdict: "accepted", crossmatch: { matchedKnownPlanet: true, knownPlanetName: "KELT-24 b", periodDeltaPct: 0.42 } }),
    { lightCurveSource: REAL },
  );
  assert.match(r.headline, /Recovered a 3\.14-day signal matching known KELT-24 b/, r.headline);
  assert.match(r.stats["Known-planet match"], /KELT-24 b \(0\.42% off\)/, JSON.stringify(r.stats));
});

test("nothing the reporter writes may carry an affirmative discovery stem, in any verdict or on either branch", () => {
  // The posting path refuses these stems with a regex. That guard sits one layer out from the prose, so the prose
  // is pinned here instead of trusted: if a future branch writes "confirmed", this test fails before a feed can.
  const stems = /\b(discover\w*|confirm\w*|first|novel|unprecedented|landmark|historic)\b/gi;
  for (const c of [cand(), cand({ depthFrac: -1e-4, depthPpt: -0.1, snr: -8 }), cand({ depthFrac: 0, depthPpt: 0, snr: 0 })]) {
    for (const v of ["accepted", "needs-more-data", "rejected"] as const) {
      const r = narrateFinding(found(c, { verdict: v }), { lightCurveSource: REAL });
      const text = `${r.headline} ${r.explainer} ${Object.values(r.stats).join(" ")}`;
      assert.deepEqual(text.match(stems) ?? [], [], `${v}: ${text}`);
    }
  }
  const summary = narrateRunSummary({ tasks: 8, accepted: 2, review: 3, rejected: 3, anchored: 1 });
  assert.deepEqual(summary.match(stems) ?? [], [], summary);
  assert.match(summary, /2 recovered, 3 needing more data, 3 rejected/, summary);
});
