// ROUND-26 R26-21: the two red lines must never be crossed by a PUBLISHED artifact, not just by the code that could
// produce one. This round's whole thesis is that a green generation path says nothing about the bytes a visitor gets --
// research.json proved that. So the same logic applied to the invariants that actually matter.
//
// THE LINES. This rig may never (1) claim it found a planet, or (2) arm a spending/gating verdict without a calibrated
// measurement. In the data those are the booleans `discoveryClaim` and `safeToGate`, and they are structurally false
// everywhere by design. Per-module tests pin the CODE paths; none reads the committed ARTIFACTS as a corpus. This test
// does, recursively -- because a nested `foo.discoveryClaim=true` is the same violation and a shallow key lookup would
// sail right past it.
//
// WHY THE CONTROL CHECKS RECURSION, NOT A FILE. The corpus is clean today, so the honest fear is a vacuous pass: a
// scanner that never finds the field anywhere would "pass" trivially. The control therefore does two things a flat check
// cannot -- it proves the fields EXIST in the corpus (so "zero true" is a real reading, not an absent-key artifact), and
// it feeds a SYNTHETIC deeply-nested object to the same walker and requires the walker to surface both flags. That is
// what makes "none of the published bytes trip them" a claim rather than a tautology.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const REDLINE_KEYS = new Set(["discoveryClaim", "safeToGate"]);

// Collect the JSON artifacts that are (or feed) what the site serves: every committed report, the crosscheck reports,
// and the public web/ JSON bundle/manifest/board.
function artifacts(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) files.push(p);
    }
  };
  walk(join(REPO, "reports"));
  for (const f of ["web/research.json", "web/replay-manifest.json", "web/candidates.json"]) {
    const p = resolve(REPO, f);
    if (existsSync(p)) files.push(p);
  }
  return files;
}

// Recursive walk returning every leaf value whose key is a red-line name, with its path, so a violation is locatable.
function redlineLeaves(node: unknown, path = ""): { path: string; value: unknown }[] {
  const hits: { path: string; value: unknown }[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...redlineLeaves(v, `${path}[${i}]`)));
    return hits;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const child = path ? `${path}.${k}` : k;
      if (REDLINE_KEYS.has(k)) hits.push({ path: child, value: v });
      hits.push(...redlineLeaves(v, child));
    }
  }
  return hits;
}

test("the red-line scan actually reads a corpus that contains the fields (guards against a vacuous zero)", () => {
  let totalLeaves = 0;
  for (const file of artifacts()) {
    const leaves = redlineLeaves(JSON.parse(readFileSync(file, "utf8")));
    totalLeaves += leaves.length;
  }
  assert.ok(totalLeaves > 0, `scanned ${artifacts().length} artifacts but found no discoveryClaim/safeToGate field at all -- the scanner is checking for a field the corpus does not use, so its "all false" would mean nothing`);
});

test("every published artifact keeps discoveryClaim and safeToGate exactly false (nothing truthy, null or absent-in-place-of-false slips through)", () => {
  const offenders: string[] = [];
  for (const file of artifacts()) {
    const leaves = redlineLeaves(JSON.parse(readFileSync(file, "utf8")));
    for (const { path, value } of leaves) {
      if (value !== false) offenders.push(`${file.replace(REPO, "")} :: ${path} = ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(offenders, [], `red line crossed by published bytes:\n${offenders.join("\n")}`);
});

test("the recursive walker catches a NESTED truthy flag that a shallow key check would miss", () => {
  const synthetic = { verdict: "ok", meta: { gating: { safeToGate: true }, rows: [{ discoveryClaim: true }] } };
  const hits = redlineLeaves(synthetic);
  const truthy = hits.filter((h) => h.value !== false).map((h) => h.path);
  assert.ok(truthy.includes("meta.gating.safeToGate"), `walker must descend into nested objects; got ${JSON.stringify(truthy)}`);
  assert.ok(truthy.includes("meta.rows[0].discoveryClaim"), `walker must descend into array elements; got ${JSON.stringify(truthy)}`);
});
