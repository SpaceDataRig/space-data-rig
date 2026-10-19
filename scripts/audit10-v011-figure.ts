// Audit-10 CLOSED + v0.1.1 figure -- the final "every item resolved, released, and live" poster. All-text,
// ASCII only, deterministic; states only committed + deployed facts. Usage: npm run figure:audit10-v011
// The P85 centroid numbers are read from the committed report (not hardcoded) so this poster cannot drift when
// the checkpoint is re-run -- exactly the staleness an external audit caught in a hand-baked figure.
import { readFileSync } from "node:fs";
const p85 = JSON.parse(readFileSync("reports/p85-contaminant-fit.json", "utf8")).headline as { planetFalseReject: string; blendCaught: string; blendContaminantFitRateAmongViable: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 720;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "Audit-10 closed end to end -- v0.1.1 shipped and live", 24, "#e8ecf7", "800")
  + T(28, 70, "All eleven review items resolved: ten shipped, one blocked by the environment. Released as v0.1.1, deployed to spacedatarig.app.", 13, "#9fb0d6");

// Left: eleven items final state
let left = card(28, 96, 620, 470) + T(50, 126, "Eleven items -- final state", 18, "#37d39b", "800");
const items: [string, string, string][] = [
  ["#1", "SHIPPED", "scienceHash content address split; live on new anchors."],
  ["#2", "SHIPPED", "P81 guardrails: undetermined not NaN; impossible depth."],
  ["#3", "BLOCKED", "official TRICERATOPS needs Python; absent here (native FPP)."],
  ["#4", "SHIPPED", "centroid 2/6 root-caused to pixel-baseline coverage."],
  ["#5", "SHIPPED", "P80 depth-stratified; easiest subset named."],
  ["#6", "SHIPPED", "reusable inverted planet-free null + tests."],
  ["#7", "SHIPPED", "deny-by-default gate + anchor lock + DO rate limit."],
  ["#8", "SHIPPED", "weekly upstream live-probe; issue on schema drift."],
  ["#9", "SHIPPED", "keyless daily on-chain anchor re-verification."],
  ["#10", "SHIPPED", "RESPONSE-TO-AUDIT ledger + one-page README front."],
  ["#11", "SHIPPED", "lint at zero warnings + branch coverage floor."],
];
let yy = 152;
for (const [n, st, txt] of items) {
  const col = st === "BLOCKED" ? "#ff6b6b" : "#37d39b";
  left += T(50, yy, n, 13.5, "#e8ecf7", "800");
  left += T(88, yy, st, 12, col, "800");
  left += T(168, yy, txt, 12.5, "#9fb0d6");
  yy += 38;
}

// Right-top: this pass
let rt = card(664, 96, 512, 220) + T(686, 126, "This pass", 18, "#5aa9ff", "800");
rt += T(686, 156, "#7 residual: abuse-brake counters moved to a DO", 13.5, "#e8ecf7", "600");
rt += T(702, 176, "global across isolates, fail-open fallback (34e93b8).", 12.5, "#9fb0d6");
rt += T(686, 206, "P85: faithful per-contaminant centroid F-test", 13.5, "#e8ecf7", "600");
rt += T(702, 226, `planet false-reject ${p85.planetFalseReject}, blend catch ${p85.blendCaught},`, 12.5, "#9fb0d6");
rt += T(702, 244, `neighbour fits ${p85.blendContaminantFitRateAmongViable} -- power is coverage-bound.`, 12.5, "#9fb0d6");
rt += T(686, 276, "Released v0.1.1; deployed version c9af4564", 13.5, "#e8ecf7", "600");
rt += T(686, 298, "CODE_VERSION now space-data-rig@0.1.1", 12.5, "#9fb0d6");

// Right-bottom: live verification
let rb = card(664, 332, 512, 234) + T(686, 362, "Verified on the live site", 18, "#f5b544", "800");
rb += T(686, 394, "GET /health, /, /api/ledger", 13.5, "#e8ecf7", "600");
rb += T(940, 394, "200", 15, "#37d39b", "800");
rb += T(686, 424, "POST /api/anchor  no / wrong / right token", 13.5, "#e8ecf7", "600");
rb += T(940, 424, "401/401/404", 15, "#37d39b", "800");
rb += T(686, 454, "/api/state codeVersion", 13.5, "#e8ecf7", "600");
rb += T(940, 454, "0.1.1", 15, "#37d39b", "800");
rb += T(686, 484, "GitHub Release v0.1.1 (draft=false)", 13.5, "#e8ecf7", "600");
rb += T(940, 484, "live", 15, "#37d39b", "800");
rb += T(686, 514, "CI on main", 13.5, "#e8ecf7", "600");
rb += T(940, 514, "passing", 15, "#37d39b", "800");
rb += T(686, 548, "safeToGate false   discoveryClaim false", 14, "#9fb0d6", "700");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + left + rt + rb + `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/audit10-v011-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit10-v011-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
