// The reporter's narration is what the frontend finding card shows and what gets written into the reproducible
// bundle, so its period string is a public claim too. Before src/core/periodFormat.ts existed, the headline used
// toFixed(2) and the stats table used toFixed(4) -- "16.0000 days" for a value whose grid node was about a day
// wide. These pin the corrected rendering, including the case where the honest statement is a limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { narrateFinding } from "../src/reporter/narrate.ts";
import type { Finding } from "../src/core/types.ts";

const res16 = (16 * 16) / (8 * 27); // ~1.19 d: the node spacing the 16-day search actually had

function finding(candidate: Partial<Finding["candidate"]>, verdict: Finding["verdict"] = "needs-more-data"): Finding {
  return {
    id: "F-TEST",
    targetId: "TOI-588.01",
    verdict,
    verdictReason: "test fixture",
    crossmatch: { matchedKnownPlanet: false },
    createdAt: "2026-10-18T04:03:32.125Z",
    origin: "blind-toi",
    candidate: {
      targetId: "TOI-588.01",
      periodDays: 16,
      epochBjd: 2458481.8,
      durationHours: 4.35,
      depthPpt: 0.292,
      depthFrac: 0.000202,
      snr: 91,
      power: 7.8e-8,
      nPointsInTransit: 9,
      ...candidate,
    },
  } as Finding;
}

test("the headline states a period to the digits the grid resolved", () => {
  const n = narrateFinding(finding({ periodResolutionDays: res16 }), { lightCurveSource: "TESS-SPOC" });
  assert.match(n.headline, /Possible 16-day signal/, n.headline);
  assert.ok(!n.headline.includes("16.00"), `invented decimals are back: ${n.headline}`);
  assert.ok(!/[^\x00-\x7F]/.test(n.headline + n.explainer), "the bundle and the browser must both render it");
});

test("the stats table quotes the uncertainty instead of four false decimals", () => {
  const n = narrateFinding(finding({ periodResolutionDays: res16 }));
  const p = n.stats["Planet year (period)"];
  assert.equal(p, "16 +/- 1 days (grid resolution)", p);
  assert.ok(!p.includes("16.0000"), "the old toFixed(4) form claimed a precision the search never had");
});

test("a short period keeps its real precision in both surfaces", () => {
  const p = 1.956772524382509;
  const n = narrateFinding(finding({ periodDays: p, targetId: "TOI-909.01", periodResolutionDays: (p * p) / (8 * 27) }));
  assert.match(n.headline, /1\.96-day signal/, n.headline);
  assert.equal(n.stats["Planet year (period)"], "1.96 +/- 0.02 days (grid resolution)");
});

test("a peak on the edge of the searched range is reported as a limit, not as a number", () => {
  const n = narrateFinding(finding({ atSearchBoundary: true, searchMaxPeriodDays: 16 }));
  assert.match(n.headline, /at least 16 days/, n.headline);
  assert.match(n.headline, /search limit/, n.headline);
  assert.match(n.stats["Planet year (period)"], /^>= 16 days/, n.stats["Planet year (period)"]);
  assert.match(n.explainer, /may be longer/, "the explainer must say what the limit means for a follow-up");
  assert.ok(!n.headline.includes("16.00") && !n.explainer.includes("16.00"));
});

test("the data-source label is unchanged: real photometry only when the source says so", () => {
  // The period fix must not disturb the existing provenance discriminator, which is a separate red line. The
  // single canonical test is /real photometry/i in src/data/dataTier.ts, so these strings exercise that.
  const real = narrateFinding(finding({}), { lightCurveSource: "TESS-SPOC real photometry (token-free S3)" });
  const standIn = narrateFinding(finding({}), { lightCurveSource: "synthetic stand-in for MAST TESS 2-min" });
  assert.match(real.headline, /^\[real TESS photometry\]/, real.headline);
  assert.match(standIn.headline, /^\[stand-in synthetic curve\]/, standIn.headline);
});

test("a rejected verdict still reads as a sentence with the honest period", () => {
  const n = narrateFinding(finding({ periodResolutionDays: res16 }, "rejected"));
  assert.match(n.headline, /The 16-day signal did not pass scrutiny/, n.headline);
});
