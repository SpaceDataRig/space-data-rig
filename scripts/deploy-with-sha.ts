// audit-6 P2: keep /health's gitSha HONEST across deploys.
//
// GIT_SHA is a static Worker secret. A plain `wrangler deploy` uploads new code but does NOT touch the secret,
// so after the next deploy /health would still report the PREVIOUS commit -- the very self-proof the audit asked
// for would quietly start lying. This wrapper re-sets GIT_SHA to the current HEAD immediately before deploying,
// so the live gitSha always equals the commit the running code was built from.
//
// It is the RECOMMENDED deploy path (`npm run cf:deploy:sha`); `cf:deploy` stays as the raw escape hatch.
// Set GIT_SHA first, then deploy: the final uploaded version is therefore always the new code carrying the
// matching sha. A DIRTY WORKING TREE IS REFUSED (audit pass 5, 2026-10-18).
//
// WHY IT BECAME A BLOCKER RATHER THAN A WARNING. wrangler uploads the files on disk; GIT_SHA is set from `git
// rev-parse HEAD`. Those two are only the same thing when the tree is clean. An automated deploy that fired between
// commits uploaded work in progress while /health certified the last committed revision -- and for 75 minutes
// (09:19Z to 10:38Z) production ran code that existed in no commit, no CI run and no review, while /health.gitSha
// named a commit that did not contain it. Every downstream proof inherited the lie: "the deployed bytes are the
// reviewed bytes" stopped being true exactly where it mattered most, because the records written in that window
// were produced by a renderer nobody had merged. A warning that does not stop that is a notice to whoever happens
// to read the console. `--allow-dirty` is the escape hatch for a deliberate emergency, and it says so loudly.
//
// Usage:
//   npm run cf:deploy:sha              # set GIT_SHA<-HEAD, then wrangler deploy (clean tree required)
//   npm run cf:deploy:sha -- --dry-run # same sha sync, but wrangler deploy --dry-run (no production change)
//   npm run cf:deploy:sha -- --allow-dirty [--dry-run]  # deploy anyway; states the risk in the log
import { spawnSync } from "node:child_process";
import { deployDecision } from "../src/deploy/deployGuard.ts";

const isWin = process.platform === "win32";

/** Run a command, inheriting stdio except stdin (which we may feed). Returns the exit code. */
function run(cmd: string, args: string[], stdin?: string): number {
  const r = spawnSync(cmd, args, {
    stdio: ["pipe", "inherit", "inherit"],
    input: stdin,
    shell: isWin, // resolve npx.cmd / git.exe on Windows
  });
  if (r.error) {
    console.error(`[deploy] failed to spawn ${cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

/** Capture a command's stdout (trimmed), or "" on failure. */
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin });
  return (r.stdout ?? "").trim();
}

const dry = process.argv.includes("--dry-run");

// The rule lives in src/deploy/deployGuard.ts so it can be tested without uploading anything; the wiring
// assertion in tests/deploy-guard.test.ts is what keeps this call site honest.
const sha = capture("git", ["rev-parse", "HEAD"]);
const decision = deployDecision(sha, capture("git", ["status", "--porcelain"]), {
  allowDirty: process.argv.includes("--allow-dirty"),
});
if (!decision.ok) {
  console.error(`[deploy] REFUSED: ${decision.reason}`);
  for (const d of decision.dirty) console.error(`[deploy]   not in HEAD: ${d}`);
  process.exit(1);
}
if (decision.dirty.length) {
  console.warn(`[deploy] WARNING (--allow-dirty): ${decision.reason}`);
  console.warn("[deploy] /health.gitSha will name a commit that does NOT contain:");
  for (const d of decision.dirty) console.warn(`[deploy]   ${d}`);
}

console.log(`[deploy] GIT_SHA <- ${sha}${dry ? " (dry-run: secret NOT written, deploy NOT uploaded)" : ""}`);

if (!dry) {
  // wrangler reads the secret value from stdin when it is not a TTY (verified: piping works non-interactively).
  const s = run("npx", ["wrangler", "secret", "put", "GIT_SHA"], `${sha}\n`);
  if (s !== 0) {
    console.error("[deploy] failed to set the GIT_SHA secret; aborting so /health cannot report a stale sha");
    process.exit(s);
  }
}

const deployArgs = dry ? ["wrangler", "deploy", "--dry-run"] : ["wrangler", "deploy"];
process.exit(run("npx", deployArgs));
