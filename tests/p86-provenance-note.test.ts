// ROUND-26 R26-52: prove p86 renders the AMBER provenance note -- not the red stale banner, and not silence --
// for the two report shapes that are actually live on the served site right now, the rows that read
// `stamped && !verified`. p92-scrambled-fa is code-only (it re-hashes its own `.ts`, so a stale DATA input could
// never show -- the R26-41 demotion); p89-multiepoch-di carries a generatedAt but records NO input checkpoint at
// all (its generator grew the stamp wiring after the artifact and was never re-run -- the R26-51 audit). Both
// must tell a reader honestly, and both are exactly where a future edit to p86's branch order could quietly drop
// the note while still writing verified=false into index.json.
//
// tests/report-freshness.test.ts drives the PURE verdict and says such a report is not verified.
// tests/p86-stale-alarm.test.ts runs the REAL script but only for the STALE branch. This file runs the SAME real
// script for the not-verified, not-stale branch end to end -- the half neither of the other two executes -- and
// includes a fully-verified control so the note is proven CONDITIONAL, not a stamp painted on every page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const P86 = join(REPO, "scripts", "p86-report-library.ts");
const ID = "p99-note-drill";

const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * A throwaway git repo holding one stamped report whose artifact is in the shape named by `kind`.
 *   "code-only" -- the stamp records a single tracked SOURCE (.ts) input that still matches: a stranger could
 *                  re-hash it, but it pins no data, so reproducibleData=0 and the row is not verified (the p92 shape).
 *   "no-inputs"  -- the artifact carries generatedAt but NO inputs key at all: stamped, yet nothing to re-hash
 *                  (the p89 shape).
 *   "verified"   -- the stamp records a single tracked non-source DATA (.txt) input that matches: fully verified,
 *                  the control that proves the note is conditional.
 */
function makeDrillRepo(kind: "code-only" | "no-inputs" | "verified"): string {
  const dir = mkdtempSync(join(tmpdir(), "p86note-"));
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "gen"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "gen", "index.ts"), "export const model = 1;\n");
  writeFileSync(join(dir, "data", "input.txt"), "alpha\n");
  const stamp: Record<string, unknown> = { generatedAt: new Date().toISOString(), gitSha: "" };
  if (kind === "code-only") stamp.inputs = [{ path: "gen/index.ts", sha256: sha256(readFileSync(join(dir, "gen", "index.ts"), "utf8")) }];
  else if (kind === "verified") stamp.inputs = [{ path: "data/input.txt", sha256: sha256("alpha\n") }];
  // kind === "no-inputs": deliberately leave `inputs` absent so the artifact is stamped but records nothing.
  writeFileSync(
    join(dir, "reports", `${ID}.json`),
    JSON.stringify({ schema: "drill/1", meta: stamp, verdict: "a drill", discoveryClaim: false }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "reports", `${ID}.md`),
    `# Note drill report (${ID})\n\nA one-paragraph summary that exists so the library has something to distil.\n\nReproduce: \`npm run p86:report-library\`\n`,
  );
  const now = Math.floor(Date.now() / 1000);
  const env = { ...process.env, GIT_AUTHOR_DATE: `@${now}`, GIT_COMMITTER_DATE: `@${now}`, GIT_AUTHOR_NAME: "drill", GIT_AUTHOR_EMAIL: "drill@example.invalid", GIT_COMMITTER_NAME: "drill", GIT_COMMITTER_EMAIL: "drill@example.invalid" };
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "drill fixture"]);
  return dir;
}

type DrillIndex = {
  freshness: { stamped: number; verified: number; fullyVerified: number; unattested: number; total: number; stale: string[] };
  reports: Array<{ id: string; slug: string; fresh: boolean; stamped: boolean; verified: boolean; reproducible: number; reproducibleData: number }>;
};

function runP86(dir: string): { code: number; out: string; index: DrillIndex; fragment: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, P86], { cwd: dir, encoding: "utf8", timeout: 120000 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const index = JSON.parse(readFileSync(join(dir, "web", "reports", "index.json"), "utf8")) as DrillIndex;
  const fragment = readFileSync(join(dir, "web", "reports", `${ID}.html`), "utf8");
  return { code: r.status ?? -1, out: text, index, fragment };
}

const row = (index: DrillIndex) => {
  const r = index.reports.find((x) => x.id === ID);
  assert.ok(r, `index.json has no row for ${ID}: ${JSON.stringify(index.reports.map((x) => x.id))}`);
  return r;
};

test("code-only stamp (the p92 shape): not verified, not stale, and the amber note names source-code provenance", () => {
  const run = runP86(makeDrillRepo("code-only"));
  assert.equal(run.code, 0, `a non-verified but non-stale report must NOT block the publish:\n${run.out}`);
  assert.deepEqual(run.index.freshness.stale, [], run.out);
  const r = row(run.index);
  assert.equal(r.verified, false, "a stamp over only source code is not machine-verified (R26-41)");
  assert.equal(r.reproducibleData, 0, run.out);
  assert.match(run.fragment, /report-provenance-note/, "the reader-facing page must carry the amber note");
  assert.match(run.fragment, /PROVENANCE NOT MACHINE-VERIFIABLE/, run.fragment.slice(0, 600));
  assert.match(run.fragment, /source code, not a data file/, "and it must say WHY, not just that it is unverified");
  assert.ok(!/report-stale-banner/.test(run.fragment), "this is not a STALE report; it must not be painted red");
});

test("stamped-but-no-inputs (the p89 shape): not verified, not stale, and the amber note names the missing checkpoint", () => {
  const run = runP86(makeDrillRepo("no-inputs"));
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(run.index.freshness.stale, [], run.out);
  const r = row(run.index);
  assert.equal(r.stamped, true, "it does carry a generatedAt, so it is stamped");
  assert.equal(r.verified, false, "but it records nothing to re-hash, so it is not verified");
  assert.match(run.fragment, /report-provenance-note/, run.fragment.slice(0, 600));
  assert.match(run.fragment, /PROVENANCE NOT MACHINE-VERIFIABLE/, run.fragment.slice(0, 600));
  assert.match(run.fragment, /no input checkpoint/, "and the reason must be the no-input case, verbatim");
  assert.ok(!/report-stale-banner/.test(run.fragment), run.fragment.slice(0, 400));
});

test("CONTROL: a verified data input publishes clean -- the amber note is conditional, not painted on every page", () => {
  const run = runP86(makeDrillRepo("verified"));
  assert.equal(run.code, 0, run.out);
  const r = row(run.index);
  assert.equal(r.verified, true, "a tracked, present, matching non-source input must read as machine-verified");
  assert.equal(r.reproducibleData, 1, run.out);
  assert.ok(!/report-provenance-note/.test(run.fragment), "a verified page must NOT carry the amber note");
  assert.ok(!/report-stale-banner/.test(run.fragment), run.fragment.slice(0, 400));
});
