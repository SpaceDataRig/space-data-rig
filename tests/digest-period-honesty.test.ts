// The public feed is the rig's only outward-facing claim, so what it prints about a period is a scientific
// statement, not formatting. Two defects are pinned here, both measured on the live rig before being fixed:
//
//   1. `P=${pd.toFixed(2)}d` was printed for every candidate. The period is a discrete BLS grid node whose spacing
//      grows as P^2, so hundredths of a day are real precision at P=2 d and fiction at P=16 d.
//   2. The exemplar named after "e.g." was simply the newest row in the window, so the feed could name a
//      candidate its own re-injection test had failed to recover (0/8 trials) while a better-supported one in the
//      same batch went unmentioned.
//
// A candidate whose peak sits on the long-period edge of the grid is not a measurement of that period at all, and
// must be described as a limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeDigest, type DigestFinding, type DigestInput } from "../scripts/science-digest.ts";

const START = "2026-10-18T03:00:00Z";
const END = "2026-10-18T03:30:00Z";
const IN_WINDOW = "2026-10-18T03:10:00.000Z";

function input(over: Partial<DigestInput> = {}): DigestInput {
  return { windowStart: START, windowEnd: END, ledger: [], findings: [], research: null, researchUpdated: false, ...over };
}

function blind(targetId: string, periodDays: number, createdAt: string, extra: Partial<DigestFinding> = {}): DigestFinding {
  return {
    id: `F-${targetId}`,
    targetId,
    origin: "blind-toi",
    verdict: "needs-more-data",
    createdAt,
    candidate: { periodDays },
    ...extra,
  };
}

test("a long period is published with the resolution the grid had, not with invented decimals", () => {
  // 16 d on a 27 d baseline at oversample 8: node spacing 256/216 = 1.19 d. "16.00d" was a false claim of
  // hundredths; the post must now carry a matched uncertainty.
  const f = blind("TOI-588.01", 16, IN_WINDOW, {
    candidate: { periodDays: 16, periodResolutionDays: (16 * 16) / (8 * 27) },
    recoveryTrials: { nTrials: 8, nRecovered: 3 },
  });
  const text = composeDigest(input({ findings: [f] }));
  assert.ok(text.length > 0, "a surviving blind candidate must produce a post");
  assert.match(text, /P=16 \+\/- 1 d/, `expected the resolution-matched period, got: ${text}`);
  assert.ok(!text.includes("16.00"), "the invented two-decimal form must be gone");
  assert.ok(!/[^\x00-\x7F]/.test(text), "ASCII only, or post-x-text.ts refuses the whole post");
});

test("a short period keeps its real precision, so the fix is not a blanket rounding down", () => {
  const p = 1.956772524382509;
  const f = blind("TOI-909.01", p, IN_WINDOW, { candidate: { periodDays: p, periodResolutionDays: (p * p) / (8 * 27) } });
  const text = composeDigest(input({ findings: [f] }));
  assert.match(text, /P=1\.96 \+\/- 0\.02 d/, `expected hundredths to survive where the grid resolved them: ${text}`);
});

test("a candidate with no recorded resolution is published with the conservative bound", () => {
  // Records written before the detector started reporting a resolution must not fall back to invented decimals.
  const f = blind("TOI-4470.01", 16, IN_WINDOW);
  const text = composeDigest(input({ findings: [f] }));
  assert.match(text, /P=16 \+\/- 1 d/, `the conservative bound must apply: ${text}`);
  assert.ok(!text.includes("16.00"));
});

test("a period at the edge of the searched range is stated as a limit, not a measurement", () => {
  const f = blind("TOI-588.01", 16, IN_WINDOW, {
    candidate: { periodDays: 16, atSearchBoundary: true, searchMaxPeriodDays: 16 },
  });
  const text = composeDigest(input({ findings: [f] }));
  assert.match(text, /search limit/, `a boundary peak must be labelled a limit: ${text}`);
  assert.match(text, /longer period cannot be ruled out/);
  assert.ok(!text.includes("P=16.00d"), "and must never be printed as a measured period");
});

test("the named example is the best-supported candidate, not merely the newest", () => {
  // Three candidates in one window. The newest is the one the OLD code would have named, and it is the one the
  // rig's own re-injection could not recover at all (0/8). Naming it as the example of a batch while omitting the
  // recovery figure is exactly the kind of overstated public claim this fixes.
  const weakNewest = blind("TOI-9999.01", 1.4, "2026-10-18T03:25:00.000Z", {
    recoveryTrials: { nTrials: 8, nRecovered: 0 },
    score: 30,
  });
  const strongEarlier = blind("TOI-1234.01", 3.2, "2026-10-18T03:05:00.000Z", {
    recoveryTrials: { nTrials: 8, nRecovered: 7 },
    score: 80,
  });
  const text = composeDigest(input({ findings: [weakNewest, strongEarlier] }));
  assert.match(text, /TOI-1234\.01/, `the strongest candidate should be the example: ${text}`);
  assert.match(text, /recovered it in 7\/8 trials/, "and its own trust measure must be published with it");
  assert.match(text, /3 new|1 new|2 new/, "the count still covers the whole batch");
  assert.equal(
    (text.match(/TOI-9999\.01/g) || []).length,
    0,
    "the 0/8 candidate is counted, not named -- naming it would invite a follow-up on the weakest lead",
  );
});

test("a batch where every candidate failed re-injection still says so plainly", () => {
  const a = blind("TOI-7001.01", 2.5, "2026-10-18T03:06:00.000Z", { recoveryTrials: { nTrials: 8, nRecovered: 0 }, score: 40 });
  const b = blind("TOI-7002.01", 4.5, "2026-10-18T03:07:00.000Z", { recoveryTrials: { nTrials: 8, nRecovered: 0 }, score: 35 });
  const text = composeDigest(input({ findings: [a, b] }));
  assert.match(text, /recovered it in 0\/8 trials/, "the honest number must appear rather than be hidden");
  assert.match(text, /UNCONFIRMED/);
});

test("a known-planet re-validation prints its period with the same honesty", () => {
  const f: DigestFinding = {
    id: "F-KNOWN",
    targetId: "TIC 1000",
    origin: "revalidation",
    verdict: "accepted",
    createdAt: IN_WINDOW,
    candidate: { periodDays: 16, atSearchBoundary: true, searchMaxPeriodDays: 16 },
    crossmatch: { matchedKnownPlanet: true, knownPlanetName: "HD 189733 b" },
  };
  const text = composeDigest(input({
    findings: [f],
    ledger: [{ findingId: "F-KNOWN", status: "confirmed", signature: "5xYsig", anchoredAt: IN_WINDOW }],
  }));
  assert.match(text, /HD 189733 b/, "the known planet must still be named");
  assert.ok(!text.includes("16.00"), `a boundary period must not be printed as measured: ${text}`);
  assert.match(text, /search limit|cannot be ruled out/);
});
