// round-26 drill for the widened scope in tests/handoff-freshness.test.ts: the R25-11 check used to search for the
// `awaiting deploy` marker on the FIRST LINE of the Production bullet only, which made a disclosure written one line
// down (where it naturally belongs, next to the version id it qualifies) fail the gate for a formatting reason. The
// scope now covers the bullet. This proves the widened check is not vacuous: delete the marker words, the gate must go
// red naming the same three files; put them back, green.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const P = "HANDOFF.md";
const orig = readFileSync(P, "utf8");

function run() {
  const r = spawnSync("node", ["--import", "tsx", "--test", "tests/handoff-freshness.test.ts"], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const counts = out.split("\n").filter((l) => /^(?:[\u2139#]\s*)?(pass|fail)\s+\d/.test(l.replace(/^[\u2139#]\s*/, "")));
  const why = (out.match(/AssertionError[^\n]*/) || [""])[0].slice(0, 150);
  return { code: r.status, counts: counts.map((c) => c.trim()), why };
}

if (!orig.includes("AWAITING DEPLOY")) throw new Error("the marker is not in the handoff; this drill would prove nothing");
// Strip EVERY case variant of the phrase, not just the first: the bullet also quotes the marker historically ("the
// interim marker this bullet carried ..."), and replacing only the first hit would delete that mention and leave the
// live marker in place -- a drill that reports success about nothing.
writeFileSync(P, orig.replace(/awaiting deploy/gi, "PENDING (marker removed for a drill)"), "utf8");
console.log("WITHOUT THE MARKER:", JSON.stringify(run()));
writeFileSync(P, orig, "utf8");
console.log("RESTORED:", JSON.stringify(run()));
console.log("handoff byte-identical again:", readFileSync(P, "utf8") === orig);
