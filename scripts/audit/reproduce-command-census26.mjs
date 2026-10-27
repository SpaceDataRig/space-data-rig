// round-26 R26-15: the report library promises a reader can re-run what the site publishes. `web/reports/index.json`
// carries a `reproduce` command per row, scraped by scripts/report-md.ts out of a `Reproduce: \`...\`` line in the
// report's own markdown. Rows without that line still render, still count toward `verified`, and simply withhold the
// command -- a gap the freshness gate cannot see, because it is about HOW a report is presented, not whether its bytes
// match. This census names every such row and whether the generator could be re-run here at all.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8"));
const missing = (idx.reports || []).filter((r) => !(r.reproduce || "").trim());
console.log(`rows: ${(idx.reports || []).length}, without a reproduce command: ${missing.length}`);
const NETWORK = /\bfetch\(|https?:\/\/|node:https?|node:http\b|axios|mastS3|exofop|vizier|out\/scaled/i;
for (const r of missing) {
  const gen = `scripts/${r.id}.ts`;
  let why = "no generator file by that name";
  try {
    const src = readFileSync(gen, "utf8");
    const hasReproduce = /Reproduce: `/.test(src);
    why = `network-bound=${NETWORK.test(src)} md-writes-Reproduce=${hasReproduce}`;
  } catch { /* left as stated */ }
  console.log(`  ${r.id.padEnd(32)} stamped=${r.stamped} verified=${r.verified} | ${why}`);
}
console.log("\nFix path: add the Reproduce line to the GENERATOR (hand-editing a generated .md recreates the defect the");
console.log("freshness gate exists to catch), then re-run it. tests/report-reproduce-command.test.ts ratchets the list.");
const gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
console.log(`HEAD=${gitSha}`);
