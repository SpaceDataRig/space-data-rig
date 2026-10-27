// round-26 census, second pass. The first pass asked "which unattested rows could be re-run offline" and the answer
// was 5, all of which turned out to be stamp-less generators (now fixed). That leaves 32 rows, and "32 unattested"
// is not one number: it is three different problems with three different fixes, and treating them alike is how the
// count survived this long. This pass splits them by WHAT ACTUALLY BLOCKS them, using only files in the repository.
//
//   A. generator calls buildStamp over tracked inputs only -> a re-run on a machine with network turns the row
//      verified. Blocked by reachability, nothing else. This is the bucket that should shrink first.
//   B. generator calls buildStamp but over at least one path the repository does NOT carry (out/scaled/*.jsonl is
//      the real case) -> even a perfect re-run leaves the row unverifiable on any fresh clone, because the checksum
//      is a private fact about one workstation. Fixing it means committing the input or dropping it from the stamp.
//   C. generator writes no stamp at all -> needs the same edit round-26 just made for the offline five, then a
//      re-run (which may need network).
//   D. no generator found by the id convention -> the row can never be re-run by anyone, and the site publishes it
//      on trust alone.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8"));
const rows = idx.reports || [];
const unstamped = rows.filter((r) => !r.stamped);

const tracked = new Set(
  spawnSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout.split("\n").map((s) => s.trim()).filter(Boolean),
);

const NETWORK = /\bfetch\(|https?:\/\/|node:https?|node:http\b|axios|mastS3|gaiaDilution|gaiaRv|toiDispositions|exofop|vizier|archivePath|downloadFile/i;

function generatorFor(id) {
  const base = `scripts/${id}.ts`;
  if (existsSync(base)) return base;
  const prefix = id.split("-")[0] + "-";
  const hits = readdirSync("scripts").filter((f) => f.endsWith(".ts") && f.startsWith(prefix));
  return hits.length ? `scripts/${hits[0]}` : null;
}

const buckets = { A: [], B: [], C: [], D: [] };
for (const r of unstamped) {
  const g = generatorFor(r.id);
  if (!g) { buckets.D.push(`${r.id} (index says reproduce="${r.reproduce}")`); continue; }
  const src = readFileSync(g, "utf8");
  if (!/buildStamp\(/.test(src)) {
    buckets.C.push(`${r.id} (${g}, network-needed=${NETWORK.test(src)})`);
    continue;
  }
  // The generator does stamp. Which paths did it record, and are they all carried by the repository?
  const art = `reports/${r.id}.json`;
  if (!existsSync(art)) { buckets.B.push(`${r.id} (${g} stamps, but ${art} is not in the tree)`); continue; }
  const doc = JSON.parse(readFileSync(art, "utf8"));
  const inputs = (doc.meta && doc.meta.inputs) || doc.inputs || [];
  const untracked = inputs.filter((i) => typeof i === "object" && i.path && !tracked.has(i.path)).map((i) => i.path);
  if (untracked.length) buckets.B.push(`${r.id} (${g}: untracked input ${untracked.join(", ")})`);
  else buckets.A.push(`${r.id} (${g}, inputs=${inputs.length}, network-needed=${NETWORK.test(src)})`);
}

const total = Object.values(buckets).reduce((a, b) => a + b.length, 0);
for (const k of ["A", "B", "C", "D"]) {
  console.log(`\n${k} -- ${buckets[k].length} row(s)`);
  for (const x of buckets[k]) console.log("   " + x);
}
console.log(`\nunattested rows: ${unstamped.length}, classified: ${total}`);
if (total !== unstamped.length) { console.log("CENSUS ARITHMETIC FAILS"); process.exitCode = 1; }
