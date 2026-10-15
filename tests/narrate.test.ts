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
