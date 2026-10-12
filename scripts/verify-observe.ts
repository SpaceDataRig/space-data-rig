// VERIFY-OBSERVE -- one-click end-to-end gate for the named-observation feature.
//
// Runs the deterministic, no-money, no-chain checks that must ALL pass before this feature is trusted:
//   (1) rebuild the browser burn bundle (esbuild),
//   (2) typecheck BOTH runtimes (Node + Worker + scripts),
//   (3) the full unit suite (which proves the commission money-gates offline -- no payment -> 402, a bad burn ->
//       402 -- so no network is needed),
//   (4) an ASCII scan of the observe feature sources (English-only) and the committed bundle,
//   (5) a secret scan of the sources (never the third-party bundle).
// Then, best-effort, it runs the p24 --commission PoC (fabricated burn; real photometry DATA only, no chain/money)
// as an informational smoke -- it does NOT gate the result, because it needs the network.
//
// The LIVE on-chain spend + a real anchor is a separate, deliberate step (wrangler deploy with OBSERVE_ANCHOR=live
// in a safe window), NOT here. Exit 0 = gate green.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(label: string, args: string[]): boolean {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync("npm", args, { cwd: REPO, shell: true, stdio: "inherit" });
  const ok = r.status === 0;
  console.log(`${label}: ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const obsDir = resolve(REPO, "src/observe");
  for (const f of readdirSync(obsDir)) if (f.endsWith(".ts")) files.push(resolve(obsDir, f));
  files.push(resolve(REPO, "web/app.js"), resolve(REPO, "web/index.html"), resolve(REPO, "web/styles.css"));
  return files;
}

function featureFiles(): string[] {
  const files = sourceFiles();
  const bundle = resolve(REPO, "web/vendor/solana-burn.js");
  if (existsSync(bundle)) files.push(bundle);
  return files;
}

function asciiCheck(): boolean {
  let bad = 0;
  for (const f of featureFiles()) {
    for (const x of readFileSync(f)) if (x > 127) bad++;
  }
  console.log(`non-ASCII bytes across observe feature files: ${bad}`);
  return bad === 0;
}

function secretScan(): boolean {
  // Built from concatenated fragments so this SOURCE never contains a contiguous secret marker (which would make
  // the repo-wide release scanner self-match this very file). Each marker + a short suffix is reassembled at runtime.
  const markers = ["alch" + "_", "ghp" + "_", "sk" + "-", "xai" + "-", "-" + "----" + "BEGIN"];
  const pat = new RegExp(markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[A-Za-z0-9]{4,}").join("|") + "|SOLANA_KEYPAIR\\s*=\\s*\\[");
  let hit = false;
  for (const f of sourceFiles()) {
    if (pat.test(readFileSync(f, "utf8"))) {
      hit = true;
      console.log(`SECRET PATTERN in ${f}`);
    }
  }
  console.log(`secret scan (sources): ${hit ? "HIT" : "clean"}`);
  return !hit;
}

const hard: boolean[] = [];
hard.push(run("bundle", ["run", "web:bundle"]));
hard.push(run("typecheck", ["run", "typecheck:all"]));
hard.push(run("tests", ["test"]));
console.log("\n=== ascii check ===");
hard.push(asciiCheck());
console.log("\n=== secret scan ===");
hard.push(secretScan());

console.log("\n=== p24 commission PoC (best-effort, informational) ===");
const p24 = spawnSync("npm", ["run", "p24:named-observation", "--", "--tic=25155310", "--sectors=4", "--commission", "--dedication=for-the-night-sky"], { cwd: REPO, shell: true, stdio: "inherit" });
console.log(`p24 commission exit=${p24.status} (informational; the deterministic gating is covered by the unit tests offline)`);

const pass = hard.every(Boolean);
console.log(`\nE2E: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
