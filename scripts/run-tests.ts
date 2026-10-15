// Test runner: DISCOVERS every tests/*.test.ts instead of relying on a hand-maintained file list.
//
// WHY (audit finding #5). `npm test` used to be one long hand-enumerated string of file names, so a
// new test file could be added and then silently never run -- the exact failure mode you do not want
// in a project whose whole brand is "we check ourselves". Node's built-in test runner does not match
// .ts in its default discovery, so we enumerate the directory ourselves and pass the explicit list.
//
// The FLOOR guard makes a *discovery* failure loud: if the directory/filter ever breaks and matches
// only a handful of files, we fail instead of reporting a green-but-empty run.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const testsDir = join(root, "tests");

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

const FLOOR = 60; // bumped as the suite grows; guards against a discovery regression, not a per-PR target
if (files.length < FLOOR) {
  console.error(`FAIL: only ${files.length} test files discovered in tests/ (< floor ${FLOOR}).`);
  console.error("A new test was likely left off -- or discovery broke. Fix before trusting a green run.");
  process.exit(1);
}

const wantCoverage = process.argv.includes("--coverage");
const runnerArgs = ["--import", "tsx", "--test"];
if (wantCoverage) {
  // Node's built-in V8 coverage -- no third-party dependency. Measured: line ~96%, branch ~80%, function ~92%.
  // Floors sit at 85 (lines) / 75 (branches) to leave headroom for runtime differences while still failing a
  // real drop. audit-10 #11 widened the gate from lines-only to also enforce BRANCH coverage.
  runnerArgs.push("--experimental-test-coverage", "--test-coverage-lines=85", "--test-coverage-branches=75");
}
runnerArgs.push(...files.map((f) => join(testsDir, f)));

console.log(`Discovered ${files.length} test files under tests/${wantCoverage ? " (with coverage)" : ""}.`);
const child = spawnSync(process.execPath, runnerArgs, { stdio: "inherit", cwd: root });
process.exit(child.status ?? 1);
