// audit-6 P2: keep /health's gitSha HONEST across deploys.
//
// GIT_SHA is a static Worker secret. A plain `wrangler deploy` uploads new code but does NOT touch the secret,
// so after the next deploy /health would still report the PREVIOUS commit -- the very self-proof the audit asked
// for would quietly start lying. This wrapper re-sets GIT_SHA to the current HEAD immediately before deploying,
// so the live gitSha always equals the commit the running code was built from.
//
// It is the RECOMMENDED deploy path (`npm run cf:deploy:sha`); `cf:deploy` stays as the raw escape hatch.
// Set GIT_SHA first, then deploy: the final uploaded version is therefore always the new code carrying the
// matching sha. A dirty working tree only warns (it does not block) but tells you the sha will not fully
// describe the deployed bytes.
//
// Usage:
//   npm run cf:deploy:sha              # set GIT_SHA<-HEAD, then wrangler deploy
//   npm run cf:deploy:sha -- --dry-run # same sha sync, but wrangler deploy --dry-run (no production change)
import { spawnSync } from "node:child_process";

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

const sha = capture("git", ["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`[deploy] could not resolve a 40-hex git HEAD (got "${sha}"); refusing to deploy a wrong gitSha`);
  process.exit(1);
}

if (capture("git", ["status", "--porcelain"])) {
  console.warn("[deploy] WARNING: working tree has uncommitted changes; gitSha will NOT fully describe the deployed bytes");
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
