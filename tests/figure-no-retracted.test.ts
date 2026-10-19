// FIGURE STALENESS GUARD (external audit problem #2: "the freshness gate never covered the presentation layer").
// report-freshness/p86 re-hash reports/*.json inputs, but the SVG posters bake in numbers and can silently keep
// printing a value that was WITHDRAWN by a later re-run. A real instance shipped: the audit-10 posters still printed
// the pre-coordinate-fix centroid "0/56 / 1/53 / 54/56" and external "182/234 / 104/179" after those were replaced
// by "0/59 / 2/55 / 49/52" and "186/234 / 103/179". This test freezes that lesson: no committed figure under web/ may
// render any withdrawn token. The scan is exercised against a synthetic string so the regexes cannot pass vacuously.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "web");

// Withdrawn numbers, each guarded against its legitimate longer neighbor (0/565, 1/535 etc. must NOT match).
const WITHDRAWN: Array<[string, RegExp]> = [
  ["centroid blend-catch 0/56 (now 0/59)", /(?<![0-9])0\/56(?!5)/],
  ["planet false-reject 1/53 (now 2/55)", /(?<![0-9])1\/53(?!5)/],
  ["contaminant fit 54/56 (now 49/52)", /(?<![0-9])54\/56(?![0-9])/],
  ["external KP 182/234 (now 186/234)", /(?<![0-9])182\/234/],
  ["external CP 104/179 (now 103/179)", /(?<![0-9])104\/179/],
];

function scan(text: string): string[] {
  return WITHDRAWN.filter(([, re]) => re.test(text)).map(([label]) => label);
}

test("the withdrawn-number regexes actually fire (self-check, cannot pass vacuously)", () => {
  const hit = scan("centroid 0/56 blends, planet false-reject 1/53, neighbour fits 54/56, KP 182/234 CP 104/179");
  assert.equal(hit.length, 5, "a string holding all five withdrawn numbers must be flagged five times");
  // the corrected + legitimate-neighbor values must NOT trip it
  assert.deepEqual(scan("0/59 2/55 49/52 186/234 103/179 eumemic reference 0/565"), [], "current values and 0/565 must not match");
});

test("no committed figure under web/ renders a withdrawn number", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(WEB).filter((f) => f.endsWith(".svg")).sort()) {
    const found = scan(readFileSync(join(WEB, name), "utf8"));
    if (found.length) offenders.push(`${name}: ${found.join("; ")}`);
  }
  assert.deepEqual(offenders, [], `these figures still print a withdrawn number:\n${offenders.join("\n")}`);
});
