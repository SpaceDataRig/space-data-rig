// Round-25 independent audit of the freshness gate: recompute, from this checkout, every claim the published
// index.json makes about stamped reports, and report only the DISAGREEMENTS. Deliberately does not import
// scripts/report-freshness.ts -- importing the module under audit would let a bug in it hide its own traces.
//
// WHAT THIS FILE'S OWN FIRST TWO VERSIONS GOT WRONG, and why it now says so out loud.
//  (1) It read the stamp only from `doc.meta`. Generators put it in two shapes: nested under `meta`, or spread flat at
//      the top level (p88/p89). The two shapes are exactly the two rows this round was investigating, so the tool
//      printed "stamped=15, disagreements=0" while the published index said 17 -- and the gap was explained in the
//      ledger as a property of the reports instead of a blind spot in the checker. A checker whose coverage is
//      silently smaller than the thing it checks cannot report a clean bill.
//  (2) A row whose JSON file it could not open was `continue`d: skipped, uncounted, unreported. If the index ever
//      claimed `verified: true` for a row whose artifact is missing, this printout would still have said 0.
//  So every row is now accounted for in exactly one named bucket, the row counts of the index and of this tool are
//      compared as a finding rather than as prose, and any finding exits 1 -- this is a gate, not a description.
//
// Scope it does NOT claim: it re-derives the checksum/tracking half of the verdict (an input's recorded sha256 against
// this working tree, and whether git carries that path). The gate additionally deems an input stale when it changed
// after the report was generated; here that shows up as a hash mismatch, because a matching hash recorded after the
// fact is the case the public "machine-checked" wording rests on.
//
// Usage: node scripts/audit/freshness-recheck.mjs [--root <dir>]   (default: cwd; --root lets a test point it at a
// deliberately mis-stamped fixture tree to prove the alarm rings).
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const argv = process.argv;
const ri = argv.indexOf("--root");
const ROOT = ri >= 0 && argv[ri + 1] ? argv[ri + 1] : ".";
const at = (p) => `${ROOT}/${p}`.replace(/^\.\//, "");

const idx = JSON.parse(readFileSync(at("web/reports/index.json"), "utf8"));
const rows = idx.reports || idx.items || [];
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean),
);

// Same normalisation the gate uses: LF-stable text, binary untouched.
function hashFile(rel) {
  try {
    const buf = readFileSync(at(rel));
    const stable = buf.subarray(0, 8192).includes(0) || !buf.includes(13)
      ? buf
      : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "latin1");
    return createHash("sha256").update(stable).digest("hex");
  } catch {
    return null;
  }
}

/** Both artifact shapes, resolved independently of the gate: nested `meta` when present, else the flat document. */
function stampOf(doc) {
  const m = doc && typeof doc === "object" && doc.meta && typeof doc.meta === "object" ? doc.meta : doc;
  if (!m || typeof m !== "object" || typeof m.generatedAt !== "string" || !m.generatedAt) return null;
  const inputs = Array.isArray(m.inputs)
    ? m.inputs.map((i) => (typeof i === "string" ? { path: i, sha256: null } : i))
    : [];
  return { generatedAt: m.generatedAt, shape: m === doc ? "flat" : "meta", inputs };
}

const findings = [];
const observations = []; // published states the index already discloses honestly: printed, never fatal
let checked = 0;
let toolStamped = 0;
let toolVerified = 0;
let indexStamped = 0;
let indexVerified = 0;
let flatShapes = 0;
let absentAgree = 0; // rows with no artifact that the index also calls unattested: explained, not swallowed
let noStampArtifacts = 0; // artifacts this checkout can open that carry no generatedAt in either shape

