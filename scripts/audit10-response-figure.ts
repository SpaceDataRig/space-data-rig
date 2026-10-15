// Audit-10 response figure -- an honest status poster for the "we worked through the audit" tweet. All-text,
// ASCII only, deterministic. It only lists what is COMMITTED; pending/blocked items are labelled as such.
// Usage: npm run figure:audit10-response
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 720;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "Audit-10 response -- hardening the rig, honestly", 25, "#e8ecf7", "800")
  + T(28, 70, "Eight audit items shipped and verified on main; the honest outstanding/blocked ones are labelled, not hidden.", 13, "#9fb0d6");

// Left: shipped
let left = card(28, 96, 584, 380) + T(50, 130, "SHIPPED + committed", 18, "#37d39b", "800");
const shipped = [
  ["#7  Deny-by-default admin gate", "unset ADMIN_TOKEN now 401s mutations; per-finding"],
  ["", "anchor lock stops a same-run SOL double-spend."],
  ["#9  Keyless live chain verification", "daily job re-reads recent Solana anchors from"],
  ["", "mainnet and confirms the memo still matches -- no secret."],
  ["#11 Lint gates at zero warnings", "--max-warnings 0; coverage now enforces branches"],
  ["", "(measured line 95.8 / branch 80.4 / fn 91.8)."],
  ["#1  Split the two bundle hashes", "timestamped commitment vs a stable content"],
  ["", "address (scienceHash); old anchors byte-identical."],
  ["#2  P81 report guardrails", "Gaia-unavailable -> undetermined (not NaN); a physi-"],
  ["", "cally impossible de-diluted depth -> blend evidence."],
  ["#5  P80 depth-stratified", "headline names its easiest subset; a harder"],
  ["", "300-1000 ppm tier is shown alongside, even if 0/N."],
  ["#6  Reusable inverted planet-free null", "AR(1) gate flags 75% of pure-noise bumps vs"],
  ["", "a nominal 5% (model-free 31%, n=16) -- README lead."],
  ["#4  Chased the centroid 2/6", "root cause: pixel-baseline-bound (71% never"],
  ["", "localise), not the F-test -- chain payoff for P44/53."],
];
let yy = 156;
for (const [a, b] of shipped) {
  left += T(50, yy, a, 14, a ? "#e8ecf7" : "#9fb0d6", a ? "700" : "400");
  left += T(66, yy + 18, b, 13, "#9fb0d6");
  yy += 42;
}

// Right-top: P82 results
let rt = card(628, 96, 548, 208) + T(650, 130, "P82 scaled validation (real data)", 18, "#5aa9ff", "800");
rt += T(650, 162, "Blind 425 curves (181 injected):", 14, "#9fb0d6", "600");
rt += T(650, 184, "recall 86.2%   accepted precision 42.2%", 15);
rt += T(650, 216, "External blind validation (ephemeris never fed):", 14, "#9fb0d6", "600");
rt += T(650, 238, "KP 182/234   CP 104/179   strict grade 1/234 & 5/179", 15);
rt += T(650, 270, "Centroid F-test on 500 targets:", 14, "#9fb0d6", "600");
rt += T(650, 292, "planet false-reject 1/53   blend catch 0/56 (vs 73%)", 15);

// Right-bottom: outstanding / blocked
let rb = card(628, 320, 548, 356) + T(650, 354, "Honestly outstanding", 18, "#f5b544", "800");
rb += T(650, 388, "#8  Weekly upstream live-probe", 14, "#e8ecf7", "700");
rb += T(666, 408, "(NASA TAP / ExoFOP / Gaia field+row-count checks) -- next.", 13, "#9fb0d6");
rb += T(650, 440, "#10  RESPONSE-TO-AUDIT.md (criticism -> fix ->", 14, "#e8ecf7", "700");
rb += T(666, 460, "verification -> residual risk) -- next.", 13, "#9fb0d6");
rb += T(650, 492, "#3  Official TRICERATOPS cross-check", 14, "#ff6b6b", "700");
rb += T(666, 512, "BLOCKED here: this environment has no Python/pip;", 13, "#9fb0d6");
rb += T(666, 530, "its FPP maths is already reimplemented natively.", 13, "#9fb0d6");
rb += T(650, 562, "DEPLOY PENDING -- #1 + #7 take effect on a deploy;", 14, "#f5b544", "700");
rb += T(666, 582, "ADMIN_TOKEN must be set at that time. Measure-first:", 13, "#9fb0d6");
rb += T(666, 600, "no verdict, gate, bundle hash or money path changed.", 13, "#9fb0d6");
rb += T(650, 640, "safeToGate false   discoveryClaim false", 15, "#9fb0d6", "700");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + left + rt + rb + `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/audit10-response-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit10-response-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
