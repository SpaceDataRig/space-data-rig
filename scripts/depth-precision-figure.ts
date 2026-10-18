// DEPTH PRECISION figure (audit pass 4).
//
// WHAT IT SHOWS, COMPUTED FROM THE COMMITTED MEASUREMENT AND NOTHING ELSE. P90
// (reports/p90-depth-estimators.json) holds one row per confirmed planet whose period this rig's own search
// reproduced, each carrying the depth the guard would publish and the archive depth it was graded against. This
// panel takes the absolute relative error of those rows and shows three things a reader can check by hand:
//   1. the empirical distribution, with the median (which covers HALF the rows) and the radii that cover 68% and
//      95% marked -- because a "+/-" on a published number is read as one standard deviation, roughly 68%, so the
//      median is not the number to print;
//   2. what the board printed before (a bare integer ppm, which claims about one part in a thousand) against what
//      the same measurement supports (the value plus its bar);
//   3. the tail: the worst row is off by more than the depth itself, which is why nothing here advertises a 95%
//      interval.
// Deterministic by construction: no network, no clock in the geometry. It refuses to draw any summary the rows do
// not reproduce -- the medians and radii are recomputed HERE, independently of the report generator, and compared
// against the stored summary before a single pixel is placed. Writes web/depth-precision-figure.svg.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderDepthPpm } from "../src/core/depthFormat.ts";