for (const r of rows) {
  if (r.stamped) indexStamped++;
  if (r.verified) indexVerified++;
  const jsonPath = `reports/${r.id}.json`;
  if (!existsSync(at(jsonPath))) {
    // Named and counted either way; a finding only when the index asserts something about a row this checkout cannot open.
    if (r.stamped || r.verified) findings.push(`${r.id}: index says stamped=${r.stamped} verified=${r.verified} but ${jsonPath} does not exist`);
    else absentAgree++;
    continue;
  }
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(at(jsonPath), "utf8"));
  } catch {
    findings.push(`${r.id}: ${jsonPath} is not valid JSON`);
    continue;
  }
  checked++;
  const stamp = stampOf(doc);
  if (!stamp) {
    noStampArtifacts++;
    if (r.stamped) findings.push(`${r.id}: index says stamped but no generatedAt in either shape`);
    continue;
  }
  toolStamped++;
  if (stamp.shape === "flat") flatShapes++;
  if (!r.stamped) findings.push(`${r.id}: index says unstamped but the artifact carries generatedAt (${stamp.shape} shape)`);

  let reproducible = 0;
  let reproducibleData = 0;
  let hardStale = false;
  const notes = [];
  for (const i of stamp.inputs) {
    if (typeof i.sha256 !== "string" || !i.sha256) {
      if (i.path) notes.push(`no-checksum:${i.path}`);
      continue;
    }
    const cur = hashFile(i.path);
    if (cur === null) { notes.push(`absent:${i.path}`); continue; }
    if (cur !== i.sha256) { hardStale = true; notes.push(`CHANGED:${i.path}`); continue; }
    if (!tracked.has(i.path)) { notes.push(`untracked:${i.path}`); continue; }
    reproducible++;
    // R26-41, mirrored independently of the gate: a code-only stamp re-hashes the algorithm, not the data the
    // numbers derive from, so it must not count toward `verified`. Recomputing it here (rather than importing the
    // gate) is the point -- if the gate's own rule drifts, this disagrees and the alarm rings.
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/i.test(i.path)) reproducibleData++;
  }
  const myVerified = reproducibleData > 0 && !hardStale;
  if (myVerified) toolVerified++;
  if (myVerified !== Boolean(r.verified) || (hardStale && r.fresh !== false)) {
    findings.push(
      `${r.id}: index says verified=${r.verified} fresh=${r.fresh}; independent recompute says verified=${myVerified} stale=${hardStale} ${notes.join(" ")}`,
    );
  } else if (r.rehashed !== undefined && r.rehashed !== reproducible + notes.filter((n) => n.startsWith("untracked")).length) {
    findings.push(
      `${r.id}: counts differ (index rehashed=${r.rehashed}, recomputed=${reproducible + notes.filter((n) => n.startsWith("untracked")).length}) ${notes.join(" ")}`,
    );
  }
  if (stamp.inputs.length === 0) {
    // A stamp with nothing to re-hash. The index already refuses to call it verified, so this is a published-state
    // observation, not a disagreement -- but it is printed, counted and named, because "stamped: 17" is a number a
    // reader meets. If such a row ever claims verified=true, it moves to the fatal bucket instead.
    const line = `${r.id}: stamped with NO inputs, so nothing about it can be re-hashed (index verified=${r.verified})`;
    if (r.verified) findings.push(line);
    else observations.push(line);
  }
}

// The coverage comparison is the finding this tool used to bury in prose: every index row must land in exactly one
// named bucket, and the bucket totals must add up to the number of rows.
const opened = checked;
if (opened + absentAgree !== rows.length) {
  findings.push(`coverage: ${rows.length} index rows but ${opened} opened + ${absentAgree} confirmed absent = ${opened + absentAgree}`);
}
if (toolStamped + noStampArtifacts !== opened) {
  findings.push(`bucket arithmetic: ${opened} opened artifacts = ${toolStamped} stamped + ${noStampArtifacts} carrying no stamp`);
}
if (toolStamped !== indexStamped) findings.push(`stamp coverage: index counts ${indexStamped} stamped, this recheck found ${toolStamped} (${flatShapes} of them flat-shaped)`);
if (toolVerified !== indexVerified) findings.push(`verified count: index publishes ${indexVerified}, independent recompute says ${toolVerified}`);

console.log(
  `index rows=${rows.length} opened=${opened} absent=${absentAgree} unstamped-artifacts=${noStampArtifacts} ` +
    `stamped=${toolStamped}/${indexStamped} (flat-shaped=${flatShapes}) verified=${toolVerified}/${indexVerified}`,
);
console.log(`findings=${findings.length} observations=${observations.length}`);
for (const f of findings) console.log(`  ! ${f}`);
for (const o of observations) console.log(`  ~ ${o}`);
if (findings.length === 0) console.log("  (every index row was opened, both stamp shapes were understood, and every published verified/fresh verdict reproduced independently)");
if (findings.length > 0) process.exitCode = 1;
