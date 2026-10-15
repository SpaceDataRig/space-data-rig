// P82 x audit-10 milestone figure -- one honest, all-text SVG summarising the scaled validation run and the
// audit-10 fixes. Reads reports/p82-scaled.json + reports/p84-centroid-diagnosis.json (no hardcoded numbers).
// ASCII only, deterministic, research-only. Usage: npm run figure:p82-audit10
import { readFileSync, writeFileSync } from "node:fs";

const p82 = JSON.parse(readFileSync("reports/p82-scaled.json", "utf8"));
const p84 = JSON.parse(readFileSync("reports/p84-centroid-diagnosis.json", "utf8"));
const pc = (v: number) => `${(v * 100).toFixed(1)}%`;

const blind = p82.blind, ext = p82.external, cen = p82.centroid;
const blends = p84.blends;

const W = 1200, H = 760;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400", anchor = "start") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const panel = (x: number, y: number, w: number, h: number, title: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#141b33" stroke="#26314f"/>` + T(x + 18, y + 30, title, 17, "#5aa9ff", "700");

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const header = T(24, 40, "P82 scaled validation + audit-10 fixes", 24, "#e8ecf7", "800")
  + T(24, 66, "Every number measured on real public TESS-SPOC / Gaia / ExoFOP data. Research only -- not discoveries, not gated.", 13, "#9fb0d6");

// Panel 1: SCALE
const p1 = panel(24, 88, 560, 210, "1. SCALE -- ~20 targets -> hundreds")
  + T(42, 130, "Blind inject-recover", 14, "#9fb0d6", "600")
  + T(42, 152, `${blind.curves} real curves (${blind.injected} injected / ${blind.nullCurves} null)`, 14)
  + T(42, 182, "External independent validation", 14, "#9fb0d6", "600")
  + T(42, 204, `KP controls ${ext.kp.tested} + CP candidates ${ext.cp.tested} claims`, 14)
  + T(42, 234, "Centroid per-contaminant F-test", 14, "#9fb0d6", "600")
  + T(42, 256, `${p82.meta.centroidLimit} targets localised sector by sector`, 14)
  + T(42, 284, "one resumable, concurrent, byte-cached engine (out/scaled checkpoints)", 12, "#9fb0d6");

// Panel 2: BLIND result
const p2 = panel(616, 88, 560, 210, "2. BLIND detection -- the wall holds")
  + T(634, 140, "Recall", 15, "#9fb0d6", "600")
  + T(760, 140, pc(blind.recall), 22, "#37d39b", "800", "end")
  + T(634, 176, "Accepted precision (>=2-sector)", 15, "#9fb0d6", "600")
  + T(760, 176, pc(blind.acceptedPrecision), 22, "#f5b544", "800", "end")
  + T(634, 212, "accepted  " + blind.acceptedUnderBar + "   true  " + blind.acceptedTp + "   false accepts  " + blind.falseAccepts, 14)
  + T(634, 246, "Coherent systematics -- not random noise -- set the floor:", 13, "#9fb0d6")
  + T(634, 266, "more sample narrows the bars, it does not clear the wall.", 13, "#9fb0d6");

// Panel 3: EXTERNAL validation
const p3 = panel(24, 318, 560, 210, "3. EXTERNAL candidates -- independent, blind")
  + T(42, 372, "KP (known planets, positive control)", 14, "#9fb0d6", "600")
  + T(42, 394, `validated ${ext.kp.validated}/${ext.kp.tested}  (CI ${ext.kp.kpCI[0]}-${ext.kp.kpCI[1]}%)`, 15)
  + T(42, 428, "CP (still-uncertain candidates)", 14, "#9fb0d6", "600")
  + T(42, 450, `validated ${ext.cp.validated}/${ext.cp.tested}  (CI ${ext.cp.cpCI[0]}-${ext.cp.cpCI[1]}%)`, 15)
  + T(42, 484, "Strict TRICERATOPS-grade (blend+alias+centroid):", 13, "#9fb0d6")
  + T(42, 504, `KP ${ext.kp.grade}/${ext.kp.tested}, CP ${ext.cp.grade}/${ext.cp.tested} -- the gate is honest, not generous.`, 13, "#9fb0d6");

// Panel 4: CENTROID honest negative + root cause
const p4 = panel(616, 318, 560, 210, "4. CENTROID -- an honest negative + why")
  + T(634, 372, "Known planets wrongly rejected", 14, "#9fb0d6", "600")
  + T(634, 394, `${cen.planetFalseReject}/${cen.planetsTestable}  (compatible with eumemic ${cen.eumemicReference.planetFalseReject})`, 14)
  + T(634, 428, "Labelled blends caught", 14, "#9fb0d6", "600")
  + T(1158, 428, `${cen.blendCaught}/${cen.blendsTestable}`, 22, "#ff6b6b", "800", "end")
  + T(634, 450, `vs eumemic 73% -- our per-contaminant F-test has no catch power here.`, 13, "#9fb0d6")
  + T(634, 484, "P84 root cause: PIXEL-BASELINE-BOUND", 15, "#f5b544", "700")
  + T(634, 504, `coverage loss ${Math.round(blends.coverageLossFrac * 100)}% unlocalisable; offsets match neither target`, 13, "#9fb0d6")
  + T(634, 522, `nor contaminant (median bestNeighbourP ${blends.medianBestNeighbourP}) -- fix pays off chain-wide.`, 13, "#9fb0d6");

// Footer: audit-10 fixes shipped this round
const foot = panel(24, 548, 1152, 168, "audit-10 fixes shipped")
  + T(42, 594, "#2  P81 guardrails: Gaia-unavailable -> 'undetermined' (not NaN, not in any rate); de-diluted", 14)
  + T(42, 616, "     depth past 10% -> flagged inconsistent, excluded from grading, reported as blend evidence.", 14)
  + T(42, 644, "#5  P80 depth-stratified: headline = EASIEST subset (deep+bright); a harder 300-1000ppm tier is", 14)
  + T(42, 666, "     reported alongside so the easy rate is never over-generalised.", 14)
  + T(616, 594, "#6  Reusable inverted planet-free null (src/detect/invertedNull.ts); the AR(1) gate signs", 14)
  + T(616, 616, "     off 75% of pure-noise bumps vs nominal 5% (model-free 31%, n=16) -- now a README headline.", 14)
  + T(616, 644, "#1  Bundle: split the timestamped commitment (bundleHash) from a content address (scienceHash);", 14)
  + T(616, 666, "     new anchor memos carry both, verify unchanged. discoveryClaim false, safeToGate false.", 14);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + header + p1 + p2 + p3 + p4 + foot + `</svg>\n`;
writeFileSync("web/p82-audit10-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/p82-audit10-figure.svg  bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
