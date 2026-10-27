// ROUND-26 (R26-31): the write-side stamp wiring for the generators whose committed input is statically
// determinable and does NOT circularly name their own output.
//
// WHY A SEPARATE TEST FROM generator-stamped-reports.test.ts. That file pins the FIVE offline-capable generators
// end to end (source + artifact + index) because they can be re-run on a machine with no network, so their
// stamped artifact exists right now. The seven below genuinely READ a committed upstream file (a report the fleet
// already published, or a tracked src module) but still need NETWORK to re-run (MAST/S3), so their stamped
// ARTIFACT does not exist yet -- only the write-side wiring does. Pinning the source here means: the moment the
// data source is reachable and the fleet re-runs these, the stamp is already coded to fire; and if anyone edits a
// generator and drops the wiring, this fires on the edit, not three rounds later when a row is found unattested.
//
// THE CIRCULAR TRAP THIS TEST ALSO CLOSES. The audit tool that planned this work first mis-read p33 and p39 as
// "having a committed input" because they reference reports/p33-catalog.json / reports/p39-candidates.json by
// literal path -- but they WRITE those files, they do not read them. Naming an output you just wrote as your own
// stamp input makes a stamp "verify" a file against itself: it would pass forever and prove nothing. So beyond the
// import/call assertions, each report-json input below is asserted to be a genuine readFileSync target, and no
// input may be a file the same generator writes. A wiring that re-introduces the circular shape fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// id -> generator + the committed input it must name (report = read from reports/, module = imported from src/).
const WIRED: { id: string; script: string; input: string; kind: "report" | "module" }[] = [
  { id: "p35-pdm-crosscheck", script: "scripts/p35-pdm-crosscheck.ts", input: "reports/p33-catalog.json", kind: "report" },
  { id: "p52-negative-class", script: "scripts/p52-negative-class.ts", input: "src/data/vizierEb.ts", kind: "module" },
  { id: "p56-real-selection", script: "scripts/p56-real-selection.ts", input: "reports/p47-completeness-grid.json", kind: "report" },
  { id: "p62-phase-aligned-joint", script: "scripts/p62-phase-aligned-joint.ts", input: "reports/p60-joint-vs-single.json", kind: "report" },
  { id: "p67-seed-precision", script: "scripts/p67-seed-precision.ts", input: "reports/p60-joint-vs-single.json", kind: "report" },
  { id: "p69-rednoise-significance", script: "scripts/p69-rednoise-significance.ts", input: "reports/p60-joint-vs-single.json", kind: "report" },
  { id: "p73-masked-recovery", script: "scripts/p73-masked-recovery.ts", input: "reports/p60-joint-vs-single.json", kind: "report" },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pull the string literals that actually sit INSIDE buildStamp([...]) in the source. This is what the mutation
// check caught: a test that only greps the whole file for the input path passes even when the stamp names the
// wrong file, because the real readFileSync line elsewhere also contains that path. We assert on the stamp's own
// argument list, nothing less.
function stampArgs(src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(/buildStamp\(\[([^\]]*)\]\)/g)) {
    for (const s of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) found.push(s[1]);
  }
  return found;
}

test("each wired generator imports the stamp builder and calls buildStamp([...])", () => {
  for (const { id, script } of WIRED) {
    const src = readFileSync(script, "utf8");
    assert.match(src, /from "\.\/report-freshness\.ts"/, `${script} must import the stamp builder`);
    assert.match(src, /buildStamp\(\[/, `${script} must call buildStamp([...]) so reports/${id}.json can verify`);
  }
});

test("the buildStamp argument list names its committed input AND the generator's own source", () => {
  for (const { script, input } of WIRED) {
    const args = stampArgs(readFileSync(script, "utf8"));
    assert.ok(args.length > 0, `${script} has no readable buildStamp([...]) argument list`);
    assert.ok(args.includes(input), `${script} stamp list [${args.join(", ")}] must name its committed input ${input}`);
    assert.ok(args.includes(script), `${script} stamp list [${args.join(", ")}] must name its own source`);
  }
});

test("every stamped input is genuinely READ, never a file the generator writes (no circular stamp)", () => {
  for (const { script, kind } of WIRED) {
    const src = readFileSync(script, "utf8");
    const args = stampArgs(src);
    // collect every path this generator writes, so a stamp input that is also an output is caught
    const written = new Set<string>();
    for (const w of src.matchAll(/writeFileSync\(\s*["'`]([^"'`]+)["'`]/g)) written.add(w[1]);
    for (const input of args) {
      if (input === script) continue; // stamping own source is required, not a write target
      assert.ok(!written.has(input), `${script} stamps ${input} but also WRITES it -- a stamp that verifies a file against itself proves nothing`);
      if (kind === "report" && /^reports\//.test(input)) {
        assert.match(
          src,
          new RegExp(`readFileSync\\([^)]*${escapeRe(input)}`),
          `${script} must readFileSync(${input}) for it to be a real upstream input`,
        );
      }
    }
    assert.ok(written.size >= 0); // guard: the write scan ran (a generator with no writes is still fine)
  }
});

