// Audit-3 remediation figure -- the third-round review's "done but half-done" + two new defects, closed.
// All-text, ASCII only, deterministic; states only committed facts (deploy-pending where not yet live).
// Usage: npm run figure:audit3
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 720;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "Audit-3: half-done items closed, two new defects fixed, limits made explicit", 21, "#e8ecf7", "800")
  + T(28, 70, "A third review confirmed 8 of 11 prior fixes were real. We fixed what was half-done, added two missing wirings, and stated what the method cannot do.", 13, "#9fb0d6");

// Left: what was found -> what was done
let left = card(28, 96, 660, 470) + T(50, 126, "Third-round findings -> this pass", 18, "#37d39b", "800");
const rows: [string, string, string][] = [
  ["A", "DEFECT", "scienceHash was computed but never hit the chain; memos differed by runtime."],
  ["", "FIXED", "threaded scienceHash through the one shared submit primitive (f34d672)."],
  ["B", "DEFECT", "identical science re-anchored as 3 mainnet txs -- repeat spend on one content."],
  ["", "FIXED", "dedup by scienceHash before paying; no foreign stamp, invariant holds (9dcf908)."],
  ["C", "DEFECT", "legacy bundles still render the old overclaiming wording, immutable by design."],
  ["", "FIXED", "render-layer derived relabel for pre-policy cards; rule in README (be553ed)."],
  ["D", "DEFECT", "rate limiter per-isolate + fail-open (true as of snapshot 584c1e47)."],
  ["", "SHIPPED", "global DO, in-memory counters (reset on eviction); landed ~23 min later (34e93b8)."],
  ["E", "GAP", "a probe that exists is not a probe that alerts -- failure mode untested."],
  ["", "FIXED", "pure judge + offline self-test: drifted fixtures trip the alert code (97cddc6)."],
  ["F", "MISLABEL", "we said Blocked (no Python) -- wrong, CI runs Python; real limit is TRICERATOPS starfield."],
  ["", "CORRECTED", "ledger now Partial; capability boundary published, not threshold-tuned."],
];
let yy = 152;
for (const [n, st, txt] of rows) {
  const col = st === "DEFECT" || st === "GAP" || st === "MISLABEL" ? "#ff6b6b" : st === "SHIPPED" ? "#f5b544" : "#37d39b";
  if (n) left += T(50, yy, n, 13.5, "#e8ecf7", "800");
  left += T(74, yy, st, 11.5, col, "800");
  left += T(160, yy, txt, 11.5, "#9fb0d6");
  yy += 37;
}

// Right-top: capability ceiling
let rt = card(704, 96, 472, 232) + T(726, 126, "Capability boundary (stated, not sold)", 17, "#5aa9ff", "800");
rt += T(726, 156, "Blended / multi-source-per-pixel scenes are unsupported.", 13, "#e8ecf7", "700");
rt += T(726, 180, "Centroid false-positive test caught 0/59 labelled blends;", 12.5, "#9fb0d6");
rt += T(726, 198, "~71% of those targets never localise a cross-sector offset.", 12.5, "#9fb0d6");
rt += T(726, 222, "Pixel-baseline-bound -- a method rebuild, not a threshold.", 12.5, "#e8ecf7", "600");
rt += T(726, 254, "Accepted-precision 42.2% at 425 curves is the wall;", 12.5, "#9fb0d6");
rt += T(726, 272, "recall 86.2% is printed alongside, never alone.", 12.5, "#9fb0d6");
rt += T(726, 306, "The $SDR token is isolated: no verdict reads from it.", 12.5, "#9fb0d6");

// Right-bottom: verification
let rb = card(704, 344, 472, 222) + T(726, 374, "Verification gate (this pass)", 17, "#f5b544", "800");
rb += T(726, 406, "typecheck:all / typecheck:worker", 13, "#e8ecf7", "600");
rb += T(1080, 406, "exit 0", 14, "#37d39b", "800");
rb += T(726, 436, "npm test (offline, auto-discovered)", 13, "#e8ecf7", "600");
rb += T(1080, 436, "468 / 468", 14, "#37d39b", "800");
rb += T(726, 466, "eslint --max-warnings 0", 13, "#e8ecf7", "600");
rb += T(1080, 466, "exit 0", 14, "#37d39b", "800");
rb += T(726, 496, "live-probe offline self-test", 13, "#e8ecf7", "600");
rb += T(1080, 496, "PASS", 14, "#37d39b", "800");
rb += T(726, 526, "CI on main", 13, "#e8ecf7", "600");
rb += T(1080, 526, "passing", 14, "#37d39b", "800");
rb += T(726, 552, "safeToGate false   discoveryClaim false", 13, "#9fb0d6", "700");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + left + rt + rb + `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/audit3-remediation-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit3-remediation-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
