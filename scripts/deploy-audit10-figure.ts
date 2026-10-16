// Audit-10 DEPLOY figure -- the "hardening is now LIVE on production" poster, verified against the
// live endpoints. All-text, ASCII only, deterministic. It only states facts checked against
// spacedatarig.app after the deploy. Usage: npm run figure:deploy-audit10
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 720;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "Audit-10 hardening: now LIVE on production", 25, "#e8ecf7", "800")
  + T(28, 70, "Deployed to spacedatarig.app (version fc6810a6). Verified against the live endpoints, not asserted.", 13, "#9fb0d6");

// Left: what went live
let left = card(28, 96, 600, 300) + T(50, 130, "What took effect", 18, "#37d39b", "800");
const live = [
  ["#7  Deny-by-default admin gate", "state-changing routes now 401 unless they carry the"],
  ["", "operator bearer token; nothing is open by default."],
  ["#7  Per-finding anchor lock", "a same-run re-entrant anchor can no longer double-spend"],
  ["", "the fee wallet -- concurrent calls await one in-flight result."],
  ["#1  scienceHash on new anchors", "each fresh mainnet memo appends a stable content"],
  ["", "address beside the timestamped bundleHash commitment."],
  ["Backward-safe", "existing anchors are byte-identical; verification still"],
  ["", "matches the bundleHash, so the daily re-check holds."],
];
let yy = 158;
for (const [a, b] of live) {
  left += T(50, yy, a, 14, a === "Backward-safe" ? "#9fb0d6" : "#e8ecf7", "700");
  left += T(66, yy + 18, b, 13, "#9fb0d6");
  yy += 42;
}

// Right: live verification
let rt = card(648, 96, 524, 300) + T(670, 130, "Live check on spacedatarig.app", 18, "#5aa9ff", "800");
const checks = [
  ["POST /api/anchor, no token", "401"],
  ["POST /api/anchor, wrong token", "401"],
  ["POST /api/anchor, right token (no such id)", "404  (gate passed, no spend)"],
  ["GET /  and  GET /api/ledger", "200"],
];
let cy = 168;
for (const [k, v] of checks) {
  rt += T(670, cy, k, 14, "#e8ecf7", "600");
  rt += T(670, cy + 22, v, 16, "#37d39b", "800");
  cy += 60;
}

// Bottom band: untouched + honest
let bot = card(28, 412, 1144, 268) + T(50, 446, "Unchanged, by design", 18, "#f5b544", "800");
bot += T(50, 482, "The autonomous hourly loop runs cron -> Durable Object -> Workflow directly; it never passes through the gated HTTP", 14, "#9fb0d6");
bot += T(50, 504, "routes, so it kept anchoring accepted findings throughout. Read-only views, the public dashboard and the ledger are open.", 14, "#9fb0d6");
bot += T(50, 546, "No production threshold moved, no verdict flipped, no historical bundleHash altered. The FPP and detection ceilings", 14, "#e8ecf7", "600");
bot += T(50, 568, "stand exactly as reported in P82: accepted-call precision 42.2% and centroid 0/56 blends on real TESS data.", 14, "#e8ecf7", "600");
bot += T(50, 612, "safeToGate false   discoveryClaim false", 15, "#9fb0d6", "700");
bot += T(50, 646, "To use the dashboard's manual run / anchor buttons, an operator stores the same bearer token in the browser once.", 13, "#9fb0d6");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + left + rt + bot + `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/deploy-audit10-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/deploy-audit10-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
