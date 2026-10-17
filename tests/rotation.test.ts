// audit-5 (audience-legibility) behavior tests for the rotating survey + honest blind-TOI labeling.
//
// These follow the audit-4 discipline: drive the REAL predicates over real-shaped inputs and assert the
// PROPOSITION, not that a function exists. Four guarantees matter and are proven here:
//   1. selectRotationWindow is deterministic, wraps, and shifts per pass (so the catalog grows, not churns);
//   2. toiToArchivePlanet maps fields with the right UNITS (pl_trandep is already ppm in the `toi` table);
//   3. critique() caps an UNCONFIRMED blind-TOI candidate at needs-more-data even when the evidence would
//      otherwise accept it -- the no-discovery / money-path red line, enforced in the runtime-agnostic seat;
//   4. origin is a display/provenance label ONLY: two findings identical except for origin compose to the SAME
//      bundleHash and the manifest carries no origin key -- so adding it never perturbs an anchored row.
import { test } from "node:test";
import assert from "node:assert/strict";

import { selectMixedWindow, selectRotationWindow } from "../src/survey/rotation.ts";
import { toiToArchivePlanet, type TocCandidate } from "../src/data/toiArchive.ts";
import { critique } from "../src/seats/seats.ts";
import { composeBundle, hashManifest, hashScience, type BundleManifest } from "../src/bundle/bundle.ts";
import type { DetectionResult } from "../src/detect/pipeline.ts";
import type { ArchivePlanet, Finding, TransitCandidate } from "../src/core/types.ts";

// ---- 1. rotation windowing -------------------------------------------------

test("selectRotationWindow is deterministic and stays in bounds", () => {
  const a = selectRotationWindow(50, 8, 7);
  const b = selectRotationWindow(50, 8, 7);
  assert.deepEqual(a, b, "same (poolLen,targets,pass) must yield the same window");
  assert.equal(a.length, 8);
  for (const i of a) assert.ok(i >= 0 && i < 50, `index ${i} out of bounds`);
});

test("selectRotationWindow shifts the window each pass so the catalog grows", () => {
  const p0 = selectRotationWindow(50, 8, 0);
  const p1 = selectRotationWindow(50, 8, 1);
  assert.notDeepEqual(p0, p1, "consecutive passes must select different positions");
  assert.equal(p0[0], 0);
  assert.equal(p1[0], 8, "the window advances by a full stride each pass");
  // Sweeping pool/stride passes should touch far more distinct positions than one pass -- the whole point of
  // rotation is that the recorded catalog is not the same handful re-overwritten every run.
  const union = new Set<number>();
  for (let pass = 0; pass < 6; pass++) for (const i of selectRotationWindow(50, 8, pass)) union.add(i);
  assert.ok(union.size >= 48, `six passes should cover most of a 50-pool, covered ${union.size}`);
});

test("selectRotationWindow wraps the pool and caps a small pool without duplicates", () => {
  // a late pass wraps past the end of the pool back to the start
  const late = selectRotationWindow(50, 8, 31); // start = (31*8) % 50 = 48
  assert.deepEqual(late, [48, 49, 0, 1, 2, 3, 4, 5], "the window must wrap modulo the pool, in order");
  for (const i of late) assert.ok(i >= 0 && i < 50, `wrap produced out-of-range index ${i}`);
  // targets > pool length caps at the pool size, no duplicate positions
  const small = selectRotationWindow(3, 10, 0);
  assert.deepEqual(small, [0, 1, 2], "a pool smaller than the request yields each position exactly once");
  // degenerate inputs
  assert.deepEqual(selectRotationWindow(0, 8, 0), []);
  assert.deepEqual(selectRotationWindow(50, 0, 0), []);
});

// ---- 2. TOI -> ArchivePlanet mapping --------------------------------------

test("toiToArchivePlanet maps fields with correct units (pl_trandep stays ppm, duration in hours)", () => {
  const c: TocCandidate = {
    toidisplay: "TOI-1773.01", tic: 441462736, ra: 10.5, dec: -3.25, tmag: 8.2,
    periodDays: 0.7365, epochBjd: 2458400.5, durationHours: 1.9, depthPpm: 5000,
    planetRadiusEarth: 1.4, starRadiusSun: 0.9,
  };
  const p: ArchivePlanet = toiToArchivePlanet(c);
  assert.equal(p.pl_name, "TOI-1773.01");
  assert.equal(p.hostname, "TOI-1773.01");
  assert.equal(p.pl_orbper, 0.7365);
  assert.equal(p.pl_trandep, 5000, "depth is ALREADY ppm in the toi table -- it must NOT be rescaled");
  assert.equal(p.pl_trandur, 1.9, "duration in hours");
  assert.equal(p.tic, 441462736);
  assert.equal(p.sy_tmag, 8.2);
  assert.equal(p.discoverymethod, "Transit");
});

// ---- 3. blind-TOI honesty ceiling in critique() ---------------------------

const candidate: TransitCandidate = {
  targetId: "TOI-9999.01", periodDays: 3.5, epochBjd: 2458425.7, durationHours: 2.9,
  depthPpt: 5.1, depthFrac: 0.0051, snr: 18, power: 0.0042, nPointsInTransit: 24, folded: [],
};
// A catalog entry that lets the BLIND critic reach "accepted" on evidence alone -- this is the exact
// situation the ceiling must intercept for an unconfirmed candidate.
const catalog: ArchivePlanet[] = [{ pl_name: "TOI-9999.01 b", hostname: "TOI-9999.01", pl_orbper: 3.5 }];
const detection = { candidate, aliasMultiple: 1 } as unknown as DetectionResult;

