// Deploy-provenance gate: /health must not be allowed to certify a commit that is not what got uploaded.
//
// WHAT HAPPENED. `npm run cf:deploy:sha` sets the GIT_SHA secret from `git rev-parse HEAD` and then runs
// `wrangler deploy`, which uploads the FILES ON DISK. Those agree only when the tree is clean. On 2026-10-18 an
// idle-gap watcher fired a deploy between two of my commits: production served an uncommitted renderer for 75
// minutes while /health.gitSha named f473c72, a commit that did not contain it -- and seven records were narrated
// by code that no CI run had ever seen. The script already printed a warning about dirty trees. The warning changed
// nothing, which is the definition of a gate that is not a gate.
//
// WHY BOTH A PURE TEST AND A REAL ONE. A test of the pure function alone would stay green if the call site were
// deleted, and this repository has been audited into that failure more than once. So the refusal is also driven
// through the actual CLI, against a real dirty tree, asserting exit 1 and that no upload was attempted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { deployDecision } from "../src/deploy/deployGuard.ts";

const SHA = "fbee5ea5f6fa68d4378c271dba41a90c62f9b6ab";
const SCRIPT = resolve(process.cwd(), "scripts", "deploy-with-sha.ts");
// Deliberately NOT gitignored: the refusal test works by making `git status --porcelain` report something, and an
// ignore rule would hide the very dirt the gate is supposed to catch -- the test would then watch the CLI take the
// clean path and still report green. If this file ever survives a crashed run, it blocks the next deploy until it
// is deleted, which is the safe direction for a gate of this kind.
const PROBE = resolve(process.cwd(), ".deploy-guard-probe");

test("a clean tree is allowed, and the reason says so", () => {
  const d = deployDecision(SHA, "");
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.dirty, []);
  assert.match(d.reason, /clean/);
});

test("uncommitted paths are refused, and every one of them is named", () => {
  const d = deployDecision(SHA, " M src/reporter/narrate.ts\n?? src/core/depthFormat.ts\n");
  assert.equal(d.ok, false, "a dirty tree must not deploy by default");
  assert.deepEqual(d.dirty, ["M src/reporter/narrate.ts", "?? src/core/depthFormat.ts"]);
  assert.match(d.reason, /2 uncommitted path/);
  assert.match(d.reason, /--allow-dirty/);
});

test("the escape hatch exists, and it cannot be quiet", () => {
  const d = deployDecision(SHA, " M x.ts", { allowDirty: true });
  assert.equal(d.ok, true);
  assert.deepEqual(d.dirty, ["M x.ts"]);
  assert.match(d.reason, /by explicit request/);
});

test("no override can deploy something that is not a commit", () => {
  for (const bad of ["", "deadbeef", "not-a-sha", SHA.toUpperCase(), SHA.slice(0, 39) + "g"]) {
    for (const opts of [{}, { allowDirty: true }] as const) {
      const d = deployDecision(bad, "", opts);
      assert.equal(d.ok, false, `"${bad}" with ${JSON.stringify(opts)}`);
      assert.match(d.reason, /40-hex git HEAD/);
    }
  }
});

test("the script calls the rule and stops before uploading anything", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /import \{ deployDecision \} from "\.\.\/src\/deploy\/deployGuard\.ts"/, "must use the shared rule, not a copy");
  assert.match(src, /if \(!decision\.ok\) \{[\s\S]*?process\.exit\(1\)/, "a refusal must exit non-zero");
  assert.match(src, /--allow-dirty/, "the override must be reachable");
  // The warning-only shape that let the 09:19Z deploy through must be gone, not merely superseded.
  assert.doesNotMatch(src, /working tree has uncommitted changes; gitSha will NOT fully describe/, "a warning is not a gate");
  const guardAt = src.indexOf("const decision = deployDecision");
  const secretAt = src.indexOf('["wrangler", "secret", "put"');
  assert.ok(guardAt >= 0 && secretAt >= 0 && guardAt < secretAt, "the guard must run BEFORE the sha secret is written");
  const deployAt = src.indexOf('["wrangler", "deploy"');
  assert.ok(guardAt >= 0 && deployAt >= 0 && guardAt < deployAt, "the guard must run BEFORE the upload");
});

test("driving the real CLI against a dirty tree refuses, and uploads nothing", (t) => {
  writeFileSync(PROBE, "temporary dirt created by tests/deploy-guard.test.ts\n");
  t.after(() => rmSync(PROBE, { force: true }));
  const r = spawnSync("npx", ["tsx", "scripts/deploy-with-sha.ts", "--dry-run"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 180000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 1, `expected a refusal, got exit ${r.status}\n${out.slice(0, 600)}`);
  assert.match(out, /REFUSED/, out.slice(0, 600));
  assert.match(out, /\.deploy-guard-probe/, "the offending path must be listed for the operator");
  assert.doesNotMatch(out, /Uploaded space-data-rig|Deployed space-data-rig/, "nothing may be uploaded on a refusal");
});

test("against the real repository state, the rule says exactly what the tree is", () => {
  // No CLI invocation here on purpose: the clean-tree path reaches `wrangler deploy --dry-run`, which needs
  // production credentials. This asserts the rule against the actual git output instead, so a tree that IS clean
  // is never blocked and a tree that ISN'T is never waved through -- whichever state the suite runs in.
  const real = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", shell: process.platform === "win32" });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: process.platform === "win32" });
  const status = (real.stdout ?? "").trim();
  const d = deployDecision((head.stdout ?? "").trim(), status);
  if (status) {
    assert.equal(d.ok, false, "a dirty tree must be refused -- and this tree is dirty right now");
    assert.ok(d.dirty.length > 0);
  } else {
    assert.equal(d.ok, true, "a clean tree must not be blocked");
    assert.deepEqual(d.dirty, []);
  }
});
