// Audit-5 milestone figure -- "why is the catalog always the same handful?" Root-caused and fixed:
// the autonomous survey now ROTATES a growing real pool (known re-validation + unconfirmed blind-TOI
// candidates) and every row is labeled honestly. All-text, ASCII only, deterministic; states only facts
// that are measured or already published (the 27/70 blind-recovery stat is the offline p7 result).
// Usage: npm run figure:audit5
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 760;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head =
  T(28, 44, "Audit-5: the catalog was static by design -- it now rotates a growing, honestly-labeled survey", 20, "#e8ecf7", "800") +
  T(28, 70, "A reader asked why FINDINGS CATALOG never changed. The honest root cause, the fix, and the guardrails that stop a livelier catalog from reading as a discovery claim.", 12.5, "#9fb0d6");

// Left: what was found -> what was done
let left = card(28, 96, 660, 636) + T(50, 128, "Root cause -> fix", 18, "#37d39b", "800");
const rows: [string, string][] = [
  ["WHY STATIC", "Every cron pass picked the brightest N KNOWN planets; findingId is deterministic"],
  ["", "(F-<target>) and recordFinding is INSERT OR REPLACE -- the same rows were rewritten in"],
  ["", "place every 15 min, so the catalog could not grow. It was churn, not stasis."],
  ["FIX 1", "The autonomous run now ROTATES a broad real pool from a persisted survey cursor"],
  ["", "(src/survey/rotation.ts + DO meta surveyPass, advanced once/pass, idempotent by runId),"],
  ["", "so new rows accumulate across passes. Manual dashboard runs stay deterministic top-N."],
  ["FIX 2", "UNCONFIRMED TOI candidates run through the SAME 5-seat pipeline on REAL SPOC"],
  ["", "pixels, BLIND (the TOI ephemeris is withheld) -- the same protocol as p7, which"],
  ["", "independently recovered 27/70 unconfirmed candidates offline at a 0.22% median period error."],
  ["FIX 3", "The genuinely novel work used to live only in offline reports. The live survey now"],
  ["", "reaches it: real unconfirmed candidates appear in the catalog, labeled as candidates."],
];
let yy = 154;
for (const [n, txt] of rows) {
  const col = n === "WHY STATIC" ? "#ff6b6b" : n === "FIX 1" || n === "FIX 2" || n === "FIX 3" ? "#37d39b" : "#9fb0d6";
  if (n) left += T(50, yy, n, 12.5, col, "800");
  left += T(n ? 120 : 50, yy, txt, 11.5, "#9fb0d6");
  yy += 30;
}

// Right-top: honesty guardrails (structural, not a promise)
let rt = card(704, 96, 472, 348) + T(726, 126, "Guardrails -- why this is not 'inflation'", 17, "#5aa9ff", "800");
const guard = [
  "Every row carries Finding.origin:",
  "  'revalidation'  a known planet re-derived",
  "  'blind-toi'     an UNCONFIRMED candidate",
  "critique() caps blind-toi at needs-more-data",
  "even when the evidence alone would accept it.",
  "The auto-anchor branch refuses blind-toi too --",
  "a blind candidate is NEVER sealed or claimed.",
  "A TOI with no real SPOC photometry is SKIPPED,",
  "never given a synthetic stand-in that could fake",
  "a 'recovery'.",
  "origin is NOT in the bundle manifest, so it moves",
  "no bundleHash / scienceHash -- behavior-tested.",
];
let gy = 156;
for (const g of guard) { rt += T(726, gy, g, 12, "#e8ecf7", g.startsWith("  '") ? "700" : "400"); gy += 20; }

// Right-bottom: gates + deploy + live proof
let rb = card(704, 460, 472, 272) + T(726, 490, "Verification gate + deploy (this pass)", 17, "#f5b544", "800");
const gates: [string, string][] = [
  ["typecheck:all / worker", "exit 0"],
  ["npm test (offline)", "487 / 487"],
  ["eslint --max-warnings 0", "exit 0"],
  ["non-ASCII / secret scan", "0"],
  ["new behavior tests", "6 added"],
  ["deploy Version", "f4dfb1a9"],
];
let ry = 520;
for (const [k, v] of gates) {
  rb += T(726, ry, k, 12.5, "#e8ecf7", "600");
  rb += T(1140, ry, v, 13, "#37d39b", "800");
  ry += 28;
}
rb += T(726, ry + 4, "commit 15c7857   discoveryClaim false", 12, "#9fb0d6", "700");
rb += T(726, ry + 26, "safeToGate path unchanged for blind candidates", 12, "#9fb0d6", "700");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  bg + head + left + rt + rb +
  `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/audit5-rotating-survey-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit5-rotating-survey-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
