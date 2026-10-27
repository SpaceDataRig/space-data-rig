// ROUND-26 R26-29: the census says "32 unattested rows need a networked re-run." That is necessary but NOT
// sufficient, and this tool measures the missing half. A report only becomes attestable if its GENERATOR writes a
// buildStamp naming its real data inputs; all 32 network generators currently call buildStamp zero times, so a
// fleet re-run today would STILL emit unstamped, unattested rows. And the stamp must name the DATA the numbers
// derive from -- stamping only the generator's own source would flip a row to "verified" while checking nothing
// but "the code file did not change," the hollow false-comfort report-freshness.ts warns against.
//
// So this is a PREP PLAN, not a gate: for each network generator it (a) confirms whether the source already wires
// buildStamp, (b) statically extracts the committed data inputs the source names (reports/*.json, tests/fixtures/*,
// src/data/*.ts), and (c) verifies each such path EXISTS and is GIT-TRACKED -- because a stamp over an absent or
// gitignored path cannot be re-hashed by any other checkout, which is the difference between verifying and
// asserting. It never edits a generator; it tells the next (networked) run exactly what each one must stamp and
// flags any generator whose inputs are not statically determinable so a human reads it rather than guessing.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const tracked = (() => {
  try {
    return new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean));
  } catch {
    return null;
  }
})();

// Scope to the AUTHORITATIVE unattested set: the published index rows the freshness gate marks stamped=false.
// This is the census's 32/33, read from the artifact rather than re-guessed, so the plan cannot drift from what
// the site actually shows. Map each report id's pNN prefix to its generator script (scripts/pNN-*.ts).
const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8"));
const unattested = (idx.reports || []).filter((r) => !r.stamped).map((r) => r.id);
const allScripts = readdirSync("scripts").filter((f) => /^p\d+-.*\.ts$/.test(f));
const rows = [];
for (const id of unattested) {
  const nn = /^p(\d+)/.exec(id)?.[1];
  const file = allScripts.find((f) => f.startsWith(`p${nn}-`));
  if (!file) { rows.push({ script: `scripts/p${nn}-??? (no generator matched id ${id})`, alreadyStamped: false, inputs: [], missing: [], untracked: [], determinable: false }); continue; }
  const src = readFileSync(`scripts/${file}`, "utf8");
  const alreadyStamped = /buildStamp\(/.test(src);
  // Committed data inputs the source references by literal path. EXCLUDE the generator's own OUTPUT report
  // (a "reports/pNN-*.json" with the same pNN it writes): naming your own output as your input is circular and
  // would let a stamp "verify" a file against itself. What survives is a genuine upstream committed input.
  const inputs = new Set();
  for (const m of src.matchAll(/["'`](reports\/p[\w.-]+\.json|tests\/fixtures\/[\w./-]+|src\/data\/[\w.-]+\.ts)["'`]/g)) {
    if (m[1] === `reports/${id}.json`) continue; // the generator's own output, not an input
    inputs.add(m[1]);
  }
  const missing = [];
  const untracked = [];
  for (const p of inputs) {
    if (!existsSync(p)) missing.push(p);
    else if (tracked && !tracked.has(p)) untracked.push(p);
  }
  rows.push({ id, script: `scripts/${file}`, alreadyStamped, inputs: [...inputs].sort(), missing, untracked, determinable: inputs.size > 0 });

}


rows.sort((a, b) => a.script.localeCompare(b.script));
const needWiring = rows.filter((r) => !r.alreadyStamped).length;
const noStaticInputs = rows.filter((r) => !r.determinable).map((r) => r.script);
const badPaths = rows.filter((r) => r.missing.length || r.untracked.length).map((r) => r.script);

console.log(`network generators in scope: ${rows.length}`);
console.log(`  already stamped: ${rows.length - needWiring}`);
console.log(`  need write-side wiring: ${needWiring}`);
console.log(`  whose committed inputs are statically determinable: ${rows.filter((r) => r.determinable).length}`);
console.log(`  NO static committed input found (human must read the fetch/derive path): ${noStaticInputs.length}`);
for (const s of noStaticInputs) console.log(`    ? ${s}`);
console.log(`  reference a committed path that is absent or untracked: ${badPaths.length}`);
for (const s of badPaths) console.log(`    ! ${s}`);
console.log(`\nper-generator stamping plan (inputs to name in buildStamp, plus the generator's own script):`);
for (const r of rows) {
  if (r.alreadyStamped) continue;
  console.log(`  ${r.script}  ->  buildStamp([${r.inputs.map((x) => `"${x}"`).join(", ")}${r.inputs.length ? ", " : ""}"${r.script}"${r.determinable ? "" : "  /* INPUTS UNDETERMINED -- read before wiring */"}])`);
}
