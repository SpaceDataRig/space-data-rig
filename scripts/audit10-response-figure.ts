// Audit-10 response figure -- the honest status poster for the "we worked through the audit" update.
// Regenerated (C-8) to reflect the completed state: all ten implementable items shipped, #1/#7 deployed to
// production, and only the genuinely environment-blocked / by-design-ceiling items left labelled. All-text,
// ASCII only, deterministic. Usage: npm run figure:audit10-response
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 720;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "Audit-10 response -- all ten implementable items shipped", 24, "#e8ecf7", "800")
  + T(28, 70, "Ten review items landed and verified on main; #1 and #7 are live in production. The blocked and by-design items stay labelled.", 13, "#9fb0d6");

// Left: shipped (10 items)
let left = card(28, 96, 620, 574) + T(50, 126, "SHIPPED + verified on main", 18, "#37d39b", "800");
const shipped = [
  ["#1  Split the two bundle hashes", "timestamped commitment vs a stable content address"],
  ["", "(scienceHash); old anchors byte-identical. LIVE on deploy."],
  ["#2  P81 report guardrails", "Gaia-unavailable -> undetermined (not NaN); a physi-"],
  ["", "cally impossible de-diluted depth -> blend contradiction."],
  ["#4  Chased the centroid 2/6", "root cause: pixel-baseline-bound, not the F-test."],
  ["#5  P80 depth-stratified", "headline names its easiest subset; a harder tier shown."],
  ["#6  Reusable inverted null", "planet-free null extracted to src/ + tested; README lead."],
  ["#7  Deny-by-default admin gate", "unset token 401s mutations; per-finding anchor lock stops"],
  ["", "a same-run SOL double-spend. Abuse-brake counters moved to a DO."],
  ["#8  Weekly upstream live-probe", "keyless NASA/ExoFOP/Gaia field+row-count check; an"],
  ["", "issue opens on a schema drift. Local smoke PASS 3/3."],
  ["#9  Keyless on-chain re-check", "daily job re-reads recent mainnet anchors and matches"],
  ["", "each memo to its bundle hash -- reads only, no secret."],
  ["#10 Audit response ledger", "RESPONSE-TO-AUDIT.md (criticism -> fix -> verification"],
  ["", "-> residual risk) + a one-page README front."],
  ["#11 Lint + branch coverage", "--max-warnings 0; coverage floor enforces branches too."],
];
let yy = 150;
for (const [a, b] of shipped) {
  left += T(50, yy, a, 13, "#e8ecf7", "700");
  left += T(66, yy + 15, b, 12, "#9fb0d6");
  yy += 32;
}

// P82/P85 numbers are read from the committed reports, not hardcoded, so this poster cannot carry a stale value
// (an external audit caught a hand-baked figure still printing the pre-coordinate-fix 182/234 and 0/56).
import { readFileSync } from "node:fs";
const _p82 = JSON.parse(readFileSync("reports/p82-scaled.json", "utf8")) as {
  blind: { recall: number; acceptedPrecision: number };
  external: { kp: { tested: number; validated: number; grade: number }; cp: { tested: number; validated: number; grade: number } };
};
const _p85 = JSON.parse(readFileSync("reports/p85-contaminant-fit.json", "utf8")) as { headline: { planetFalseReject: string; blendCaught: string } };
const pc = (x: number) => (100 * x).toFixed(1) + "%";

// Right-top: P82 results
let rt = card(664, 96, 512, 200) + T(686, 128, "P82 scaled validation (real data)", 18, "#5aa9ff", "800");
rt += T(686, 158, "Blind 425 curves (181 injected):", 14, "#9fb0d6", "600");
rt += T(686, 180, `recall ${pc(_p82.blind.recall)}   accepted precision ${pc(_p82.blind.acceptedPrecision)}`, 15);
rt += T(686, 210, "External blind validation (ephemeris never fed):", 14, "#9fb0d6", "600");
rt += T(686, 232, `KP ${_p82.external.kp.validated}/${_p82.external.kp.tested}   CP ${_p82.external.cp.validated}/${_p82.external.cp.tested}   strict grade ${_p82.external.kp.grade}/${_p82.external.kp.tested} & ${_p82.external.cp.grade}/${_p82.external.cp.tested}`, 15);
rt += T(686, 262, "Centroid F-test on 500 targets (P85):", 14, "#9fb0d6", "600");
rt += T(686, 284, `planet false-reject ${_p85.headline.planetFalseReject}   blend catch ${_p85.headline.blendCaught}`, 15);

// Right-bottom: honestly open / blocked
let rb = card(664, 312, 512, 254) + T(686, 344, "Honestly open", 18, "#f5b544", "800");
rb += T(686, 376, "#3  Official TRICERATOPS cross-check", 14, "#ff6b6b", "700");
rb += T(702, 396, "BLOCKED here: no Python/pip in this environment;", 13, "#9fb0d6");
rb += T(702, 414, "its FPP maths is already reimplemented natively.", 13, "#9fb0d6");
rb += T(686, 446, "By-design ceilings (not defects)", 14, "#e8ecf7", "700");
rb += T(702, 466, "#4/#5: sample size narrows error bars, it does not", 13, "#9fb0d6");
rb += T(702, 484, "remove the pixel-baseline or easiest-subset limits.", 13, "#9fb0d6");
rb += T(686, 516, "DEPLOYED: #1 + #7 live on spacedatarig.app", 14, "#37d39b", "700");
rb += T(686, 544, "safeToGate false   discoveryClaim false", 14, "#9fb0d6", "700");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + left + rt + rb + `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/audit10-response-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit10-response-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
