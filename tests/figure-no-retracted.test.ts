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
  // The pre-coordinate-fix centroid coverage-loss figure baked into two posters as "(71% never localise)" /
  // "~71% of those targets never localise". P84 now measures 70% and P85's coverage wall is 386/500 = 77.2%; 71% is withdrawn.
  ["centroid coverage-loss 71% never-localise (P84 now 70%)", /71%[^<\n]{0,48}never localise/i],
];

function scan(text: string): string[] {
  return WITHDRAWN.filter(([, re]) => re.test(text)).map(([label]) => label);
}

test("the withdrawn-number regexes actually fire (self-check, cannot pass vacuously)", () => {
  const hit = scan("centroid 0/56 blends, planet false-reject 1/53, neighbour fits 54/56, KP 182/234 CP 104/179");
  assert.equal(hit.length, 5, "a string holding all five withdrawn numbers must be flagged five times");
  // the corrected + legitimate-neighbor values must NOT trip it
  assert.deepEqual(scan("0/59 2/55 49/52 186/234 103/179 eumemic reference 0/565"), [], "current values and 0/565 must not match");
  // the withdrawn centroid coverage-loss "71% never localise" must fire; the current 70% / 77.2% must not
  assert.equal(scan("(71% never localise)").length, 1, "the withdrawn 71% never-localise claim must be flagged");
  assert.equal(scan("~71% of those targets never localise a cross-sector offset").length, 1, "the phrased 71% variant must be flagged");
  assert.deepEqual(scan("70% of blend targets never localise | 77.2% never localise"), [], "current 70% / 77.2% must not match");
});

// Recursively collect rendered artifacts under web/ (svg posters + served html report pages), so a number cannot hide
// in a subdirectory or a non-SVG surface. This is the presentation-layer backstop the sha256 freshness gate does not see.
function collect(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.(svg|html)$/i.test(e.name)) out.push(p);
  }
  return out;
}

test("no committed rendered artifact under web/ prints a withdrawn number", () => {
  const offenders: string[] = [];
  for (const file of collect(WEB, []).sort()) {
    const found = scan(readFileSync(file, "utf8"));
    if (found.length) offenders.push(`${file}: ${found.join("; ")}`);
  }
  assert.deepEqual(offenders, [], `these rendered artifacts still print a withdrawn number:\n${offenders.join("\n")}`);
});
