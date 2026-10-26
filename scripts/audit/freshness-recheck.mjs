// Round-25 independent audit of the freshness gate: recompute, from this checkout, every claim the published
// index.json makes about stamped reports, and report only the DISAGREEMENTS. Deliberately does not import
// scripts/report-freshness.ts -- importing the module under audit would let a bug in it hide its own traces.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8"));
const rows = idx.reports || idx.items || [];
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean),
);

// Same normalisation the gate uses: LF-stable text, binary untouched.
function hashFile(path) {
  try {
    const buf = readFileSync(path);
    const stable = buf.subarray(0, 8192).includes(0) || !buf.includes(13)
      ? buf
      : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "latin1");
    return createHash("sha256").update(stable).digest("hex");
  } catch {
    return null;
  }
}

let stamped = 0;
let verifiedByIndex = 0;
let disagreements = 0;
const detail = [];

for (const r of rows) {
  const jsonPath = `reports/${r.id}.json`;
  if (!existsSync(jsonPath)) continue;
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(jsonPath, "utf8")).meta;
  } catch {
    detail.push(`${r.id}: reports/${r.id}.json is not valid JSON`);
    continue;
  }
  if (!meta || !meta.generatedAt) continue;
  stamped++;
  const inputs = (Array.isArray(meta.inputs) ? meta.inputs : []).map((i) => (typeof i === "string" ? { path: i, sha256: null } : i));
  const anyChecksum = inputs.some((i) => typeof i.sha256 === "string" && i.sha256);
  let reproducible = 0;
  let hardStale = false;
  const notes = [];
  for (const i of inputs) {
    if (typeof i.sha256 !== "string" || !i.sha256) continue;
    const cur = hashFile(i.path);
    if (cur === null) { notes.push(`absent:${i.path}`); continue; }
    if (cur !== i.sha256) { hardStale = true; notes.push(`CHANGED:${i.path}`); continue; }
    if (!tracked.has(i.path)) { notes.push(`untracked:${i.path}`); continue; }
    reproducible++;
  }
  const myVerified = reproducible > 0 && !hardStale;
  if (r.verified) verifiedByIndex++;
  if (myVerified !== Boolean(r.verified) || hardStale !== Boolean(r.stale)) {
    disagreements++;
    detail.push(
      `${r.id}: index says verified=${r.verified} stale=${r.stale}; independent recompute says verified=${myVerified} stale=${hardStale} ${notes.join(" ")}`,
    );
  } else if (r.rehashed !== undefined && r.rehashed !== reproducible + notes.filter((n) => n.startsWith("untracked")).length) {
    detail.push(`${r.id}: counts differ (index rehashed=${r.rehashed}, recomputed=${reproducible + notes.filter((n) => n.startsWith("untracked")).length}) ${notes.join(" ")}`);
  }
  if (!anyChecksum) detail.push(`${r.id}: stamped but records NO checksum at all (index verified=${r.verified})`);
}

console.log(`index rows=${rows.length} stamped=${stamped} index-verified=${verifiedByIndex}`);
console.log(`disagreements=${disagreements}`);
for (const d of detail) console.log(`  ! ${d}`);
if (detail.length === 0) console.log("  (every stamped report's verified/stale verdict reproduces independently)");
