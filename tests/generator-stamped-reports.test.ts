// ROUND-26: generators must stamp their own artifacts, and the stamp must be the code's doing.
//
// THE DEFECT CLASS THIS CLOSES. Thirty-nine reports went out as `unattested` not because their numbers were
// doubtful but because their generators wrote a `meta` block with no generatedAt / gitSha / hashed inputs, so
// the freshness gate had nothing to re-hash and could never call them machine-checked. Five of those generators
// need no network at all -- p34, p54, p63, p68, p79 -- so leaving them unstamped was a choice, not a constraint.
// p34 shows what the gap cost: its input catalog (reports/p33-catalog.json) had grown from 33 curves to 204
// since the published numbers were frozen, and a reader comparing the md to a re-run would have found fit p,
// R^2 and the doubling cost factor all different with no alarm raised anywhere, because an unstamped row is
// never compared to anything.
//
// WHY THESE ASSERTIONS AND NOT "just re-run them": re-running is the fix, but a fix that lives only in an
// artifact can be faked by editing the artifact. So each check below pairs a source fact (the generator calls
// buildStamp, and names itself among the inputs) with an artifact fact (every recorded checksum matches the
// bytes the repository carries right now) and a publication fact (the built index marks the row verified).
// Hand-writing a stamp into JSON, or editing a generator without re-running it, breaks one of the three.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { sha256File, stampFromMeta, gitTrackedPaths, type FreshnessStamp } from "../scripts/report-freshness.ts";

// id -> the generator script that must be carrying its own name in the stamp's input list.
const FIVE: { id: string; script: string }[] = [
  { id: "p34-cost-model", script: "scripts/p34-cost-model.ts" },
  { id: "p54-selection-function", script: "scripts/p54-selection-function.ts" },
  { id: "p63-soft-score", script: "scripts/p63-soft-score.ts" },
  { id: "p68-discriminator-roc", script: "scripts/p68-discriminator-roc.ts" },
  { id: "p79-benchmark", script: "scripts/p79-benchmark.ts" },
];

// ROUND-28 (R27 -> R28, audit of the auditor): the three research axes shipped in the round-26 close-out are covered
// only by the aggregate freshness recheck (scripts/audit/freshness-recheck.mjs), which is a MANUAL drill -- not in
// `npm test`. So a green suite could hide a stale p97/p98/p99 artifact. Bring them under the SAME named per-report
// triple-fact the original five enjoy: generator calls buildStamp, the artifact re-hashes every input INCLUDING its own
// generator source, and the built index calls it verified -- so editing the model code or drifting the committed data
// flips the row red in CI, before any reader sees it.
const THREE_AXES: { id: string; script: string }[] = [
  { id: "p97-blend-dilution-correction", script: "scripts/p97-blend-dilution-correction.ts" },
  { id: "p98-rednoise-window-systematics", script: "scripts/p98-rednoise-window-systematics.ts" },
  { id: "p99-prospective-heldout-blind", script: "scripts/p99-prospective-heldout-blind.ts" },
];

const ALL = [...FIVE, ...THREE_AXES];

function stampOfArtifact(id: string): FreshnessStamp {
  const doc = JSON.parse(readFileSync(`reports/${id}.json`, "utf8"));
  const stamp = stampFromMeta(doc.meta ?? doc);
  assert.ok(stamp, `reports/${id}.json carries no readable freshness stamp`);
  return stamp!;
}

test("the offline-capable generators (the original five + the three research axes) import buildStamp and call it", () => {
  // Source-level fact. If someone deletes the wiring, the next re-run silently produces an unstamped artifact
  // again; this fires before that, on the edit itself.
  for (const { id, script } of ALL) {
    const src = readFileSync(script, "utf8");
    assert.match(src, /from "\.\/report-freshness\.ts"/, `${script} must import the stamp builder`);
    assert.match(src, /buildStamp\(\[/, `${script} must call buildStamp([...]) so reports/${id}.json can be verified`);
  }
});

test("each artifact records a sha256 for every input, and every input is carried by the repository", () => {
  // p79 used to declare `inputs: ["reports/p47-completeness-grid.json", ...]` as bare strings: a name with
  // nothing to compare, which the gate documents as declared-but-unhashable. A null checksum still fails here.
  const tracked = gitTrackedPaths(); // null on a checkout with no git, which must not read as "nothing is tracked"
  for (const { id } of ALL) {
    const stamp = stampOfArtifact(id);
    assert.ok(stamp.inputs.length > 0, `reports/${id}.json stamps no inputs at all`);
    for (const input of stamp.inputs) {
      assert.ok(input.sha256, `reports/${id}.json records no checksum for ${input.path} -- a name is not a check`);
      assert.ok(
        existsSync(input.path),
        `reports/${id}.json stamps ${input.path}, which is not present to re-verify`,
      );
      if (tracked) {
        assert.ok(tracked.has(input.path), `${input.path} (stamped by ${id}) is not tracked, so no other checkout could re-hash it`);
      }
    }
  }
});

test("the recorded checksums still match the bytes on disk, including the generator's own file", () => {
  // The reproduction half: this is exactly what p86 does, done here independently so a green suite cannot hide
  // a stale artifact that the library build happened to paper over with --allow-stale.
  for (const { id, script } of ALL) {
    const stamp = stampOfArtifact(id);
    const self = stamp.inputs.find((i) => i.path === script);
    assert.ok(self, `reports/${id}.json does not stamp ${script}; an edit to the model code would be invisible`);
    for (const input of stamp.inputs) {
      assert.equal(
        sha256File(input.path),
        input.sha256,
        `reports/${id}.json is stale against ${input.path}: the bytes changed after the run that recorded them`,
      );
    }
  }
});

test("the published index calls every one of them verified, not merely stamped", () => {
  if (!existsSync("web/reports/index.json")) return; // library not built on this checkout
  const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8")) as {
    reports: { id: string; stamped: boolean; verified: boolean; fresh: boolean; reproducible: number }[];
  };
  for (const { id } of ALL) {
    const row = idx.reports.find((r) => r.id === id);
    assert.ok(row, `${id} is missing from web/reports/index.json`);
    assert.equal(row!.stamped, true, `${id}: the site would still show it as unstamped`);
    assert.equal(row!.fresh, true, `${id}: published as stale`);
    assert.ok(row!.reproducible > 0, `${id}: nothing about this row could be re-hashed on this checkout`);
    assert.equal(row!.verified, true, `${id}: stamped but not verified -- a timestamp with no checkable input`);
  }
});
