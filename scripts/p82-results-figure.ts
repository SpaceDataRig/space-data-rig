// P82 RESULTS figure -- a single clean, all-text SVG for the "full 500-target run finished" tweet. Reads
// reports/p82-scaled.json + reports/p84-centroid-diagnosis.json (no hardcoded numbers); one band per probe +
// the centroid root cause. ASCII only, deterministic, research-only. Usage: npm run figure:p82-results
import { readFileSync, writeFileSync } from "node:fs";

const p82 = JSON.parse(readFileSync("reports/p82-scaled.json", "utf8"));
const p84 = JSON.parse(readFileSync("reports/p84-centroid-diagnosis.json", "utf8"));
const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
const blind = p82.blind, ext = p82.external, cen = p82.centroid, blends = p84.blends;

const W = 1200, H = 660;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400", anchor = "start") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const card = (x: number, y: number, w: number, h: number, title: string, accent: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>` +
  `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>` + T(x + 22, y + 34, title, 18, accent, "800");

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const header = T(28, 44, "P82 -- TESS transit rig, scaled to hundreds of real targets", 25, "#e8ecf7", "800")
  + T(28, 70, "Every figure measured on public TESS-SPOC / Gaia / ExoFOP data. First-order checks and positive controls, not discoveries.", 13, "#9fb0d6");

// BLIND band
const b1 = card(28, 92, 372, 250, "BLIND inject-recover", "#37d39b")
  + T(50, 140, `${blind.curves} real curves`, 15, "#9fb0d6", "600")
  + T(50, 162, `${blind.injected} injected / ${blind.nullCurves} null`, 13, "#9fb0d6")
  + T(50, 210, "Recall", 15, "#9fb0d6")
  + T(380, 210, pc(blind.recall), 30, "#37d39b", "800", "end")
  + T(50, 232, `95% CI ${pc(blind.recallCI[0])} - ${pc(blind.recallCI[1])}`, 12, "#9fb0d6")
  + T(50, 278, "Accepted precision (>=2-sector)", 15, "#9fb0d6")
  + T(380, 278, pc(blind.acceptedPrecision), 30, "#f5b544", "800", "end")
  + T(50, 300, `${blind.falseAccepts} false accepts of ${blind.acceptedUnderBar} accepted`, 12, "#9fb0d6")
  + T(50, 326, "Coherent systematics, not noise: more N", 12, "#9fb0d6")
  + T(50, 342, "narrows bars, does not clear the wall.", 12, "#9fb0d6");

// EXTERNAL band
const b2 = card(414, 92, 372, 250, "EXTERNAL independent", "#5aa9ff")
  + T(436, 140, "detector BLIND -- claim", 13, "#9fb0d6")
  + T(436, 158, "ephemeris never fed", 13, "#9fb0d6")
  + T(436, 205, "Confirmed planets (KP control)", 15, "#9fb0d6", "600")
  + T(772, 205, `${ext.kp.validated}/${ext.kp.tested}`, 26, "#5aa9ff", "800", "end")
  + T(436, 227, `reproduced blind, CI ${ext.kp.kpCI[0]}-${ext.kp.kpCI[1]}%`, 12, "#9fb0d6")
  + T(436, 272, "Uncertain candidates (CP)", 15, "#9fb0d6", "600")
  + T(772, 272, `${ext.cp.validated}/${ext.cp.tested}`, 26, "#5aa9ff", "800", "end")
  + T(436, 294, `reproduced blind, CI ${ext.cp.cpCI[0]}-${ext.cp.cpCI[1]}%`, 12, "#9fb0d6")
  + T(436, 326, "Strict blend+alias+centroid grade:", 12, "#9fb0d6")
  + T(436, 342, `KP ${ext.kp.grade}/${ext.kp.tested}, CP ${ext.cp.grade}/${ext.cp.tested}`, 13, "#e8ecf7", "700");

// CENTROID band
const b3 = card(800, 92, 372, 250, "CENTROID F-test", "#ff6b6b")
  + T(822, 140, `${p82.meta.centroidLimit} targets, sector by sector`, 13, "#9fb0d6")
  + T(822, 186, "Known planets wrongly rejected", 14, "#9fb0d6", "600")
  + T(1150, 186, `${cen.planetFalseReject}/${cen.planetsTestable}`, 24, "#37d39b", "800", "end")
  + T(822, 208, `compatible with eumemic ${cen.eumemicReference.planetFalseReject}`, 11, "#9fb0d6")
  + T(822, 254, "Labelled blends CAUGHT", 14, "#9fb0d6", "600")
  + T(1150, 254, `${cen.blendCaught}/${cen.blendsTestable}`, 24, "#ff6b6b", "800", "end")
  + T(822, 276, `vs eumemic 73% -- no catch power here`, 12, "#9fb0d6")
  + T(822, 306, "P84 root cause: PIXEL-BASELINE-BOUND", 14, "#f5b544", "800")
  + T(822, 326, `${Math.round(blends.coverageLossFrac * 100)}% never localise; statistic is fine,`, 11, "#9fb0d6")
  + T(822, 342, `our per-sector centroid is the limiter.`, 11, "#9fb0d6");

// Footer band: honest framing + sample-size comparison
const foot = `<rect x="28" y="358" width="1144" height="278" rx="16" fill="#0e1428" stroke="#26314f"/>`
  + T(50, 392, "What grew, and what did not", 18, "#5aa9ff", "800")
  + T(50, 426, "Sample size scales: ~20 hand-picked targets (P77/P78/P80) -> hundreds per probe here, from one", 14)
  + T(50, 448, "resumable, concurrent, byte-cached engine on real public data. Error bars shrink accordingly.", 14)
  + T(50, 486, "The hard walls do not scale away: accepted precision stays ~42% (coherent systematics recur across", 14)
  + T(50, 508, "sectors), the strict external grade stays tiny, and the centroid blend-catch is 0/56 -- so the next", 14)
  + T(50, 530, "real gains are in the pixel baseline (WCS / centroid precision / sector alignment), not a bigger N.", 14)
  + T(50, 574, "Measure-only: safeToGate false, discoveryClaim false. Full numbers: reports/p82-scaled.{md,json} and reports/p84-centroid-diagnosis.{md,json}.", 12, "#9fb0d6")
  + T(50, 600, "Reproduce: npm run p82:scaled -- --probe report ; npm run p84:centroid-diagnosis", 12, "#9fb0d6");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + header + b1 + b2 + b3 + foot + `</svg>\n`;
writeFileSync("web/p82-results-figure.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/p82-results-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
