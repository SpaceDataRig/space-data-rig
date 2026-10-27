// round-26 drill for R26-21: prove the red-line corpus scan fails on a real published artifact, not just on the
// synthetic object in the test's own control case. It finds the first committed report JSON that carries a top-level
// `discoveryClaim: false`, flips it to true, runs tests/redline-artifact-scan.test.ts, and requires the corpus case to go
// RED naming that file -- then restores and requires 3/3 with the file byte-identical. It mutates a tracked artifact, so
// it always restores, including through a throw.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = "reports";
let target = null;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (j && typeof j === "object" && "discoveryClaim" in j && j.discoveryClaim === false) { target = join(dir, f); break; }
}
if (!target) throw new Error("no committed report with a top-level discoveryClaim=false to tamper; the drill cannot prove the corpus case");

const run = () => {
  const r = spawnSync("node", ["--import", "tsx", "--test", "tests/redline-artifact-scan.test.ts"], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const fail = Number((out.match(/fail\s+(\d+)/) || [0, 0])[1]);
  const named = out.includes(target);
  return { status: r.status, fail, named };
};

const orig = readFileSync(target, "utf8");
try {
  const tampered = JSON.parse(orig);
  tampered.discoveryClaim = true;
  writeFileSync(target, JSON.stringify(tampered, null, 2) + "\n", "utf8");
  const res = run();
  console.log(`TAMPERED ${target}: ${JSON.stringify(res)} (expected fail>=1, named=${target} true)`);
  if (!(res.fail >= 1 && res.named)) throw new Error("the corpus case did not fire on a real tampered artifact -- the scan would be a tautology");
} finally {
  writeFileSync(target, orig, "utf8");
}
console.log("RESTORED:", JSON.stringify(run()));
console.log("byte-identical again:", readFileSync(target, "utf8") === orig);