const W = 980;
const H = 660;
const C = {
  bg: "#0b1020",
  fg: "#e6edf7",
  title: "#7dd3fc",
  good: "#4ade80",
  bad: "#f87171",
  amber: "#fbbf24",
  dim: "#94a3b8",
  card: "#131a2e",
  grid: "#243049",
};
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const medAbs = (a: number[]) => {
  const s = [...a.map(Math.abs)].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const qAbs = (a: number[], p: number) => {
  const s = [...a.map(Math.abs)].sort((x, y) => x - y);
  const h = (s.length - 1) * p;
  const f = Math.floor(h);
  const c = Math.ceil(h);
  return s[f] + (s[c] - s[f]) * (h - f);
};

interface P90 {
  rows: Array<{ name: string; matched: boolean; boxDepthPpm: number; perSectorDepthPpm: number | null; publishedErrPct: number; publishedDepthPpm: number; catDepthPpm: number }>;
  meta: { summary: { publishedMedianAbsErrPct: number; boxMedianAbsErrPct: number; errorBar?: { published: { r68Pct: number; r95Pct: number; worstPct: number } } } };
}

const path = resolve(process.cwd(), "reports", "p90-depth-estimators.json");
const doc = JSON.parse(readFileSync(path, "utf8")) as P90;
const usable = doc.rows.filter((r) => r.matched && Number.isFinite(r.perSectorDepthPpm) && Number.isFinite(r.boxDepthPpm));
const errs = usable.map((r) => r.publishedErrPct);
if (!errs.length) throw new Error("no usable rows in reports/p90-depth-estimators.json -- refusing to draw a figure about nothing");

// Recompute, then REFUSE to draw if the figure and the report disagree. A picture is the least auditable form of
// a claim, so it gets the strictest check of the three.
const med = medAbs(errs);
const stored = doc.meta.summary.publishedMedianAbsErrPct;
if (Math.abs(med - stored) > 1e-6) throw new Error(`recomputed median ${med.toFixed(3)}% vs the report's ${stored.toFixed(3)}% -- not drawing either`);
const eb = doc.meta.summary.errorBar;
if (eb) {
  if (Math.abs(qAbs(errs, 0.68) - eb.published.r68Pct) > 1e-6) throw new Error("68% radius disagrees with the stored measurement");
  if (Math.abs(qAbs(errs, 0.95) - eb.published.r95Pct) > 1e-6) throw new Error("95% radius disagrees with the stored measurement");
}
const r68 = qAbs(errs, 0.68);
const r95 = qAbs(errs, 0.95);
const worst = Math.max(...errs.map(Math.abs));
const bar = Math.ceil(r68 / 10) / 10; // carried UP to one significant figure, exactly as src/core/depthFormat.ts does
// The "now" line is produced by the SAME renderer the product surfaces call, so the figure cannot show a format the
// rig does not actually print. 660 ppm at SNR 29.4 is a real record shape, not a decorative example.
const shownNow = renderDepthPpm(6.6e-4, 29.4);
if (!shownNow) throw new Error("the shipped renderer refused the example depth -- the figure would be fiction");

const x0 = 70;
const x1 = W - 40;
const axisY = 300;
const maxPct = Math.max(worst, r95) * 1.05;
const sx = (v: number) => x0 + (Math.min(v, maxPct) / maxPct) * (x1 - x0);

const out: string[] = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">`);
out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
out.push(`<text x="${x0}" y="34" fill="${C.title}" font-size="21">How well do we know a transit depth? Measured, then printed.</text>`);
out.push(`<text x="${x0}" y="58" fill="${C.dim}" font-size="13">P90: ${usable.length} confirmed planets whose period this rig's own search reproduced within 5%.</text>`);
out.push(`<text x="${x0}" y="76" fill="${C.dim}" font-size="13">Reference: NASA Exoplanet Archive pl_trandep, consulted AFTER both fits and never shown to either.</text>`);

// The distribution: one tick per planet, absolute relative error.
out.push(`<text x="${x0}" y="110" fill="${C.fg}" font-size="15">|published depth - archive depth| for each planet (percent of the archive value)</text>`);
out.push(`<line x1="${x0}" y1="${axisY}" x2="${x1}" y2="${axisY}" stroke="${C.grid}" stroke-width="1"/>`);
for (const t of [0, 25, 50, 75, 100]) {
  out.push(`<line x1="${sx(t)}" y1="${axisY - 4}" x2="${sx(t)}" y2="${axisY + 4}" stroke="${C.dim}"/>`);
  out.push(`<text x="${sx(t)}" y="${axisY + 20}" fill="${C.dim}" font-size="11" text-anchor="middle">${t}%</text>`);
}
usable
  .slice()
  .sort((a, b) => Math.abs(a.publishedErrPct) - Math.abs(b.publishedErrPct))
  .forEach((r, i) => {
    const v = Math.abs(r.publishedErrPct);
    const yy = 130 + i * 9.5;
    const col = v <= med ? C.good : v <= r68 ? C.amber : C.bad;
    out.push(`<line x1="${sx(0) + 2}" y1="${yy}" x2="${sx(v)}" y2="${yy}" stroke="${col}" stroke-width="3" opacity="0.85"/>`);
    out.push(`<text x="${x0 - 6}" y="${yy + 3}" fill="${C.dim}" font-size="9" text-anchor="end">${esc(r.name.slice(0, 18))}</text>`);
  });

// The three radii.
const marks: Array<[number, string, string]> = [
  [med, "median " + med.toFixed(1) + "%", C.dim],
  [r68, "covers 68%: " + r68.toFixed(1) + "%", C.title],
  [r95, "covers 95%: " + r95.toFixed(1) + "%", C.bad],
];
for (const [v, label, col] of marks) {
  out.push(`<line x1="${sx(v)}" y1="120" x2="${sx(v)}" y2="${axisY}" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  out.push(`<text x="${sx(v) + 4}" y="${axisY - 6}" fill="${col}" font-size="11">${esc(label)}</text>`);
}

// What a "+/-" means, and what the card used to print.
const boxY = 340;
out.push(`<rect x="${x0}" y="${boxY}" width="${W - x0 - 40}" height="150" rx="10" fill="${C.card}" stroke="${C.grid}"/>`);
out.push(`<text x="${x0 + 18}" y="${boxY + 26}" fill="${C.fg}" font-size="14">A "+/-" is read as ONE standard deviation, which covers about two thirds.</text>`);
out.push(`<text x="${x0 + 18}" y="${boxY + 46}" fill="${C.dim}" font-size="12">A median covers exactly half the rows, so printing it as the bar under-states the error by design.</text>`);
out.push(`<text x="${x0 + 18}" y="${boxY + 76}" fill="${C.bad}" font-size="13">printed before:   660 ppm (0.0660%)   -- a claim of about one part in a thousand</text>`);
out.push(`<text x="${x0 + 18}" y="${boxY + 98}" fill="${C.good}" font-size="13">printed now:      ${esc(shownNow.text)} (${esc(shownNow.percentText)})   -- rendered by src/core/depthFormat.ts itself</text>`);
out.push(`<text x="${x0 + 18}" y="${boxY + 124}" fill="${C.dim}" font-size="12">the bar is ${Math.round(bar * 100)}% of the depth, in quadrature with each record's own statistical term 1/|snr|;</text>`);
out.push(`<text x="${x0 + 18}" y="${boxY + 140}" fill="${C.dim}" font-size="12">the value keeps its own digits, because the anchored bundle commits depthFrac exactly.</text>`);

// The tail, stated plainly.
out.push(`<text x="${x0}" y="${boxY + 186}" fill="${C.amber}" font-size="13">Worst row: ${worst.toFixed(1)}% -- further off than the depth is deep. 95/68 = ${(r95 / r68).toFixed(2)} against 1.96 for a Gaussian,</text>`);
out.push(`<text x="${x0}" y="${boxY + 204}" fill="${C.amber}" font-size="13">so the one-sigma bar is what is defensible here and no surface doubles it into a 95% interval.</text>`);
out.push(`<text x="${x0}" y="${boxY + 232}" fill="${C.dim}" font-size="12">Same rule applied to the period: a BLS grid node is quoted with the digits the grid resolved, not three decimals.</text>`);
out.push(`<text x="${x0}" y="${H - 16}" fill="${C.dim}" font-size="12">Source: reports/p90-depth-estimators.json | generator: scripts/depth-precision-figure.ts | nothing gated, anchored or claimed.</text>`);
out.push(`</svg>`);

writeFileSync(resolve(process.cwd(), "web", "depth-precision-figure.svg"), out.join("\n") + "\n");
console.log(
  `[figure] ${usable.length} rows | median ${med.toFixed(2)}% | 68% ${r68.toFixed(2)}% | 95% ${r95.toFixed(2)}% | worst ${worst.toFixed(1)}% | bar ${bar.toFixed(2)}`,
);
console.log("[figure] wrote web/depth-precision-figure.svg");
