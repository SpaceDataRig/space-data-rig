// MILESTONE FIGURE (P75): the inverted+masked empirical false-alarm check on the AR(1) significance gate --
// the clean answer to P69's caveat. It reads ONLY the committed report in reports/ (no network, no re-analysis)
// and re-derives every number exactly as its source publishes it:
//   * reports/p75-inverted-fp.json  -- AR(1)-model gate FP rate vs a model-free block bootstrap, on planet-free
//                                       inverted+masked real TESS-SPOC curves (positive transit-like residual dips).
//
// Presentation artifact only: nothing in the analysis core or the reproducible bundle reads it, so bundle hashes
// are unchanged. Deterministic given the committed report. Not run in CI. This is a MEASUREMENT of the existing
// gate's calibration -- it changes no threshold, gates nothing, and discoveryClaim stays false everywhere.
//
// Usage: npm run figure:inverted-fp   (writes web/inverted-fp-figure.svg)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "web/inverted-fp-figure.svg";
const p = JSON.parse(readFileSync("reports/p75-inverted-fp.json", "utf8"));

const C = { bg: "#0b1220", teal: "#5ad1a8", blue: "#8fc6ff", amber: "#e0a458", axis: "#3b4a63", text: "#9fb4d4", title: "#e7f0ff", fp: "#d9776f", grid: "#1c2740", card: "#111a2e", edge: "#22304d" };

const s = p.summary;
const n: number = s.n;
const pct = (x: number) => `${Math.round(x * 100)}%`;

const W = 960, H = 520;
const cw = 444, ch = 300;
const ax = 24, bx = 492, cardY = 66;
const bandY = 384, bandH = 118;

function card(x: number, y: number, title: string, sub: string): string {
  return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
    + `<text x="${x + 16}" y="${y + 26}" fill="${C.title}" font-size="14.5" font-weight="700">${title}</text>`
    + `<text x="${x + 16}" y="${y + 43}" fill="${C.text}" font-size="10.5">${sub}</text>`;
}
function line(x: number, y: number, txt: string, col = C.text, weight = "400", size = 10.5): string {
  return `<text x="${x}" y="${y}" fill="${col}" font-size="${size}" font-weight="${weight}">${txt}</text>`;
}
function big(cx: number, cy: number, val: string, lbl: string, col: string): string {
  return `<text x="${cx}" y="${cy}" fill="${col}" font-size="30" font-weight="700" text-anchor="middle">${val}</text>`
    + `<text x="${cx}" y="${cy + 16}" fill="${C.text}" font-size="10.5" text-anchor="middle">${lbl}</text>`;
}

let A = "", B = "";

// Panel A: FP-rate bars -- AR(1) gate vs model-free block vs the nominal 5% target.
{
  const x = ax, y = cardY;
  const barX = x + 132, barW = 200, top = y + 70, bh = 26, step = 40;
  let s2 = card(x, y, "P75 | Is the significance gate honest?", "Fraction of planet-free noise dips the gate calls significant (FAP<0.05).");
  const bars = [
    { name: "AR(1)-model gate", v: s.ar1FpRate, col: C.fp },
    { name: "model-free block", v: s.blockFpRate, col: C.blue },
    { name: "nominal target", v: 0.05, col: C.teal },
  ];
  for (let i = 0; i < bars.length; i++) {
    const by = top + i * step;
    const w = Math.max(2, bars[i].v * barW);
    s2 += `<text x="${barX - 8}" y="${by + bh / 2 + 4}" fill="${C.text}" font-size="10.5" text-anchor="end">${bars[i].name}</text>`;
    s2 += `<rect x="${barX}" y="${by}" width="${w.toFixed(1)}" height="${bh}" rx="3" fill="${bars[i].col}"/>`;
    s2 += `<text x="${(barX + w + 7).toFixed(1)}" y="${by + bh / 2 + 4}" fill="${C.title}" font-size="12" font-weight="600">${pct(bars[i].v)}</text>`;
  }
  s2 += line(x + 16, y + ch - 46, `AR(1) signs off ${s.ar1FalseAlarms}/${n} = ${pct(s.ar1FpRate)} noise dips -- 15x the 5% it claims.`);
  s2 += line(x + 16, y + ch - 30, `Of those, the model-free null rejects ${s.flips}; mean FAP delta (block-AR1) ${s.meanDeltaFap >= 0 ? "+" : ""}${s.meanDeltaFap.toFixed(3)}.`);
  s2 += line(x + 16, y + ch - 12, "GATE-OPTIMISTIC-ON-REAL-NOISE - AR(1) understates real tails.", C.fp, "600");
  A = s2;
}

