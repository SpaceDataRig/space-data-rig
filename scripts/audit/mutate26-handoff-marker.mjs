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

// Scope the drill to the PRODUCTION bullet only -- exactly the region tests/handoff-freshness.test.ts inspects. A
// whole-file regex also matches the RULE's prose elsewhere (round-25/26 history that mentions "awaiting deploy"), which
// both fakes a positive precondition and mutates descriptive text the gate never reads. Extract the bullet region.
const lines = orig.split("\n");
const start = lines.findIndex((l) => /^\s*-\s+Production:/i.test(l));
if (start < 0) { console.log("SKIP: no `- Production:` bullet in HANDOFF.md; nothing to drill."); process.exit(0); }
let end = start + 1;
while (end < lines.length && !/^(?:\s*-\s+\S|\s*##\s)/.test(lines[end])) end++;
const head = lines.slice(0, start);
const body = lines.slice(start, end);
const tail = lines.slice(end);
const bulletText = body.join("\n");

// No live marker means the Production bullet already names a deployed revision whose src/ and web/ trees equal HEAD's,
// so there is nothing to strip and the drill cannot prove the negative here. That is a legitimate state (the deploy has
// landed), NOT a crash-worthy anomaly -- per R26-25 "fails loudly" is not "fails legibly". Verify the live gate is
// green and report SKIP, so the operator learns the situation instead of meeting a stack.
if (!/awaiting deploy/i.test(bulletText)) {
  const green = run();
  const ok = green.code === 0 && !green.counts.some((c) => /\bfail\s+[1-9]/.test(c));
  console.log("SKIP: the `- Production:` bullet carries no live 'awaiting deploy' marker (deployed revision matches HEAD's src/ and web/).");
  console.log("Nothing to strip; verified the live gate instead:", JSON.stringify(green));
  console.log(ok ? "RESULT: gate GREEN in the no-marker state, as expected (drill not applicable right now)."
    : "RESULT: gate is RED even without a strip -- investigate, the bullet should not need the marker here.");
  process.exit(ok ? 0 : 1);
}
// A live marker IS present: strip EVERY case variant inside the bullet only (a disclosure can sit on any bullet line,
// and leaving one quote behind would keep the marker in place -- a drill that reports success about nothing).
const stripped = [...head, ...bulletText.replace(/awaiting deploy/gi, "PENDING (marker removed for a drill)").split("\n"), ...tail].join("\n");
writeFileSync(P, stripped, "utf8");
console.log("WITHOUT THE MARKER:", JSON.stringify(run()));
writeFileSync(P, orig, "utf8");
console.log("RESTORED:", JSON.stringify(run()));
console.log("handoff byte-identical again:", readFileSync(P, "utf8") === orig);
