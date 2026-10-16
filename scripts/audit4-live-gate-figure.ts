// Audit-4 milestone figure -- the "deployed but never fires on real data" class, closed and proven live.
// All-text, ASCII only, deterministic; states only measured facts (live proofs re-run against spacedatarig.app).
// Usage: npm run figure:audit4
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 792;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head =
  T(28, 44, "Audit-4: two fixes were deployed but never fired on real data -- now they do, proven live", 21, "#e8ecf7", "800") +
  T(28, 70, "A fourth review re-tested the audit-3 fixes on the live site. Two were green in CI yet inert in production, because a non-science field was folded into a hash.", 13, "#9fb0d6");

// Left: before -> after, measured on LIVE data
let left = card(28, 96, 672, 668) + T(50, 128, "The 'deployed but inert' class -- before vs after (LIVE-measured)", 17, "#37d39b", "800");
const items: [string, string, string][] = [
  ["1  scienceHash dedup -- was DEAD CODE",
    "BEFORE  F-HR-858-b/c/d (one detection, three labels) -> 3 distinct hashes -> 3 mainnet fees",
    "AFTER   -> 1 content address 78357350... -> dedup fires, no repeat fee"],
  ["2  legacy 'Confirmed:' relabel -- OFF-BY-ONE-DAY",
    "BEFORE  created < 2026-10-12 excluded every live card -> 0 of 4 annotated",
    "AFTER   created <=  -> 4 of 4 annotated (WASP-121, HD 189733, KELT-9, GJ 1214)"],
  ["3  GET /api/events -- returned 500",
    "BEFORE  plain GET forwarded with an injected Upgrade header -> Worker exception 500",
    "AFTER   worker checks Upgrade first -> 426 Upgrade Required"],
  ["4  an honest dedup showed as FAILURE in the UI",
    "BEFORE  {ok:true, deduplicated:true} fell through to 'anchor failed'",
    "AFTER   'no new tx -- identical science already anchored as F-HR-858-b'; button 'Deduplicated'"],
  ["5  one run re-fetched the same curve per catalog row",
    "BEFORE  three rows on one star -> three identical FITS downloads (three dataHashes)",
    "AFTER   run-scoped byte cache keyed by tic+sector, labelled per row -> one download"],
];
let yy = 164;
for (const [hdr, before, after] of items) {
  left += T(50, yy, hdr, 13.5, "#e8ecf7", "800");
  left += T(66, yy + 22, before, 11.5, "#ff6b6b");
  left += T(66, yy + 42, after, 11.5, "#37d39b");
  yy += 78;
}
left += T(50, yy + 6, "Common root cause: the test asserted a FUNCTION on a hand-built stub, never that the", 12, "#f5b544", "700");
left += T(50, yy + 26, "PREDICATE processes the REAL production records -- so both shipped green and inert.", 12, "#f5b544", "700");
left += T(50, yy + 54, "Defect C history wording also corrected: remediated ~23 min AFTER the audit-3 snapshot", 11.5, "#9fb0d6");
left += T(50, yy + 72, "(34e93b8 00:55Z vs 584c1e47 00:32Z), and it is a global DO with in-memory counters, not SQLite.", 11.5, "#9fb0d6");

// Right-top: the gate that closes the class
let rt = card(716, 96, 456, 320) + T(738, 128, "The root gate this round adds", 17, "#5aa9ff", "800");
rt += T(738, 160, "hashScience folded findingId / targetId /", 12.5, "#e8ecf7", "600");
rt += T(738, 180, "artifacts / dataProvenance -- and a post-hoc", 12.5, "#e8ecf7", "600");
rt += T(738, 200, "truth check -- into the content address.", 12.5, "#e8ecf7", "600");
rt += T(738, 228, "Now scienceProjection() hashes ONLY the blind", 12.5, "#9fb0d6");
rt += T(738, 248, "science + the gating checks.", 12.5, "#9fb0d6");
rt += T(738, 280, "NEW GATE  capture-live-fixtures snapshots the", 12.5, "#37d39b", "700");
rt += T(738, 300, "live /api/state + manifests; live-data-regression", 12.5, "#37d39b", "700");
rt += T(738, 320, "drives the REAL predicates over the REAL bytes.", 12.5, "#37d39b", "700");
rt += T(738, 352, "Measuring real data even corrected the audit's", 12, "#f5b544", "700");
rt += T(738, 372, "own field list: checks[6] 'period-vs-truth (post-", 12, "#f5b544", "700");
rt += T(738, 392, "hoc, non-gating)' differs per label, so including", 12, "#f5b544", "700");
rt += T(738, 410, "it verbatim would have kept the dedup dead.", 12, "#f5b544", "700");

// Right-bottom: verification + live proof
let rb = card(716, 432, 456, 332) + T(738, 464, "Verification gate + live proof (this pass)", 17, "#f5b544", "800");
const rows: [string, string][] = [
  ["typecheck:all / worker", "exit 0"],
  ["npm test (offline)", "481 / 481"],
  ["eslint --max-warnings 0", "exit 0"],
  ["non-ASCII / secret scan", "0"],
  ["LIVE GET /api/events", "426"],
  ["LIVE relabel on /api/state", "4 / 4 cards"],
  ["LIVE trio scienceHash", "1 distinct"],
];
let ry = 498;
for (const [k, v] of rows) {
  rb += T(738, ry, k, 12.5, "#e8ecf7", "600");
  rb += T(1080, ry, v, 13, "#37d39b", "800");
  ry += 30;
}
rb += T(738, ry + 6, "deploy Version b2806cfa   commit b891b51", 12, "#9fb0d6", "700");
rb += T(738, ry + 30, "safeToGate false    discoveryClaim false", 12.5, "#9fb0d6", "700");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  bg + head + left + rt + rb +
  `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/audit4-live-gate-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit4-live-gate-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
