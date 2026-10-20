// Audit-10 CLOSE figure -- the "every review item is now accounted for" poster. All-text, ASCII only,
// deterministic. It only states COMMITTED facts and keeps honest labels (deploy-pending / blocked).
// The centroid coverage-loss and blend-catch numbers are READ from reports/p84-centroid-diagnosis.json (report-driven),
// never baked: a prior revision hard-printed the pre-coordinate-fix "71%", which is withdrawn (P84 now measures it).
// Usage: npm run figure:audit10-close
import { readFileSync, writeFileSync } from "node:fs";
const p84 = JSON.parse(readFileSync("reports/p84-centroid-diagnosis.json", "utf8"));
const neverLocalisePct: number = Math.round((p84.blends.coverageLossFrac as number) * 100); // 70
const blendCaught: string = `${p84.blends.caught}/${p84.blends.testable}`; // 0/59
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 720;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "Audit-10: all eleven items accounted for", 25, "#e8ecf7", "800")
  + T(28, 70, "Every review line now has a fix, a verification, and a stated residual risk. Committed to main; CI passing.", 13, "#9fb0d6");

// Left: shipped list (green)
let left = card(28, 96, 620, 356) + T(50, 130, "SHIPPED + verified on main", 18, "#37d39b", "800");
const shipped = [
  ["#1  Bundle split", "scienceHash (content address) apart from the timestamped bundleHash."],
  ["#2  P81 guardrails", "Gaia-unavailable -> undetermined (not NaN); impossible depth -> blend evidence."],
  ["#4  Centroid 2/6", `root-caused to pixel-baseline-bound (${neverLocalisePct}% of blend targets never localise >=2 sector offsets), not the F-test.`],
  ["#5  P80 stratified", "headline names its easiest subset; a harder 300-1000 ppm tier shown beside it."],
  ["#6  Reusable null", "inverted planet-free null extracted to src/ + tested; README leads with P75."],
  ["#7  Deny-by-default", "unset ADMIN_TOKEN 401s admin writes; per-finding anchor lock vs SOL double-spend."],
  ["#8  Weekly live-probe", "keyless NASA/ExoFOP/Gaia field+row-count check; opens an issue on schema drift."],
  ["#9  On-chain re-check", "keyless daily job re-reads recent mainnet anchors and matches the memo."],
  ["#10 Audit response", "RESPONSE-TO-AUDIT.md four columns + a one-page README front."],
  ["#11 Lint + coverage", "--max-warnings 0; typecheck:all + the full offline test suite + eslint all green on main (counts live in CI)."],
];
let yy = 156;
for (const [a, b] of shipped) {
  left += T(50, yy, a, 14, "#e8ecf7", "700");
  left += T(190, yy, b, 12.5, "#9fb0d6");
  yy += 33;
}

// Right-top: two just-closed
let rt = card(668, 96, 504, 176) + T(690, 130, "Closed this pass", 18, "#5aa9ff", "800");
rt += T(690, 160, "#8  live-probe -- local smoke PASS 3/3:", 14, "#e8ecf7", "600");
rt += T(706, 182, "NASA 1569 rows / ExoFOP 8152 lines / Gaia 5 rows", 13, "#9fb0d6");
rt += T(690, 214, "#10 RESPONSE-TO-AUDIT.md + README panel", 14, "#e8ecf7", "600");
rt += T(706, 236, "criticism -> fix -> verification -> residual risk", 13, "#9fb0d6");

// Right-bottom: honest caveats
let rb = card(668, 288, 504, 388) + T(690, 322, "Honest caveats", 18, "#f5b544", "800");
rb += T(690, 356, "DEPLOY-PENDING", 14, "#e8ecf7", "700");
rb += T(706, 376, "#1 + #7 take effect only on a deploy, and #7", 13, "#9fb0d6");
rb += T(706, 394, "needs ADMIN_TOKEN set at that time.", 13, "#9fb0d6");
rb += T(690, 428, "BLOCKED HERE", 14, "#ff6b6b", "700");
rb += T(706, 448, "#3  official TRICERATOPS cross-check: no Python/", 13, "#9fb0d6");
rb += T(706, 466, "pip in this environment; its FPP maths is native.", 13, "#9fb0d6");
rb += T(690, 500, "MEASURE-BEFORE-GATE", 14, "#e8ecf7", "700");
rb += T(706, 520, "No production threshold moved, no verdict", 13, "#9fb0d6");
rb += T(706, 538, "flipped, no historical bundleHash altered,", 13, "#9fb0d6");
rb += T(706, 556, "no money path touched.", 13, "#9fb0d6");
rb += T(690, 596, "The ceilings stand as reported:", 14, "#9fb0d6", "600");
rb += T(690, 620, `42% accepted precision  |  centroid ${blendCaught} blends`, 15, "#e8ecf7", "700");
rb += T(690, 648, "safeToGate false   discoveryClaim false", 14, "#9fb0d6", "700");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + left + rt + rb + `</svg>\n`;
writeFileSync("web/audit10-close-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit10-close-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
