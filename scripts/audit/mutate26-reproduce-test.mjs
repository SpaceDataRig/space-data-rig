// round-26 drill for tests/report-reproduce-command.test.ts: prove both directions of the ratchet actually fire.
// Fault 1 -- a row outside the allow-list loses its command (the gate must complain).
// Fault 2 -- a row the allow-list still excuses GAINS a command (the list must be pruned, or it becomes a stale claim).
// The index is regenerated from the reports by p86, so both faults are injected into the built artifact and restored
// from a byte-exact backup, and the final "RESTORED" run shows the file is exactly as it was.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const P = "web/reports/index.json";
copyFileSync(P, `${P}.rbak`);
const orig = readFileSync(P, "utf8");

function run() {
  const r = spawnSync("node", ["--import", "tsx", "--test", "tests/report-reproduce-command.test.ts"], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const counts = out.split("\n").filter((l) => /^(?:[\u2139#]\s*)?(tests|pass|fail)\s+\d/.test(l.replace(/^[\u2139#]\s*/, "")));
  const names = out.split("\n").filter((l) => l.includes("\u2716") && !l.includes("fail")).map((l) => l.trim().slice(0, 90));
  const reason = (out.match(/AssertionError[^\n]*/) || [""])[0].slice(0, 170);
  return { code: r.status, counts, names, reason };
}

function edit(fn) {
  const doc = JSON.parse(readFileSync(P, "utf8"));
  fn(doc.reports);
  writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

// Fault 1: take the command away from a row that is NOT excused.
edit((rows) => { const r = rows.find((x) => x.id === "p34-cost-model"); r.reproduce = ""; });
console.log("FAULT-1 (unexcused row loses its command):", JSON.stringify(run(), null, 1));
writeFileSync(P, orig, "utf8");

// Fault 2: an excused row now has a command, so the allow-list is stale.
edit((rows) => { const r = rows.find((x) => x.id === "p85-contaminant-fit"); r.reproduce = "npm run p85:contaminant-fit"; });
console.log("FAULT-2 (allow-list not pruned):", JSON.stringify(run(), null, 1));
writeFileSync(P, orig, "utf8");

console.log("RESTORED:", JSON.stringify(run(), null, 1));
console.log("byte-identical to the original:", readFileSync(P, "utf8") === orig);
rmSync(`${P}.rbak`);
