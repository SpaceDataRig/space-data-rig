// P37 RESULTS FIGURE: one real-data, multi-panel SVG that synthesizes the committed research reports into a
// single shareable picture. It reads ONLY files already in reports/ (no network, no re-analysis) and re-derives
// the numbers exactly as the source reports publish them:
//   * reports/p33-catalog.json          -- the TypeScript iterative detector (box-fit BLS) on real TESS-SPOC stars
//   * reports/p35-pdm-crosscheck.json   -- PDM, a non-parametric period finder sharing no machinery with BLS
//   * reports/crosscheck/cross-pipeline.json -- a SEPARATE Python stack (wotan detrend + astropy BLS) on the same stars
// Panel A: completeness vs injected transit depth for the three independent estimators. Panel B: blind detection
// purity as raw true/false positive counts on the real curves (a lower bound -- an unconfirmed planet counts FP).
//
// Presentation artifact only: nothing in the analysis core or the reproducible bundle reads it, so bundle hashes
// are unchanged. Deterministic given the committed reports. Not run in CI.
//
// Usage: npm run p37:figure   (writes web/results-figure.svg)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "web/results-figure.svg";

function load(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

const p33 = load("reports/p33-catalog.json");
const p35 = load("reports/p35-pdm-crosscheck.json");
const xc = load("reports/crosscheck/cross-pipeline.json");

const depths: number[] = p33.meta.depthsPpm;
const N33: number = p33.rows.length;
const N35: number = p35.rows.length;
const xcN: number = xc.summary.curves;

// completeness per depth for each estimator, as a fraction 0..1
const compTS = depths.map((d) => p33.rows.filter((r: any) => r.recByDepth[String(d)] === true).length / N33);
const compPDM = depths.map((d) => p35.rows.filter((r: any) => r.pdmRecByDepth[String(d)] === true).length / N35);
const compPY = depths.map((d) => {
  const cell = xc.summary.blsCompletenessByDepth[String(d)];
  return cell ? cell.recovered / xcN : 0;
});

// blind purity raw counts (NULL arm): true positives vs false positives on the real curves
const tsTP = p33.rows.reduce((a: number, r: any) => a + r.nullTP, 0);
const tsFP = p33.rows.reduce((a: number, r: any) => a + r.nullFP, 0);
const pyTP = xc.summary.nullTP;
const pyFP = xc.summary.nullFP;
const tsPurity = (100 * tsTP / (tsTP + tsFP)).toFixed(1);
const pyPurity = (100 * pyTP / (pyTP + pyFP)).toFixed(1);

// ---- SVG geometry ----
const W = 960, H = 380;
const C = { bg: "#0b1220", teal: "#5ad1a8", blue: "#8fc6ff", amber: "#e0a458", axis: "#3b4a63", text: "#9fb4d4", title: "#e7f0ff", fp: "#d9776f", grid: "#1c2740" };

// Panel A plot box
const aL = 66, aR = 470, aT = 58, aB = 300;
const aX = (i: number) => aL + (i / (depths.length - 1)) * (aR - aL);
const aY = (f: number) => aB - f * (aB - aT);
function series(vals: number[], color: string): string {
  const pts = vals.map((v, i) => `${aX(i).toFixed(1)},${aY(v).toFixed(1)}`).join(" ");
  const dots = vals.map((v, i) => `<circle cx="${aX(i).toFixed(1)}" cy="${aY(v).toFixed(1)}" r="3.1" fill="${color}"/>`).join("");
  return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2"/>${dots}`;
}
let aGrid = "";
for (const g of [0, 0.25, 0.5, 0.75, 1.0]) {
  const y = aY(g).toFixed(1);
  aGrid += `<line x1="${aL}" y1="${y}" x2="${aR}" y2="${y}" stroke="${C.grid}"/><text x="${aL - 8}" y="${(Number(y) + 4).toFixed(1)}" fill="${C.text}" font-size="11" text-anchor="end">${(g * 100).toFixed(0)}%</text>`;
}
let aXLabels = depths.map((d, i) => `<text x="${aX(i).toFixed(1)}" y="${aB + 18}" fill="${C.text}" font-size="11" text-anchor="middle">${d}</text>`).join("");

// Panel B bars: two groups (TS, Python), each TP + FP
const bL = 560, bR = 910, bT = 58, bB = 300;
const maxCount = Math.max(tsTP + tsFP, pyTP + pyFP);
const bY = (n: number) => bB - (n / maxCount) * (bB - bT);
const barW = 42;
const groups = [
  { name: "TypeScript", x0: bL + 30, tp: tsTP, fp: tsFP, purity: tsPurity, tpColor: C.teal },
  { name: "Python", x0: bL + 200, tp: pyTP, fp: pyFP, purity: pyPurity, tpColor: C.blue },
];
let bars = "";
for (const gp of groups) {
  const stackTop = bY(gp.tp + gp.fp);
  bars += `<rect x="${gp.x0}" y="${bY(gp.fp).toFixed(1)}" width="${barW}" height="${(bB - bY(gp.fp)).toFixed(1)}" fill="${C.fp}"/>`;
  bars += `<rect x="${gp.x0}" y="${stackTop.toFixed(1)}" width="${barW}" height="${(bY(gp.fp) - bY(gp.tp + gp.fp)).toFixed(1)}" fill="${gp.tpColor}"/>`;
  bars += `<text x="${gp.x0 + barW / 2}" y="${(stackTop - 6).toFixed(1)}" fill="${C.title}" font-size="11" text-anchor="middle">${gp.purity}% pure</text>`;
  bars += `<text x="${gp.x0 + barW / 2}" y="${bB + 18}" fill="${C.text}" font-size="12" text-anchor="middle">${gp.name}</text>`;
  bars += `<text x="${gp.x0 + barW / 2}" y="${bB + 34}" fill="${C.text}" font-size="10" text-anchor="middle">${gp.tp} TP / ${gp.fp} FP</text>`;
}
let bGrid = "";
for (const g of [0, 10, 20, 30]) {
  if (g > maxCount) break;
  const y = bY(g).toFixed(1);
  bGrid += `<line x1="${bL}" y1="${y}" x2="${bR}" y2="${y}" stroke="${C.grid}"/><text x="${bL - 8}" y="${(Number(y) + 4).toFixed(1)}" fill="${C.text}" font-size="11" text-anchor="end">${g}</text>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="${aL}" y="26" fill="${C.title}" font-size="16" font-weight="700">Independent transit-detection validation on real TESS photometry</text>
  <text x="${aL}" y="44" fill="${C.text}" font-size="11">Three estimators sharing no code, run on the same seeded real host stars (injection-recovery at P = 3 d; seed 7).</text>

  <text x="${aL}" y="${aT - 12}" fill="${C.title}" font-size="13" font-weight="600">A. Completeness vs injected depth</text>
  ${aGrid}
  <line x1="${aL}" y1="${aT}" x2="${aL}" y2="${aB}" stroke="${C.axis}"/>
  <line x1="${aL}" y1="${aB}" x2="${aR}" y2="${aB}" stroke="${C.axis}"/>
  ${series(compTS, C.teal)}
  ${series(compPY, C.blue)}
  ${series(compPDM, C.amber)}
  ${aXLabels}
  <text x="${((aL + aR) / 2).toFixed(0)}" y="${aB + 38}" fill="${C.text}" font-size="11" text-anchor="middle">injected transit depth (ppm)</text>
  <g font-size="11">
    <line x1="${aL + 8}" y1="${aT + 6}" x2="${aL + 30}" y2="${aT + 6}" stroke="${C.teal}" stroke-width="2.2"/><text x="${aL + 36}" y="${aT + 10}" fill="${C.text}">TypeScript box-fit BLS (N=${N33})</text>
    <line x1="${aL + 8}" y1="${aT + 22}" x2="${aL + 30}" y2="${aT + 22}" stroke="${C.blue}" stroke-width="2.2"/><text x="${aL + 36}" y="${aT + 26}" fill="${C.text}">Python wotan + astropy BLS (N=${xcN})</text>
    <line x1="${aL + 8}" y1="${aT + 38}" x2="${aL + 30}" y2="${aT + 38}" stroke="${C.amber}" stroke-width="2.2"/><text x="${aL + 36}" y="${aT + 42}" fill="${C.text}">PDM period finder (N=${N35})</text>
  </g>

  <text x="${bL}" y="${bT - 12}" fill="${C.title}" font-size="13" font-weight="600">B. Blind purity on the real curves (lower bound)</text>
  ${bGrid}
  <line x1="${bL}" y1="${bT}" x2="${bL}" y2="${bB}" stroke="${C.axis}"/>
  <line x1="${bL}" y1="${bB}" x2="${bR}" y2="${bB}" stroke="${C.axis}"/>
  ${bars}
  <text x="${bL}" y="${bB + 52}" fill="${C.text}" font-size="10">A gated detection matching a KNOWN confirmed planet = TP; matching nothing known = FP,</text>
  <text x="${bL}" y="${bB + 66}" fill="${C.text}" font-size="10">so a genuine-but-unconfirmed planet counts as FP: purity is a deliberate lower bound.</text>
</svg>
`;

writeFileSync(OUT, svg, "utf8");
console.log(`wrote ${OUT} (${svg.length} bytes)`);
console.log(`  completeness TS   : ${compTS.map((v) => (v * 100).toFixed(0) + "%").join(" ")}`);
console.log(`  completeness PY   : ${compPY.map((v) => (v * 100).toFixed(0) + "%").join(" ")}`);
console.log(`  completeness PDM  : ${compPDM.map((v) => (v * 100).toFixed(0) + "%").join(" ")}`);
console.log(`  purity TS ${tsPurity}% (${tsTP}TP/${tsFP}FP), Python ${pyPurity}% (${pyTP}TP/${pyFP}FP)`);
if (/[^\x00-\x7F]/.test(svg)) { console.log("WARNING: non-ASCII in SVG"); process.exitCode = 1; }
