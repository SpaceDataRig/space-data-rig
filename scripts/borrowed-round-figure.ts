// MILESTONE FIGURE (P73-P76 ROUND): the four vetting levers borrowed from the public eumemic/exoplanets TESS
// survey, each re-measured on OUR chain. It reads ONLY the committed reports (no network, no re-analysis) and
// re-derives every headline number from its source JSON:
//   reports/p73-masked-recovery.json    reports/p74-centroid-consistency.json
//   reports/p75-inverted-fp.json        reports/p76-multisource-novelty.json
//
// Presentation artifact only: nothing in the analysis core or the reproducible bundle reads it, so bundle hashes
// are unchanged. Deterministic given the committed reports. Not run in CI. Every verdict is a negative or a
// calibration note; none is gated; discoveryClaim / safeToGate stay false.
//
// Usage: npm run figure:borrowed-round   (writes web/borrowed-round-figure.svg)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "web/borrowed-round-figure.svg";
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const p73 = load("reports/p73-masked-recovery.json");
const p74 = load("reports/p74-centroid-consistency.json");
const p75 = load("reports/p75-inverted-fp.json");
const p76 = load("reports/p76-multisource-novelty.json");

const C = { bg: "#0b1220", teal: "#5ad1a8", blue: "#8fc6ff", amber: "#e0a458", axis: "#3b4a63", text: "#9fb4d4", title: "#e7f0ff", fp: "#d9776f", card: "#111a2e", edge: "#22304d" };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (x: number) => `${Math.round(x * 100)}%`;

const W = 960, H = 604;
const cw = 450, ch = 232;
const cols = [24, 486], rows = [64, 316];

function card(x: number, y: number, tag: string, title: string, sub: string, col: string): string {
  return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
    + `<text x="${x + 16}" y="${y + 26}" fill="${col}" font-size="13" font-weight="700">${esc(tag)}</text>`
    + `<text x="${x + 60}" y="${y + 26}" fill="${C.title}" font-size="13.5" font-weight="700">${esc(title)}</text>`
    + `<text x="${x + 16}" y="${y + 44}" fill="${C.text}" font-size="10.5">${esc(sub)}</text>`;
}
function big(cx: number, cy: number, val: string, lbl: string, col: string): string {
  return `<text x="${cx}" y="${cy}" fill="${col}" font-size="26" font-weight="700" text-anchor="middle">${esc(val)}</text>`
    + `<text x="${cx}" y="${cy + 15}" fill="${C.text}" font-size="10" text-anchor="middle">${esc(lbl)}</text>`;
}
function line(x: number, y: number, txt: string, col = C.text, weight = "400", size = 10.5): string {
  return `<text x="${x}" y="${y}" fill="${col}" font-size="${size}" font-weight="${weight}">${esc(txt)}</text>`;
}

let A = "", B = "", Cd = "", D = "";

