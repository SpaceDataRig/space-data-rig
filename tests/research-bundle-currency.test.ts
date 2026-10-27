// ROUND-26 R26-9: the published research bundle must be what a fresh build of the committed reports produces.
//
// WHY THIS EXISTS. `web/research.json` is the asset the feed post links as "Numbers + data", and `web/app.js` renders
// its `compute` block as a visible metric card. Nothing rebuilt it in CI and no test compared it to the reports it
// summarises, so when two of its sources were re-measured on the networked fleet the public file kept publishing the
// older figures for six days -- including `addressable: caught 2 of 13, AUC 0.742` after the stamped
// `reports/p59-offtarget-subset.json` had moved to 0 of 0. This round found that by following p34's drift outward, and
// the correction itself proves the point: the historical revision that published the stale exponent is the positive
// control below, located by its content rather than by a fixed position in the log (a position-anchored control decayed
// silently once a second refresh merged -- see the control's own comment). The gate is written after a fault that had
// already happened, not around an imagined one.
//
// WHY THE COMPARISON IGNORES ONLY THE BUNDLE'S OWN TIMESTAMP. `generatedAt` legitimately changes on every rebuild; a
// gate that cannot tell a rebuild from a re-measurement would be silenced inside a day. Everything else -- every
// number, caveat and count -- is asserted byte-equal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const P38 = join(REPO, "scripts", "p38-research-bundle.ts");
const PUBLISHED = join(REPO, "web", "research.json");
const SCRATCH = resolve(REPO, "out", `research-currency-${process.pid}.json`);

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

/** Run the real bundler into a scratch path inside the repo (its own guard refuses anything outside cwd). */
function buildInto(absPath: string): { status: number; text: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, P38, `--out=${absPath}`], {
    cwd: REPO, encoding: "utf8", timeout: 300_000,
  });
  return { status: r.status ?? -1, text: (r.stdout || "") + (r.stderr || "") };
}

/** Drop the bundle's own top-level timestamp line -- the one field a rebuild is allowed to change. */
function withoutOwnStamp(text: string): string {
  const out = text.replace(/^ {2}"generatedAt": "[^"]*",?\r?\n/m, "");
  assert.notEqual(out, text, "no top-level generatedAt line found: the comparison would be comparing raw bytes and could not tell a rebuild from a re-measurement");
  return out;
}

/** A readable list of the JSON paths that disagree, so a red run names the figure rather than the whole file. */
function diffPaths(a: unknown, b: unknown, path = "", hits: string[] = []): string[] {
  if (hits.length >= 12) return hits;
  if (a === b) return hits;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diffPaths(a[i], b[i], `${path}[${i}]`, hits);
    return hits;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
      diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, hits);
    }
    return hits;
  }
  hits.push(`${path || "(root)"}: published ${JSON.stringify(a)} vs a fresh build ${JSON.stringify(b)}`);
  return hits;
}

test("the committed research bundle equals a fresh build from the committed reports", () => {
  const built = buildInto(SCRATCH);
  try {
    assert.equal(built.status, 0, `the bundler exited ${built.status}:\n${built.text.slice(-1200)}`);
    const fresh = readFileSync(SCRATCH, "utf8");
    const published = readFileSync(PUBLISHED, "utf8");
    const d = diffPaths(JSON.parse(withoutOwnStamp(published)), JSON.parse(withoutOwnStamp(fresh)));
    assert.deepEqual(
      d, [],
      "web/research.json is behind the reports it summarises. Rebuild with `npm run p38:research-bundle` -- and if " +
      "the moved figure is one a post or a card quotes, fix the quote too:\n" + d.slice(0, 12).join("\n"),
    );
  } finally {
    if (existsSync(SCRATCH)) rmSync(SCRATCH);
  }
});

test("positive control: the bundle that published the pre-refresh exponent fails this gate, naming the figure", () => {
  // NOT a synthetic fixture -- this is a real historical asset, read out of git. But it is selected BY CONTENT, not by
  // tip position. The first version of this control took "the second-newest revision of web/research.json", which
  // happened to be the 2.936 bundle on the day it was written. The fleet then merged a SECOND refresh (`61ca06c`) on
  // top of `e97c4fd`, so the second-newest revision became an already-refreshed bundle: the control quietly stopped
  // naming the figure it exists to prove, and the gate passed while believing it had a positive control. That is the
  // same decay this round keeps hitting -- a check anchored to a moving history slot. The stable anchor is the newest
  // revision that still published the pre-refresh exponent, whatever its position turns out to be.
  const revs = git(["log", "--format=%H", "--", "web/research.json"]).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(revs.length >= 2, `expected at least two revisions touching web/research.json, found ${revs.length}`);
  let control = "";
  for (const h of revs) {
    const blob = git(["show", `${h}:web/research.json`]);
    if (blob.includes("2.936437697567511")) { control = blob; break; }
  }
  assert.ok(
    control,
    "no reachable revision of web/research.json published the pre-refresh exponent 2.936437697567511: the control " +
    "cannot be built. Either this checkout's history is too shallow to reach it, or the figure changed name -- in " +
    "which case this gate has silently lost the drift it was written to catch.",
  );
  const published = readFileSync(PUBLISHED, "utf8");
  assert.ok(
    !published.includes("2.936437697567511"),
    "the shipped bundle still carries the pre-refresh exponent, so nothing has moved past the drift and there is no " +
    "gap for the control to demonstrate -- the gate would be asserting a difference against itself.",
  );
  const d = diffPaths(JSON.parse(withoutOwnStamp(control)), JSON.parse(withoutOwnStamp(published)));
  assert.ok(d.length > 0, "the pre-refresh bundle is byte-identical to the refreshed one: the drift this gate exists for has gone invisible");
  assert.ok(
    d.some((line) => /^compute\.exponentP:/.test(line)),
    `the control must catch the figure the site renders, not only incidental fields. Differences found: ${d.slice(0, 6).join(" | ")}`,
  );
});

test("the bundler refuses an --out that escapes the repository instead of writing wherever it is pointed", () => {
  const escape = resolve(REPO, "..", "research-escape.json");
  const r = buildInto(escape);
  assert.notEqual(r.status, 0, `--out=${escape} should have been refused`);
  assert.match(r.text, /outside/, `expected a refusal naming the resolved path, got:\n${r.text.slice(-600)}`);
  assert.ok(!existsSync(escape), "a refused build must still not have written the file");
});
