// round-26 census: of the reports the site publishes as unattested, which generators could be re-run on a machine
// with NO network at all? The point is to shrink "unattested: 39" with real re-runs rather than by writing stamps by
// hand, so the first question is which rows are even reachable offline.
//
// Heuristic, stated so it can be argued with: a generator is offline-capable when it reads only files under
// tests/fixtures/ or reports/ and never reaches a fetch/https module or a URL literal. Anything that resolves an
// archive (ExoFOP, MAST, Gaia TAP, VIZIER) is network-bound by definition.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8"));
const rows = idx.reports || [];
const unstamped = rows.filter((r) => !r.stamped);

const NETWORK = /\bfetch\(|https?:\/\/|node:https?|node:http\b|axios|mastS3|gaiaDilution|gaiaRv|toiDispositions|exofop|vizier|archivePath|downloadFile/i;
const FIXTURE = /tests\/fixtures|reports\/|\.jsonl|\.csv|\.fits/i;

function candidates(id) {
  const base = `scripts/${id}.ts`;
  if (existsSync(base)) return [base];
  // the four known exceptions: the id does not match a script name; look for a script that mentions the report id
  const hits = readdirSync("scripts").filter((f) => f.endsWith(".ts") && f.startsWith(id.split("-")[0] + "-"));
  return hits.map((f) => `scripts/${f}`);
}

const buckets = { offline: [], network: [], noGenerator: [] };
for (const r of unstamped) {
  const files = candidates(r.id);
  if (files.length === 0) {
    buckets.noGenerator.push(r.id);
    continue;
  }
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const net = NETWORK.test(src);
  if (net) buckets.network.push(`${r.id} (${files[0]})`);
  else buckets.offline.push(`${r.id} (${files[0]}, fixture-ish=${FIXTURE.test(src)})`);
}

console.log(`unattested rows: ${unstamped.length}`);
console.log(`\nNO GENERATOR FOUND (${buckets.noGenerator.length}):\n  ${buckets.noGenerator.join("\n  ")}`);
console.log(`\nOFFLINE-CAPABLE by this heuristic (${buckets.offline.length}):`);
for (const x of buckets.offline) console.log("  " + x);
console.log(`\nNETWORK-BOUND (${buckets.network.length}):`);
for (const x of buckets.network) console.log("  " + x);

// Cross-check the census itself: how many unattested rows did we classify at all?
const classified = buckets.offline.length + buckets.network.length + buckets.noGenerator.length;
if (classified !== unstamped.length) {
  console.log(`\nCENSUS ARITHMETIC FAILS: ${classified} classified vs ${unstamped.length} rows`);
  process.exitCode = 1;
} else {
  console.log(`\ncensus accounts for every unattested row: ${classified}/${unstamped.length}`);
}
const gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
console.log(`HEAD=${gitSha}`);
