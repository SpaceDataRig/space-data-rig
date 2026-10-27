// ROUND-26 R26-20: the published replay manifest must be what a deterministic rebuild of the committed P50 report
// produces -- the same ungated-derived-asset class that left web/research.json six days stale, caught before it drifted.
//
// WHY THIS EXISTS. `web/replay-manifest.json` is a third-party-verifiable artifact derived entirely from
// `reports/p50-replay.json` (no new measurement) and machine-checked by `scripts/replay.ts`; it is served under `/`. But
// nothing held the committed file to what p55 currently builds. p55 is deterministic -- it writes no timestamp, so the
// bytes are a pure function of the report -- which is exactly why a silent edit to `reports/p50-replay.json` (a future
// networked re-run) would leave the served manifest stale with nothing failing, the research.json failure mode wearing a
// different hat. This test closes the class for the last offline-rebuildable, ungated public asset.
//
// WHY THE CONTROL IS SEMANTIC, NOT A STALE REVISION. `web/replay-manifest.json` has a single commit in its history (it
// was created and never re-touched), so unlike the research-bundle control there is no older bytes to read out of git.
// The control instead proves the byte-gate inspects the field that matters: flip the replay hash and require BOTH that the
// byte comparison sees a difference AND that the semantic verifier `verifyManifest` rejects it -- so the gate cannot be
// quietly comparing whitespace while the real invariant goes unwatched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyManifest, type ReplayManifest } from "../src/sim/replay.ts";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const P55 = join(REPO, "scripts", "p55-replay-manifest.ts");
const PUBLISHED = join(REPO, "web", "replay-manifest.json");
const SCRATCH = resolve(REPO, "out", `replay-currency-${process.pid}.json`);

function buildInto(absPath: string): { status: number; text: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, P55, `--out=${absPath}`], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
  return { status: r.status ?? -1, text: (r.stdout || "") + (r.stderr || "") };
}

test("the committed replay manifest equals a fresh deterministic rebuild of the committed P50 report", () => {
  assert.ok(existsSync(SCRATCH) === false, "scratch leaked from a prior run");
  const built = buildInto(SCRATCH);
  try {
    assert.equal(built.status, 0, `p55 exited ${built.status}:\n${built.text.slice(-1000)}`);
    const fresh = readFileSync(SCRATCH, "utf8");
    const published = readFileSync(PUBLISHED, "utf8");
    // No timestamp-stripping: p55 is deterministic, so a byte-exact match is the honest contract. If it ever learns a
    // generatedAt, this will go red and force the comparison to become field-aware rather than silently pass.
    assert.equal(published, fresh, "web/replay-manifest.json is behind a rebuild from reports/p50-replay.json -- re-run `npm run p55:replay-manifest`");
    // The manifest must keep the two structural promises the site rests on.
    const m = JSON.parse(published) as { replayHash: string; discoveryClaim: boolean };
    assert.equal(m.discoveryClaim, false, "the served replay manifest must never assert a discovery claim");
    assert.match(m.replayHash, /^[0-9a-f]{64}$/, "replayHash must be a 64-hex digest");
  } finally {
    if (existsSync(SCRATCH)) rmSync(SCRATCH);
  }
});

test("positive control: flipping the replay hash trips the byte gate AND the semantic verifier", async () => {
  const published = readFileSync(PUBLISHED, "utf8");
  const m = JSON.parse(published) as ReplayManifest;
  const flipped = m.replayHash.endsWith("a")
    ? m.replayHash.slice(0, -1) + "b"
    : m.replayHash.slice(0, -1) + "a";
  // 1. the byte comparison the gate runs is sensitive to exactly this field.
  const tamperedText = published.replace(m.replayHash, flipped);
  assert.notEqual(tamperedText, published, "the replay hash was not present as a literal in the file: the gate would not see this class of drift");
  // 2. and it is the field the semantic verifier actually guards, not a cosmetic one: the committed manifest verifies,
  //    the same manifest with a flipped replayHash does not. So the byte gate watches the field the verifier guards.
  assert.equal(await verifyManifest(m), true, "the committed manifest does not verify against itself -- the gate's subject is already broken");
  assert.equal(await verifyManifest({ ...m, replayHash: flipped }), false, "verifyManifest accepted a manifest whose replayHash no longer matches its record -- the byte gate and the verifier disagree");
});

test("p55 refuses an --out that escapes the repository", () => {
  const escape = resolve(REPO, "..", "replay-escape.json");
  const r = buildInto(escape);
  assert.notEqual(r.status, 0, `--out=${escape} should have been refused`);
  assert.match(r.text, /outside/, `expected a refusal naming the resolved path, got:\n${r.text.slice(-600)}`);
  assert.ok(!existsSync(escape), "a refused build must still not have written the file");
});
