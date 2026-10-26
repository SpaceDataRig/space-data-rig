// ROUND-25: prove the p86 stale alarm actually rings.
//
// scripts/report-freshness.ts opens by describing this exact pattern -- "the same 'prove the alarm rings' pattern
// used for the live-probe drill" -- and tests/report-freshness.test.ts honours it for the DECISION function: it
// hands compareInputs a tampered hash and asserts hardStale. But the gate has a second half that no test has ever
// executed: p86's refusal to publish, the red banner on the page, and the `freshness.stale` list in the published
// index. Those live in the script's I/O path, so every assertion about them so far has been static -- reading the
// COMMITTED web/reports/index.json and checking it is internally consistent. A consistent artifact proves nothing
// about whether the alarm would fire on the next stale report; it only proves the last build saw a clean tree.
//
// The posture this pins down is also worth stating where a reader will hit it: the ONE production caller of p86
// (freshness-regen.yml) passes --allow-stale, deliberately, so one unreachable catalog cannot block three good
// refreshes. The blocking exit is therefore never exercised in CI, and what the public actually relies on is the
// red mark surviving --allow-stale. Both halves are asserted below, so neither can rot silently: if someone later
// "fixes" --allow-stale into suppressing the banner as well, or drops the banner from the fragment while keeping the
// word "stale" in index.json, this file fails.
//
// The drill runs the REAL script in a throwaway git repository (p86 asks git which paths are tracked, and `verified`
// means something only over a tracked file), so nothing here touches reports/ or web/reports/ in the checkout.
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
const ID = "p99-drill";

const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * A throwaway repo holding one stamped report whose single recorded input is a tracked file. Committed, because
 * `verified` is defined over inputs a stranger could reproduce from a clean checkout -- an uncommitted file would
 * make the baseline itself the wrong colour.
 */
function makeDrillRepo(inputBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "p86drill-"));
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "input.txt"), inputBody);
  const stamp = {
    generatedAt: new Date().toISOString(),
    gitSha: "",
    inputs: [{ path: "data/input.txt", sha256: sha256(inputBody) }],
  };
  writeFileSync(
    join(dir, "reports", `${ID}.json`),
    JSON.stringify({ schema: "drill/1", meta: stamp, verdict: "a drill", discoveryClaim: false }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "reports", `${ID}.md`),
    `# Drill report (${ID})\n\nA one-paragraph summary that exists so the library has something to distil.\n\nReproduce: \`npm run p86:report-library\`\n`,
  );
  // Epoch-form dates, never an ISO string with a trailing Z: git reads those in the RUNNER's local timezone, which
  // on a UTC+8 box lands the commit eight hours early -- behind the report's own generatedAt -- and the provenance
  // note would differ by platform. (Round-24 learned that the hard way in tests/x-post-preflight.test.ts.)
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

/** The part of the published index this drill reads. Typed rather than `any` because the shape IS the contract. */
type DrillIndex = {
  freshness: { stamped: number; verified: number; fullyVerified: number; unattested: number; total: number; stale: string[] };
  reports: Array<{ id: string; slug: string; fresh: boolean; stamped: boolean; verified: boolean; rehashed: number; reproducible: number }>;
};

/** Run the real p86 against a throwaway repo and hand back what it did. */
function runP86(dir: string, args: string[]): { code: number; out: string; index: DrillIndex; fragment: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, P86, ...args], { cwd: dir, encoding: "utf8", timeout: 120000 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // p86 writes the fragments and index.json BEFORE it decides whether to refuse, so a missing artifact is a crash,
  // not a refusal -- and reading it is the only way to tell those two apart.
  const index = JSON.parse(readFileSync(join(dir, "web", "reports", "index.json"), "utf8")) as DrillIndex;
  const fragment = readFileSync(join(dir, "web", "reports", `${ID}.html`), "utf8");
  return { code: r.status ?? -1, out: text, index, fragment };
}

/** The row for the drill report, which every assertion below is about. */
const drillRow = (index: DrillIndex) => {
  const row = index.reports.find((x) => x.id === ID);
  assert.ok(row, `index.json has no row for ${ID}: ${JSON.stringify(index.reports.map((x) => x.id))}`);
  return row;
};

test("baseline: a stamped report whose tracked input still matches is published, verified, and not stale", () => {
  const dir = makeDrillRepo("alpha\n");
  const run = runP86(dir, []);
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(run.index.freshness.stale, [], run.out);
  const row = drillRow(run.index);
  assert.equal(row.verified, true, "a tracked, present, matching input must read as machine-verified");
  assert.equal(row.reproducible, 1, run.out);
  assert.ok(!/report-stale-banner/.test(run.fragment), "the clean page must not carry the red banner");
});

test("THE ALARM: a tampered recorded input makes p86 exit non-zero and name the report", () => {
  const dir = makeDrillRepo("alpha\n");
  // Change the bytes WITHOUT re-stamping: exactly the "centroid.jsonl was re-run and P84 was not" case the gate
  // exists for. Rewriting the file is enough; the stamp still promises the old hash.
  writeFileSync(join(dir, "data", "input.txt"), "alpha-tampered\n");
  const run = runP86(dir, []);
  assert.equal(run.code, 1, `a stale report must fail the build, got 0:\n${run.out}`);
  assert.match(run.out, /p86: STALE p99-drill/, run.out);
  assert.match(run.out, /refusing to publish 1 stale report/, run.out);
  assert.match(run.out, /sha256 differs/, `and it must say WHY, not just that something is stale:\n${run.out}`);
  assert.deepEqual(run.index.freshness.stale, [ID], "the refusal must be visible in the artifact it just wrote");
  assert.equal(drillRow(run.index).verified, false, "a stale report is never published as verified");
});

test("--allow-stale keeps the publish but NOT the warning: the page still carries the red banner", () => {
  // The whole public guarantee, given that the only CI caller passes this flag.
  const dir = makeDrillRepo("alpha\n");
  writeFileSync(join(dir, "data", "input.txt"), "alpha-tampered\n");
  const run = runP86(dir, ["--allow-stale"]);
  assert.equal(run.code, 0, `--allow-stale must not fail the build:\n${run.out}`);
  assert.match(run.out, /p86: STALE p99-drill/, "the refusal goes away; the diagnosis must not");
  assert.deepEqual(run.index.freshness.stale, [ID], "index.json must still list it as stale");
  assert.equal(drillRow(run.index).fresh, false);
  assert.match(run.fragment, /report-stale-banner/, "the reader-facing page must still be marked red");
  assert.match(run.fragment, /STALE \/ OUT OF DATE/, run.fragment.slice(0, 400));
});

test("the flag's name and the CI caller's posture are stated where this test can see them", () => {
  // Not a style nit: the claim "the gate blocks stale publishes" is only true of a path CI never takes, so the
  // exact invocation is pinned. If someone drops --allow-stale (making the gate blocking in production) or adds a
  // second publisher without it, this fails and the reviewer reads what the two options mean.
  const yml = readFileSync(join(REPO, ".github", "workflows", "freshness-regen.yml"), "utf8");
  const steps = yml.split("\n").filter((l) => /p86:report-library/.test(l) && !l.trim().startsWith("#"));
  assert.equal(steps.length, 1, `expected exactly one p86 invocation in freshness-regen.yml, got ${steps.length}`);
  assert.match(steps[0], /--allow-stale/, `the CI publisher is expected to ship marked-red, not to block:\n${steps[0]}`);
});
