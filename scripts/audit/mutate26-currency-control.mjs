// round-26 drill for R26-17: prove the research-bundle currency control is anchored to the right revision.
//
// The control used to read "the second-newest revision of web/research.json" and assert the diff named
// compute.exponentP. That held the day it was written, then the fleet merged a SECOND refresh (61ca06c) on top of the
// round's own refresh (e97c4fd), and the position slot now points at an already-refreshed bundle -- so the diff stopped
// naming the exponent figure and the "positive control" was quietly a no-op (the gate still passed, wrongly).
//
// This drill recomputes BOTH anchors independently of the test file and shows the difference, using no mutation of any
// tracked file:
//   * the CONTENT anchor (newest revision that still published 2.936437697567511) MUST produce a diff that names
//     compute.exponentP -- otherwise the control proves nothing;
//   * the POSITION anchor (second-newest revision, the old code) must NOT name compute.exponentP in the current tree --
//     that is the exact regression, reproduced, so a future reader sees why content-anchoring was required.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return r.stdout;
};
const STALE_EXPONENT = "2.936437697567511";

// Independent re-implementation of diffPaths (kept in sync by hand on purpose: importing the audited module would let a
// shared bug hide in both). Only the paths are needed here.
function diffPaths(a, b, path = "", hits = []) {
  if (hits.length >= 40) return hits;
  if (a === b) return hits;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, hits);
    return hits;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], path ? `${path}.${k}` : k, hits);
    return hits;
  }
  hits.push(path || "(root)");
  return hits;
}
const stripStamp = (t) => t.replace(/^ {2}"generatedAt": "[^"]*",?\r?\n/m, "");

const revs = git(["log", "--format=%H", "--", "web/research.json"]).trim().split(/\r?\n/).filter(Boolean);
if (revs.length < 2) throw new Error(`need >=2 research.json revisions, have ${revs.length}`);
const published = stripStamp(readFileSync("web/research.json", "utf8"));

// CONTENT anchor: newest revision that still published the pre-refresh exponent.
let contentRev = "";
for (const h of revs) {
  if (git(["show", `${h}:web/research.json`]).includes(STALE_EXPONENT)) { contentRev = h; break; }
}
if (!contentRev) throw new Error("no revision published the stale exponent -- the control has nothing to anchor to");

const nameExponent = (rev) => {
  const old = stripStamp(git(["show", `${rev}:web/research.json`]));
  const d = diffPaths(JSON.parse(old), JSON.parse(published));
  return { count: d.length, namesExponent: d.some((p) => p === "compute.exponentP") };
};

const byContent = nameExponent(contentRev);
const byPosition = nameExponent(revs[1]); // the OLD code's choice

console.log("content anchor:", contentRev.slice(0, 7), JSON.stringify(byContent));
console.log("position anchor (second-newest):", revs[1].slice(0, 7), JSON.stringify(byPosition));

const problems = [];
if (byContent.count === 0) problems.push("content anchor is byte-identical to what we ship: the control proves nothing");
if (!byContent.namesExponent) problems.push("content anchor does NOT name compute.exponentP: the control misses the figure the site renders");
if (byPosition.namesExponent) problems.push("unexpected: the position anchor still names the exponent -- the decay this drill documents has not occurred in this tree, so re-check the premise before trusting R26-17");
if (problems.length) { console.log("DRILL FAILED:", problems.join(" ; ")); process.exit(1); }
console.log("DRILL PASS: content anchor catches the rendered figure; the old position anchor does not (the decay is real, and now anchored away).");
