// ROUND-25 (R25-7): the independent recheck of the freshness gate was itself gated by nothing -- and it had the same
// blind spot the gate exists to catch.
//
// It read the stamp from `doc.meta` only. Generators emit two shapes: nested under `meta`, or spread flat at the top
// level (p88/p89 do the latter). The rows it could not see were precisely the two rows this round was sent to
// investigate, so it printed "stamped=15, disagreements=0" against a published index that said 17, and the gap was
// written into the ledger as a property of the reports rather than of the checker. It also `continue`d past any row
// whose JSON it could not open, so a verified=true claim over a missing artifact would have scored as agreement.
//
// These tests run the REAL script (no import) over (a) this checkout, asserting the buckets add up rather than
// trusting a zero, and (b) throwaway repos holding deliberately mis-stamped indexes, asserting the alarm rings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const TOOL = join(REPO, "scripts", "audit", "freshness-recheck.mjs");

type FixtureRow = {
  id: string;
  stamped: boolean;
  verified: boolean;
  fresh: boolean;
  rehashed: number;
};

/** sha256 over the same normalisation the gate uses; fixtures are written LF-only so this is the plain bytes. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function initRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdr-recheck-"));
  const r = spawnSync("git", ["init", "-q", "."], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
}

function commitAll(dir: string): void {
  let r = spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git add failed: ${r.stderr}`);
  r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `git commit failed: ${r.stderr}`);
}

/**
 * One flat-shaped stamped report over one tracked input. `mode` chooses how the published index should mislead.
 */
function buildFixture(dir: string, mode: "honest" | "claims-verified-over-missing-artifact" | "misses-a-flat-stamp"): {
  out: string;
  code: number;
} {
  const INPUT = "src/data/thing.ts";
  const inputText = "export const THING = 1;\n";
  mkdirSync(join(dir, "src", "data"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "web", "reports"), { recursive: true });
  writeFileSync(join(dir, INPUT), inputText, "utf8");
  // Commit FIRST so the input is tracked, then write the artifacts (which the test does not need tracked).
  commitAll(dir);

  const row: FixtureRow = { id: "p99-flat", stamped: true, verified: false, fresh: true, rehashed: 0 };
  if (mode === "honest") {
    // A flat-shaped stamp whose recorded checksum does match a tracked file, published as verified=true: the case the
    // old tool could not see at all, so it would have reported rows=1 stamped=0 with nothing to complain about.
    row.verified = true;
    row.rehashed = 1;
    writeFileSync(
      join(dir, "reports", "p99-flat.json"),
      JSON.stringify({ generatedAt: "2026-10-26T00:00:00.000Z", inputs: [{ path: INPUT, sha256: sha256(inputText) }] }, null, 2),
      "utf8",
    );
  } else if (mode === "claims-verified-over-missing-artifact") {
    row.verified = true;
    row.rehashed = 1;
    // deliberately NO reports/p99-flat.json
  } else {
    // flat stamp whose recorded checksum no longer matches, published as fresh+verified
    row.verified = true;
    row.rehashed = 1;
    writeFileSync(
      join(dir, "reports", "p99-flat.json"),
      JSON.stringify({ generatedAt: "2026-10-26T00:00:00.000Z", inputs: [{ path: INPUT, sha256: sha256("different bytes\n") }] }, null, 2),
      "utf8",
    );
  }
  writeFileSync(join(dir, "web", "reports", "index.json"), JSON.stringify({ reports: [row] }, null, 2), "utf8");

  const run = spawnSync(process.execPath, [TOOL, "--root", dir], { cwd: dir, encoding: "utf8" });
  return { out: `${run.stdout || ""}${run.stderr || ""}`, code: run.status ?? -1 };
}

test("the recheck accounts for EVERY row of this checkout's index, and the buckets add up", () => {
  const run = spawnSync(process.execPath, [TOOL], { cwd: REPO, encoding: "utf8" });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  assert.equal(run.status, 0, `the recheck must pass on a clean checkout:\n${out}`);
  const m = out.match(/index rows=(\d+) opened=(\d+) absent=(\d+) unstamped-artifacts=(\d+) stamped=(\d+)\/(\d+).*verified=(\d+)\/(\d+)/);
  assert.ok(m, `summary line not in expected shape:\n${out}`);
  const [, rows, opened, absent, , tStamped, iStamped, tVerified, iVerified] = m.map(Number);
  assert.equal(opened + absent, rows, "every index row must be either opened or confirmed absent");
  assert.equal(iStamped, tStamped, "the tool must see as many stamps as the index publishes");
  assert.equal(iVerified, tVerified, "the tool must re-derive as many verified rows as the index publishes");
  assert.match(out, /flat-shaped=\d+/);
  // The published index's own numbers, read straight from the artifact, so the test cannot be satisfied by the tool
  // agreeing with a stale copy of them.
  const idx = JSON.parse(readFileSync(join(REPO, "web", "reports", "index.json"), "utf8")) as {
    reports: { stamped: boolean; verified: boolean }[];
  };
  assert.equal(iStamped, idx.reports.filter((r) => r.stamped).length);
  assert.equal(iVerified, idx.reports.filter((r) => r.verified).length);
});

test("a flat-shaped stamp is understood: the verified row the old tool could not see is now counted", () => {
  const f = buildFixture(initRoot(), "honest");
  assert.equal(f.code, 0, f.out);
  assert.match(f.out, /stamped=1\/1/);
  assert.match(f.out, /verified=1\/1/);
  assert.match(f.out, /flat-shaped=1/);
});

test("verified=true over a row whose artifact cannot be opened is a finding, not a silent skip", () => {
  const f = buildFixture(initRoot(), "claims-verified-over-missing-artifact");
  assert.equal(f.code, 1, `the alarm must ring:\n${f.out}`);
  assert.match(f.out, /does not exist/);
  assert.match(f.out, /findings=[1-9]/);
});

test("a mismatched checksum inside a flat stamp is reported as CHANGED, not as agreement", () => {
  const f = buildFixture(initRoot(), "misses-a-flat-stamp");
  assert.equal(f.code, 1, `the alarm must ring:\n${f.out}`);
  assert.match(f.out, /CHANGED:src\/data\/thing\.ts/);
});
