// round-26 mutation drill: prove tests/generator-stamped-reports.test.ts actually fires on the two faults it claims
// to catch -- (1) a generator that stops stamping, (2) an artifact whose recorded checksum no longer matches the repo.
// Restores both files byte-for-byte afterwards and re-checks.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const targets = ["scripts/p79-benchmark.ts", "reports/p79-benchmark.json"];
for (const t of targets) copyFileSync(t, `${t}.mutbak`);

function runTest() {
  const r = spawnSync("node", ["--import", "tsx", "--test", "tests/generator-stamped-reports.test.ts"], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  // node:test's spec reporter marks a failure with U+2716 and prints the counts after; grep both, plus the
  // assertion text, so the drill records WHICH of the four checks fired rather than only that the suite was red.
  const failed = out.split("\n").filter((l) => l.includes("\u2716") && !l.includes("fail")).map((l) => l.trim().slice(0, 100));
  const counts = out.split("\n").filter((l) => /^(?:[\u2139#]\s*)?(tests|pass|fail|cancelled)\s+\d/.test(l.replace(/^[\u2139#]\s*/, ""))).map((l) => l.trim().slice(0, 40));
  const reason = (out.match(/AssertionError[^\n]*\n?[^\n]*/) || [""])[0].slice(0, 160);
  return { code: r.status, failed, counts, reason };
}

// Fault 1: the generator stops calling buildStamp (its artifact stays as-is, so the artifact alone looks fine).
let src = readFileSync("scripts/p79-benchmark.ts", "utf8");
src = src.replace("    ...buildStamp([\"reports/p47-completeness-grid.json\"", "    ...noStamp([\"reports/p47-completeness-grid.json\"");
writeFileSync("scripts/p79-benchmark.ts", src);
console.log("FAULT-1 (generator no longer calls buildStamp):", JSON.stringify(runTest(), null, 1));
copyFileSync("scripts/p79-benchmark.ts.mutbak", "scripts/p79-benchmark.ts");

// Fault 2: an artifact carries a checksum that does not match the bytes in the repository.
let art = readFileSync("reports/p79-benchmark.json", "utf8");
const before = art;
art = art.replace(/"sha256": "([0-9a-f]{6})/, '"sha256": "000000');
if (art === before) throw new Error("mutation 2 did not change anything");
writeFileSync("reports/p79-benchmark.json", art);
console.log("FAULT-2 (recorded checksum corrupted):", JSON.stringify(runTest(), null, 1));
copyFileSync("reports/p79-benchmark.json.mutbak", "reports/p79-benchmark.json");

console.log("RESTORED:", JSON.stringify(runTest(), null, 1));
for (const t of targets) rmSync(`${t}.mutbak`);