test("critique accepts on evidence when unlabeled (control) but caps a blind-TOI at needs-more-data", () => {
  const base = critique({ detection, catalog });
  assert.equal(base.verdict, "accepted", `control: evidence + direct match should accept, got ${base.verdict}`);

  const blind = critique({ detection, catalog, origin: "blind-toi" });
  assert.equal(blind.verdict, "needs-more-data", "an UNCONFIRMED TOI candidate must never be accepted");
  assert.match(blind.reason, /UNCONFIRMED/, "the reason must state it is unconfirmed");
  assert.match(blind.reason, /never anchored|not claimed|follow-up/i, "the reason must refuse a discovery claim");
  assert.equal(blind.score, base.score, "the ceiling only changes the verdict/reason, not the evidence score");
});

// ---- 4. origin never enters the bundle manifest (bundleHash invariance) ----

function findingWithOrigin(origin?: "revalidation" | "blind-toi"): Finding {
  const f = {
    id: "F-ORIGIN-TEST",
    targetId: "ORIGIN TEST",
    createdAt: "2026-10-16T00:00:00.000Z",
    verdict: "needs-more-data",
    verdictReason: "origin invariance test",
    recoveryConfidence: 0.9,
    candidate: { periodDays: 3.2, epochBjd: 2000.5, durationHours: 2.1, depthPpt: 5, depthFrac: 0.005, snr: 12, power: 30, nPointsInTransit: 6 },
    crossmatch: { matchedKnownPlanet: false },
  } as unknown as Finding;
  if (origin) f.origin = origin;
  return f;
}

const bundleArtifacts = [{ name: "folded.svg", bytes: new TextEncoder().encode("<svg>x</svg>") }];

test("two findings identical except for origin compose to the SAME bundleHash, and the manifest has no origin", async () => {
  const withOrigin = await composeBundle({
    finding: findingWithOrigin("blind-toi"), runId: "r1", codeVersion: "v1", artifacts: bundleArtifacts,
  });
  const withoutOrigin = await composeBundle({
    finding: findingWithOrigin(undefined), runId: "r1", codeVersion: "v1", artifacts: bundleArtifacts,
  });
  // The load-bearing assertion: adding origin moves NO bundle hash, so an already-anchored row is untouched.
  assert.equal(withOrigin.hash, withoutOrigin.hash, "origin must not change bundleHash");
  assert.ok(!("origin" in (withOrigin.manifest as unknown as Record<string, unknown>)), "the manifest must not carry origin");
  // scienceHash (the dedup content address) is likewise unaffected by origin.
  assert.equal(
    await hashScience(withOrigin.manifest as BundleManifest),
    await hashScience(withoutOrigin.manifest as BundleManifest),
    "origin must not change scienceHash either",
  );
  // sanity: hashManifest recomputes the same value from the serialized manifest (no hidden origin leak).
  assert.equal(await hashManifest(withOrigin.manifest), withOrigin.hash);
});

// ---- 5. mixed known+TOI window (audit-6: the feed must not starve on a low/frozen cursor) -------
//
// The old selection ran ONE contiguous window over the merged [known ++ TOI] pool, so the blind-TOI band
// (indices >= known length, ~48 in production) was only reached at pass >=6. With the cursor pinned low by
// hung passes, every pass yielded "8 known + 0 blind TOI" and the digest's blind tier had NO source. These
// tests pin the fix: each pass draws from BOTH sub-pools, independently rotated, with stable per-pool indices.

test("selectMixedWindow draws from BOTH sub-pools on the FIRST pass so blind candidates appear immediately", () => {
  const win = selectMixedWindow(48, 54, 8, 1); // production-shaped: 48 known + 54 TOI, 8 targets
  assert.equal(win.known.length, 4, "half the per-pass budget comes from the known sub-pool");
  assert.equal(win.toi.length, 4, "half comes from the TOI sub-pool -- blind candidates from pass 1, not pass 6");
  for (const k of win.known) assert.ok(k >= 0 && k < 48, `known index ${k} must stay inside the known pool`);
  for (const t of win.toi) assert.ok(t >= 0 && t < 54, `toi index ${t} must stay inside the TOI pool`);
});

test("selectMixedWindow is deterministic and sweeps BOTH pools across passes", () => {
  assert.deepEqual(selectMixedWindow(48, 54, 8, 3), selectMixedWindow(48, 54, 8, 3), "same inputs -> same window");
  assert.notDeepEqual(selectMixedWindow(48, 54, 8, 0), selectMixedWindow(48, 54, 8, 1), "consecutive passes shift both sub-windows");
  const knownU = new Set<number>();
  const toiU = new Set<number>();
  for (let pass = 0; pass < 12; pass++) {
    const w = selectMixedWindow(48, 54, 8, pass);
    for (const k of w.known) knownU.add(k);
    for (const t of w.toi) toiU.add(t);
  }
  assert.ok(knownU.size >= 40, `12 passes should cover most of a 48-known pool, covered ${knownU.size}`);
  assert.ok(toiU.size >= 40, `12 passes should cover most of a 54-TOI pool, covered ${toiU.size}`);
});

test("selectMixedWindow falls back to all-known with no TOI, caps a small TOI pool, and handles zero targets", () => {
  const noToi = selectMixedWindow(48, 0, 8, 1);
  assert.equal(noToi.toi.length, 0, "an empty TOI sub-pool yields no blind slots");
  assert.equal(noToi.known.length, 8, "the whole budget goes to known when no TOI is available");
  const tiny = selectMixedWindow(48, 3, 8, 1); // TOI smaller than its share
  assert.equal(tiny.toi.length, 3, "the TOI share caps at the pool size");
  assert.equal(tiny.known.length, 5, "known absorbs targets minus the capped TOI share");
  assert.deepEqual(selectMixedWindow(48, 54, 0, 1), { known: [], toi: [] }, "zero targets -> empty window");
});
