// Live-data regression: the X digest + silence heartbeat must count ONLY surviving blind candidates.
//
// After the survey rotation was unfrozen, live /api/state began producing origin="blind-toi" rows -- a mix of
// surviving needs-more-data candidates AND critic-rejected dips. The digest blind tier and heartbeat previously
// counted every blind-toi row in the window, so a REJECTED dip (noise) would be reported as an "UNCONFIRMED
// candidate for human follow-up" -- an over-count that misrepresents the catalog. This test drives the real
// composeDigest over the REAL captured records (tests/fixtures/live-blind-candidates.json) and asserts the
// proposition -- surviving only, and the honesty invariants on production bytes -- not a hand-built stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { composeDigest, type DigestFinding } from "../scripts/science-digest.ts";

interface BlindRow {
  targetId: string;
  verdict: string;
  origin: "blind-toi";
  createdAt: string;
  periodDays: number | null;
  matchedKnownPlanet: boolean;
  discoveryClaim: boolean;
  anchored: boolean;
}
interface BlindFixture {
  capturedAt: string;
  base: string;
  total: number;
  surviving: number;
  rejected: number;
  candidates: BlindRow[];
}

const fx = JSON.parse(readFileSync(resolve(process.cwd(), "tests", "fixtures", "live-blind-candidates.json"), "utf8")) as BlindFixture;

const toDigest = (c: BlindRow): DigestFinding => ({
  targetId: c.targetId,
  verdict: c.verdict,
  origin: c.origin,
  createdAt: c.createdAt,
  candidate: { periodDays: c.periodDays ?? undefined },
  crossmatch: { matchedKnownPlanet: c.matchedKnownPlanet },
});

const times = fx.candidates.map((c) => Date.parse(c.createdAt)).filter((n) => !Number.isNaN(n));
const earliest = new Date(Math.min(...times)).toISOString();
const latest = new Date(Math.max(...times)).toISOString();

test("live blind fixture: honesty invariants hold on production bytes (no claim, none anchored)", () => {
  assert.ok(fx.candidates.length >= 1, `fixture captured no blind candidates (re-run npm run fixtures:capture-blind after a rotation)`);
  for (const c of fx.candidates) {
    assert.equal(c.origin, "blind-toi", "every row in this fixture is a blind candidate");
    assert.equal(c.discoveryClaim, false, `blind candidate ${c.targetId} must carry discoveryClaim=false`);
    assert.equal(c.anchored, false, `blind candidate ${c.targetId} must never be auto-anchored`);
  }
});

test("digest blind tier counts ONLY surviving candidates, not critic-rejected dips", () => {
  assert.ok(fx.total >= fx.surviving, "counts internally consistent");
  assert.ok(fx.rejected > 0, `fixture must include a rejected blind row to make the over-count assertion meaningful (got ${fx.rejected})`);
  // Window that covers every captured row so all pass the time filter; ledger empty + researchUpdated=false so the
  // blind tier (priority 2) is the one reached.
  const t = composeDigest({
    windowStart: earliest,
    windowEnd: latest,
    ledger: [],
    findings: fx.candidates.map(toDigest),
    research: null,
    researchUpdated: false,
  });
  assert.ok(t.includes(`${fx.surviving} new`), "must report exactly the surviving count (variant-agnostic: every phrasing says 'N new ... candidate')");
  assert.ok(!t.includes(`${fx.total} new`), `must NOT inflate to the total (${fx.total}) that includes rejected rows`);
  assert.match(t, /for human follow-up/, "stays honest that these are leads, not discoveries");
  assert.ok(!/re-verified|reproducible results on-chain/.test(t), "blind candidates are not known-planet re-validations");
  assert.ok([...t].every((ch) => ch.charCodeAt(0) < 128), "ASCII only");
});

test("silence heartbeat 'records N blind candidates' also excludes rejected rows", () => {
  // A VALID window that covers NONE of the rows (just after the latest) -> the science tiers fall through and the
  // heartbeat reports the standing catalog. Its blind count must equal surviving, not total.
  const after = new Date(Math.max(...times) + 60_000).toISOString();
  const afterEnd = new Date(Math.max(...times) + 120_000).toISOString();
  const t = composeDigest({
    windowStart: after,
    windowEnd: afterEnd,
    ledger: [],
    findings: fx.candidates.map(toDigest),
    research: null,
    researchUpdated: false,
    silentMinutes: 100000,
    heartbeatAfterMinutes: 90,
  });
  assert.match(t, /Space Data Rig status\./, "heartbeat reached when nothing is in-window");
  assert.match(t, new RegExp(`records ${fx.surviving} UNCONFIRMED blind candidate`), "heartbeat counts surviving only");
  assert.ok(!t.includes(`records ${fx.total} UNCONFIRMED`), `heartbeat must NOT count rejected (${fx.total})`);
});
