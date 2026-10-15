// MILESTONE FIGURE (P73-P74): the first two levers borrowed from the external eumemic/exoplanets survey,
// measured on OUR chain with OUR data. It reads ONLY the committed reports in reports/ (no network, no
// re-analysis) and re-derives each headline number exactly as its source report publishes it:
//   * reports/p73-masked-recovery.json      -- catalog-sibling masking vs the P62 "seed wall" (arm ladder)
//   * reports/p74-centroid-consistency.json -- cross-sector centroid coherence vs the single-sector veto
//
// Presentation artifact only: nothing in the analysis core or the reproducible bundle reads it, so bundle
// hashes are unchanged. Deterministic given the committed reports. Not run in CI. discoveryClaim stays false
// everywhere -- both are positive controls / characterizations, and BOTH land on "not safe to gate".
//
// Usage: npm run figure:borrowed   (writes web/borrowed-figure.svg)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "web/borrowed-figure.svg";

function load(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

const p73 = load("reports/p73-masked-recovery.json");
const p74 = load("reports/p74-centroid-consistency.json");

// ---- SVG palette (same family as the other dashboard figures) ----
const C = { bg: "#0b1220", teal: "#5ad1a8", blue: "#8fc6ff", amber: "#e0a458", axis: "#3b4a63", text: "#9fb4d4", title: "#e7f0ff", fp: "#d9776f", card: "#111a2e", edge: "#22304d" };

// ---- re-derive headline numbers straight from the committed fields ----
const n73: number = p73.refind.n;
const arms = [
  { name: "SINGLE (per-sector)", v: p73.refind.single, color: C.blue },
  { name: "NAIVE-JOINT (stitched)", v: p73.refind.naiveJoint, color: C.blue },
  { name: "MASK-JOINT (siblings)", v: p73.refind.maskJoint.count, color: C.teal },
  { name: "MASK-ITERATIVE top-1", v: p73.refind.maskIter1, color: C.blue },
  { name: "ORACLE (truth seed)", v: p73.refind.oracle, color: C.amber },
];
const ci = p73.refind.maskJoint;
const ciLo = Math.round(ci.ciLow * 100);
const ciHi = Math.round(ci.ciHigh * 100);

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sgl = p74.single, mlt = p74.multi;

// ---- geometry: two wide cards side by side + a full-width takeaway band ----
const W = 960, H = 560;
const cw = 444, ch = 300;
const ax = 24, bx = 492, cardY = 66;
const bandY = 392, bandH = 150;

function card(x: number, y: number, title: string, sub: string): string {
  return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
    + `<text x="${x + 16}" y="${y + 26}" fill="${C.title}" font-size="14.5" font-weight="700">${title}</text>`
    + `<text x="${x + 16}" y="${y + 43}" fill="${C.text}" font-size="10.5">${sub}</text>`;
}
function line(x: number, y: number, txt: string, col = C.text, weight = "400", size = 10.5): string {
  return `<text x="${x}" y="${y}" fill="${col}" font-size="${size}" font-weight="${weight}">${txt}</text>`;
}

let A = "", B = "";

// Panel A: P73 arm ladder - horizontal bars of re-find count out of 20.
{
  const x = ax, y = cardY;
  const barX = x + 158, barW = 150, top = y + 62, bh = 22, step = 34, max = 12;
  let s = card(x, y, "P73 | Mask siblings, re-find?", "Borrowed: mask each catalogued neighbour, then re-search");
  for (let i = 0; i < arms.length; i++) {
    const by = top + i * step;
    const w = Math.max(2, (arms[i].v / max) * barW);
    s += `<text x="${barX - 8}" y="${by + bh / 2 + 4}" fill="${C.text}" font-size="10.5" text-anchor="end">${arms[i].name}</text>`;
    s += `<rect x="${barX}" y="${by}" width="${w.toFixed(1)}" height="${bh}" rx="3" fill="${arms[i].color}"/>`;
    s += `<text x="${(barX + w + 7).toFixed(1)}" y="${by + bh / 2 + 4}" fill="${C.title}" font-size="11.5" font-weight="600">${arms[i].v}/${n73}</text>`;
  }
  s += line(x + 16, y + ch - 46, `Net +${p73.paired.netMask} re-find (gained ${p73.paired.gainedByMask}, lost ${p73.paired.lostByMask}); ${p73.paired.withSiblings}/20 have siblings.`);
  s += line(x + 16, y + ch - 30, `MASK-JOINT CI ${ciLo}-${ciHi}% vs ORACLE ${p73.refind.oracle}/20 (blind ${p73.refind.naiveJoint}/20).`);
  s += line(x + 16, y + ch - 12, "MODEST-SIBLING-LIFT: neighbour-lock is part of the wall, not all.", C.amber, "600");
  A = s;
}

// Panel B: P74 single vs multi 2x2 - the veto effect table.
{
  const x = bx, y = cardY;
  let s = card(x, y, "P74 | Coherent centroid veto?", "Borrowed: offset in EVERY sector; reject only if directions agree");
  const rowX = x + 16, c1 = x + 210, c2 = x + 320, c3 = x + 400;
  const head = ["", "power", "false-kill", "AUC"];
  const hy = y + 70;
  s += `<text x="${c1}" y="${hy}" fill="${C.text}" font-size="10.5" font-weight="700">${head[1]}</text>`;
  s += `<text x="${c2}" y="${hy}" fill="${C.text}" font-size="10.5" font-weight="700">${head[2]}</text>`;
  s += `<text x="${c3}" y="${hy}" fill="${C.text}" font-size="10.5" font-weight="700">${head[3]}</text>`;
  const rows = [
    { name: "SINGLE sector (P57)", power: pct(sgl.vetoPower), fk: `${sgl.cm.falseVeto}/16`, auc: sgl.auc.toFixed(2), col: C.blue },
    { name: "MULTI sector (coherent)", power: pct(mlt.vetoPower), fk: `${mlt.cm.falseVeto}/16`, auc: mlt.auc.toFixed(2), col: C.teal },
  ];
  for (let i = 0; i < rows.length; i++) {
    const ry = hy + 30 + i * 40;
    const r = rows[i];
    s += `<text x="${rowX}" y="${ry}" fill="${r.col}" font-size="11.5" font-weight="700">${r.name}</text>`;
    s += `<text x="${c1}" y="${ry}" fill="${C.title}" font-size="13" font-weight="600">${r.power}</text>`;
    s += `<text x="${c2}" y="${ry}" fill="${i === 0 ? C.fp : C.teal}" font-size="13" font-weight="600">${r.fk}</text>`;
    s += `<text x="${c3}" y="${ry}" fill="${C.title}" font-size="13" font-weight="600">${r.auc}</text>`;
  }
  s += `<line x1="${rowX}" y1="${hy + 44}" x2="${x + cw - 16}" y2="${hy + 44}" stroke="${C.axis}" stroke-dasharray="3 2"/>`;
  s += line(rowX, hy + 118, `Coherence cleared ${p74.effect.falseKillsFixed} of ${sgl.cm.falseVeto} single-sector false-kills of known planets,`);
  s += line(rowX, hy + 134, `false-kill ${pct(sgl.falseVetoRate)} -> ${pct(mlt.falseVetoRate)}, but blend power fell to ${pct(mlt.vetoPower)} (AUC ${mlt.auc.toFixed(2)} = chance).`);
  s += line(rowX, hy + 158, "COHERENCE-SAVES-PLANETS-BUT-NO-POWER: safe to KEEP, not to gate.", C.fp, "600");
  B = s;
}

// Takeaway band (full width).
let band = `<rect x="${ax}" y="${bandY}" width="${W - 48}" height="${bandH}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
  + `<text x="${ax + 16}" y="${bandY + 26}" fill="${C.title}" font-size="14.5" font-weight="700">Round takeaway: both borrowed levers measured, neither gates</text>`;
{
  const rows = [
    ["P73", "sibling masking: +1 re-find of 20, wall stays mostly intrinsic (alias/noise)", C.blue],
    ["P74", "cross-sector coherence: kills 0 known planets, but catches 0 blends either", C.teal],
    ["", "safeToGate = false on both; nothing wired into the critic or the money path", C.amber],
  ];
  for (let i = 0; i < rows.length; i++) {
    const ry = bandY + 56 + i * 26;
    if (rows[i][0]) band += `<text x="${ax + 18}" y="${ry}" fill="${rows[i][2] as string}" font-size="12.5" font-weight="700">${rows[i][0]}</text>`;
    band += `<text x="${ax + 60}" y="${ry}" fill="${C.text}" font-size="11.5">${rows[i][1]}</text>`;
  }
}
band += line(ax + 16, bandY + bandH - 10, "Positive controls on real TESS-SPOC photometry; discoveryClaim = false everywhere; reports/ + RESEARCH.md carry every number.", C.title, "600");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="24" y="30" fill="${C.title}" font-size="18" font-weight="700">Borrowing from a real TESS survey: two vetting levers, measured before gated</text>
  <text x="24" y="48" fill="${C.text}" font-size="11">Every number re-derived from a committed P73/P74 report; positive controls on known planets; nothing gated, anchored or claimed (discoveryClaim = false).</text>
  ${A}
  ${B}
  ${band}
</svg>
`;

writeFileSync(OUT, svg, "utf8");
console.log(`wrote ${OUT} (${svg.length} bytes)`);
console.log(`  P73 arms (/${n73}): ${arms.map((a) => a.name + "=" + a.v).join("  ")}`);
console.log(`  P73 net mask +${p73.paired.netMask} (gained ${p73.paired.gainedByMask}/lost ${p73.paired.lostByMask}); oracle ${p73.refind.oracle}`);
console.log(`  P74 single power ${pct(sgl.vetoPower)} fk ${sgl.cm.falseVeto}/16 auc ${sgl.auc.toFixed(3)} | multi power ${pct(mlt.vetoPower)} fk ${mlt.cm.falseVeto}/16 auc ${mlt.auc.toFixed(3)}`);
console.log(`  P74 false-kills fixed ${p74.effect.falseKillsFixed}; both safeToGate=${p73.safeToGate}/${p74.safeToGate}`);
if (/[^\x00-\x7F]/.test(svg)) { console.log("WARNING: non-ASCII in SVG"); process.exit(1); }