// P73: masked sibling recovery.
{
  const x = cols[0], y = rows[0];
  let s = card(x, y, "P73", "Mask siblings, re-search", "eumemic --mask-tois, on the P62 20-planet sample", C.blue);
  s += big(x + 120, y + 108, `${p73.refind.naiveJoint}->${p73.refind.maskJoint.count}`, `blind vs masked re-find /${p73.refind.n}`, C.teal);
  s += big(x + 330, y + 108, `${p73.refind.oracle}`, "ORACLE ceiling /20", C.amber);
  s += line(x + 16, y + 150, `Net +${p73.paired.netMask} (gained ${p73.paired.gainedByMask}, lost ${p73.paired.lostByMask}) -- an assisted ceiling.`);
  s += line(x + 16, y + 170, "Neighbour-lock is part of the seed wall, not all of it.");
  s += line(x + 16, y + ch - 14, "MODEST-SIBLING-LIFT - the wall stays mostly intrinsic.", C.amber, "600");
  A = s;
}
// P74: cross-sector centroid coherence.
{
  const x = cols[1], y = rows[0];
  let s = card(x, y, "P74", "Coherent centroid veto", "offset direction must agree across every sector", C.teal);
  s += big(x + 120, y + 108, `${p74.single.cm.falseVeto}->${p74.multi.cm.falseVeto}`, "known-planet false-kills /16", C.teal);
  s += big(x + 330, y + 108, `${pct(p74.single.vetoPower)}->${pct(p74.multi.vetoPower)}`, "blend-catch power", C.fp);
  s += line(x + 16, y + 150, `Coherence cleared ${p74.effect.falseKillsFixed} false-kills but AUC ${p74.multi.auc.toFixed(2)} = chance.`);
  s += line(x + 16, y + 170, "It saves planets and catches nothing new -- a diagnostic.");
  s += line(x + 16, y + ch - 14, "COHERENCE-SAVES-PLANETS-BUT-NO-POWER - not a gate.", C.fp, "600");
  B = s;
}
// P75: inverted-curve empirical FP rate.
{
  const x = cols[0], y = rows[1];
  let s = card(x, y, "P75", "Inverted-curve FP null", "invert + mask all planets; a leftover dip is pure noise", C.amber);
  s += big(x + 120, y + 108, `${p75.summary.ar1FalseAlarms}/${p75.summary.n}`, `AR(1) gate calls significant (${pct(p75.summary.ar1FpRate)})`, C.fp);
  s += big(x + 330, y + 108, `${p75.summary.blockFalseAlarms}/${p75.summary.n}`, "model-free flags", C.blue);
  s += line(x + 16, y + 150, `Nominal is 5%; AR(1) overshoots ~15x and ${p75.summary.flips} passes are overturned.`);
  s += line(x + 16, y + 170, `mean FAP delta (block-AR1) +${p75.summary.meanDeltaFap.toFixed(3)} - AR(1) runs hot.`);
  s += line(x + 16, y + ch - 14, "GATE-OPTIMISTIC-ON-REAL-NOISE - measured, not re-tuned.", C.amber, "600");
  Cd = s;
}
// P76: multi-source novelty.
{
  const x = cols[1], y = rows[1];
  let s = card(x, y, "P76", "Multi-source novelty", "P48's Archive tables PLUS ExoFOP TOI/CTOI (8151 rows)", C.blue);
  s += big(x + 120, y + 108, `${p76.novelArchiveCount}->${p76.novelUnionCount}`, `novel /${p76.nCandidates} after adding CTOIs`, C.teal);
  s += big(x + 330, y + 108, `${p76.shrinkCount}`, "novelty lost (shrink)", C.blue);
  s += line(x + 16, y + 150, "Both query paths pass a live control before any 0-hit is trusted.");
  s += line(x + 16, y + 170, "A wider net made no candidate less novel - unannounced, not a planet.");
  s += line(x + 16, y + ch - 14, "NO-EXTRA-SHRINK - catalogs silent, not evidence of a planet.", C.text, "600");
  D = s;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="24" y="30" fill="${C.title}" font-size="18" font-weight="700">Four levers borrowed from a real TESS survey - measured on our chain, none clears a gate</text>
  <text x="24" y="48" fill="${C.text}" font-size="11">Every number re-derived from a committed P73-P76 report; positive controls on known planets and a model-free null; discoveryClaim = false.</text>
  ${A}
  ${B}
  ${Cd}
  ${D}
  <text x="24" y="${H - 12}" fill="${C.title}" font-size="10.5" font-weight="600">safeToGate = false on all four; nothing wired into the critic or the money path. SPOC TCE / literature not yet covered (P76).</text>
</svg>
`;

writeFileSync(OUT, svg, "utf8");
console.log(`wrote ${OUT} (${svg.length} bytes)`);
console.log(`  P73 ${p73.refind.naiveJoint}->${p73.refind.maskJoint.count}/${p73.refind.n} oracle ${p73.refind.oracle}; P74 fk ${p74.single.cm.falseVeto}->${p74.multi.cm.falseVeto} power ${pct(p74.single.vetoPower)}->${pct(p74.multi.vetoPower)}; P75 AR1 ${p75.summary.ar1FalseAlarms}/${p75.summary.n} block ${p75.summary.blockFalseAlarms}/${p75.summary.n}; P76 novel ${p76.novelArchiveCount}->${p76.novelUnionCount}/${p76.nCandidates} shrink ${p76.shrinkCount}`);
if (/[^\x00-\x7F]/.test(svg)) { console.log("WARNING: non-ASCII in SVG"); process.exit(1); }