// Panel B: the clean null itself -- where the bumps come from and the headline tallies.
{
  const x = bx, y = cardY;
  let s2 = card(x, y, "The null | pure noise by design", "Invert a real curve, mask every catalogued planet, keep a positive dip.");
  s2 += big(x + 90, y + 118, `${n}`, "planet-free noise dips", C.blue);
  s2 += big(x + 260, y + 118, `${s.quiet}`, "quiet hosts (rho<=0.2)", C.teal);
  s2 += line(x + 16, y + 158, "1. flux -> 2*median - flux: every transit becomes a bump, so the curve");
  s2 += line(x + 16, y + 174, "   holds no real dip for a detector to find.");
  s2 += line(x + 16, y + 196, "2. mask each catalogued planet (ground-truth ephemeris, widened) to drop");
  s2 += line(x + 16, y + 212, "   the mirrored bumps; single sector keeps the ephemeris exact.");
  s2 += line(x + 16, y + 234, "3. keep only a POSITIVE transit-like residual dip - what's left is noise.");
  s2 += line(x + 16, y + ch - 12, "This is the model-free recalibration P69 asked for, on real photometry.", C.amber, "600");
  B = s2;
}

// Takeaway band.
let band = `<rect x="${ax}" y="${bandY}" width="${W - 48}" height="${bandH}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
  + `<text x="${ax + 16}" y="${bandY + 26}" fill="${C.title}" font-size="14.5" font-weight="700">Measured, not gated</text>`;
band += line(ax + 16, bandY + 54, `The AR(1) null is the gate's own significance yardstick; a ${pct(s.ar1FpRate)} false-alarm rate on pure noise says it runs`);
band += line(ax + 16, bandY + 72, "hot. This study only QUANTIFIES that - it changes no threshold, gates nothing, and touches no critic or money path.");
band += line(ax + 16, bandY + bandH - 12, `safeToGate = ${p.safeToGate}; discoveryClaim = ${p.discoveryClaim}; every number is re-derived from the committed P75 report.`, C.title, "600");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="24" y="30" fill="${C.title}" font-size="18" font-weight="700">A model-free null on inverted real curves: the AR(1) significance gate runs hot</text>
  <text x="24" y="48" fill="${C.text}" font-size="11">Every number re-derived from the committed P75 report; positive controls; nothing gated, anchored or claimed (discoveryClaim = false).</text>
  ${A}
  ${B}
  ${band}
</svg>
`;

writeFileSync(OUT, svg, "utf8");
console.log(`wrote ${OUT} (${svg.length} bytes)`);
console.log(`  FP rate: AR(1) ${s.ar1FalseAlarms}/${n}=${pct(s.ar1FpRate)}  block ${s.blockFalseAlarms}/${n}=${pct(s.blockFpRate)}  flips ${s.flips}  mean delta ${s.meanDeltaFap.toFixed(3)}`);
console.log(`  quiet ${s.quiet} red ${s.red}; verdict ${p.verdict}; safeToGate ${p.safeToGate}`);
if (/[^\x00-\x7F]/.test(svg)) { console.log("WARNING: non-ASCII in SVG"); process.exit(1); }
