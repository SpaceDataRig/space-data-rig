// MILESTONE FIGURE (P62-P65): one shareable SVG that synthesizes ONLY the committed reports of this
// measure-before-gate round into a single picture. It reads files already in reports/ (no network, no
// re-analysis) and re-derives each number exactly as its source report publishes it:
//   * reports/p62-phase-aligned-joint.json -- four-arm joint-fold A/B (the negative result)
//   * reports/p63-soft-score.json          -- continuous blend-likelihood operating point (score, not gate)
//   * reports/p64-fetch-telemetry.json     -- cold vs warm cache-hit telemetry (download is the bottleneck)
//   * reports/p65-external-audit.json      -- third-party claims run through the full critic + gates
//
// Presentation artifact only: nothing in the analysis core or the reproducible bundle reads it, so bundle
// hashes are unchanged. Deterministic given the committed reports. Not run in CI. discoveryClaim stays false
// everywhere -- these are characterizations of the search, not a discovery.
//
// Usage: npm run p66:milestone-figure   (writes web/milestone-figure.svg)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "web/milestone-figure.svg";

function load(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

const p62 = load("reports/p62-phase-aligned-joint.json");
const p63 = load("reports/p63-soft-score.json");
const p64 = load("reports/p64-fetch-telemetry.json");
const p65 = load("reports/p65-external-audit.json");

// ---- SVG palette + geometry ----
const C = { bg: "#0b1220", teal: "#5ad1a8", blue: "#8fc6ff", amber: "#e0a458", axis: "#3b4a63", text: "#9fb4d4", title: "#e7f0ff", fp: "#d9776f", grid: "#1c2740", card: "#111a2e", edge: "#22304d" };

// ---- re-derive the headline numbers straight from the committed fields ----
const N62: number = p62.singleRefind.n;
const arms = [
  { name: "SINGLE", v: p62.singleRefind.count, color: C.blue },
  { name: "NAIVE-JOINT", v: p62.naiveJointRefind.count, color: C.blue },
  { name: "REFINED (data seed)", v: p62.refinedRefind.count, color: C.fp },
  { name: "ORACLE (truth seed)", v: p62.oracleRefind.count, color: C.teal },
];

const op = p63.operatingPoint;
const cut = (op.threshold * 100).toFixed(0);

const cold = p64.coldPass.stats;
const warm = p64.warmPass;

const outs: any[] = p65.outcomes;
const passes = outs.filter((o) => o.passesCurrentGate === true).length;

// ---- SVG geometry ----
const W = 960, H = 560;

// 2x2 card grid
const gx = [24, 492], gy = [64, 320];
const cw = 444, ch = 236;

function card(x: number, y: number, title: string, sub: string): string {
  return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
    + `<text x="${x + 16}" y="${y + 26}" fill="${C.title}" font-size="15" font-weight="700">${title}</text>`
    + `<text x="${x + 16}" y="${y + 44}" fill="${C.text}" font-size="11">${sub}</text>`;
}

// Panel A: P62 four-arm bars
const aX = gx[0] + 150, aBarH = 26, aTop = gy[0] + 66, aMax = 12, aScale = (v: number) => (v / aMax) * 250;
let pA = card(gx[0], gy[0], "P62 | Phase-aligned joint fold", "Re-find of 20 known planets - does a smarter fold help?");
for (let i = 0; i < arms.length; i++) {
  const y = aTop + i * (aBarH + 12);
  pA += `<text x="${aX - 8}" y="${y + aBarH / 2 + 4}" fill="${C.text}" font-size="11" text-anchor="end">${arms[i].name}</text>`;
  pA += `<rect x="${aX}" y="${y}" width="${aScale(arms[i].v).toFixed(1)}" height="${aBarH}" rx="3" fill="${arms[i].color}"/>`;
  pA += `<text x="${(aX + aScale(arms[i].v) + 8).toFixed(1)}" y="${y + aBarH / 2 + 4}" fill="${C.title}" font-size="12" font-weight="600">${arms[i].v}/${N62}</text>`;
}
pA += `<text x="${gx[0] + 16}" y="${gy[0] + ch - 14}" fill="${C.amber}" font-size="11" font-weight="600">NO-LIFT - the fold doubles (4->10) only with a truth seed;</text>`;
pA += `<text x="${gx[0] + 16}" y="${gy[0] + ch - 1}" fill="${C.amber}" font-size="11" font-weight="600">a blind seed is usually the wrong period -> bottleneck = seed acquisition.</text>`;

// Panel B: P63 soft score
const bX = gx[1], bY = gy[0];
let pB = card(bX, bY, "P63 | Soft blend-likelihood", "Continuous score (0-1), advisory weight - NOT a veto.");
const big = (cx: number, cy: number, val: string, lbl: string, col: string) =>
  `<text x="${cx}" y="${cy}" fill="${col}" font-size="34" font-weight="700" text-anchor="middle">${val}</text>`
  + `<text x="${cx}" y="${cy + 20}" fill="${C.text}" font-size="11" text-anchor="middle">${lbl}</text>`;
pB += big(bX + 120, bY + 110, `${op.falseKills}/${op.nPlanets}`, `${(op.falseVetoRate * 100).toFixed(0)}% false-kill rate`, C.fp);
pB += big(bX + 320, bY + 110, `${op.caughtBlends}/${op.nBlends}`, `${(op.blendCatchRate * 100).toFixed(0)}% blends caught`, C.teal);
pB += `<text x="${bX + 16}" y="${bY + 168}" fill="${C.text}" font-size="11">Operating point: flag when blend-likelihood >= ${cut}.</text>`;
pB += `<text x="${bX + 16}" y="${bY + 186}" fill="${C.text}" font-size="11">A non-zero false-kill is exactly why this is a score, not a gate;</text>`;
pB += `<text x="${bX + 16}" y="${bY + 204}" fill="${C.text}" font-size="11">it weights the critic (additive, default-off) - money path unchanged.</text>`;

// Panel C: P64 fetch telemetry
const cX = gx[0], cY = gy[1];
let pC = card(cX, cY, "P64 | Multi-sector fetch telemetry", "Same bytes, repeat sweep - is re-fetch the bottleneck?");
pC += big(cX + 120, cY + 110, `${(cold.cacheHitRate * 100).toFixed(0)}%`, `cold cache (${cold.cacheHits}/${cold.byteRequests})`, C.blue);
pC += big(cX + 320, cY + 110, `${(warm.hitRate * 100).toFixed(0)}%`, `warm cache (${warm.hits}/${warm.hits + warm.misses})`, C.teal);
pC += `<text x="${cX + 16}" y="${cY + 168}" fill="${C.text}" font-size="11">Wall time ${p64.coldPass.wallMs}ms cold -> ${warm.wallMs}ms warm - download is</text>`;
pC += `<text x="${cX + 16}" y="${cY + 186}" fill="${C.text}" font-size="11">the bottleneck; a per-key cache makes multi-study re-fetch free.</text>`;
pC += `<text x="${cX + 16}" y="${cY + 204}" fill="${C.amber}" font-size="11" font-weight="600">WARM-CACHE-FREE - research-first, no production change yet.</text>`;

// Panel D: P65 external audit
const dX = gx[1], dY = gy[1];
let pD = card(dX, dY, "P65 | External-candidate audit", "Third-party claim -> full critic + gates, research mode.");
pD += big(dX + 120, dY + 110, `${passes}/${outs.length}`, `pass current gate`, C.fp);
let noteY = dY + 82;
for (const o of outs) {
  pD += `<text x="${dX + 224}" y="${noteY}" fill="${C.text}" font-size="11">- ${o.label}: ${o.criticVerdict} (FAP ${o.fap.toFixed(2)}, blend ${o.blendScore.toFixed(2)})</text>`;
  noteY += 18;
}
pD += `<text x="${dX + 16}" y="${dY + 168}" fill="${C.text}" font-size="11">The critic runs blind (catalog = []), so an outside signal caps at</text>`;
pD += `<text x="${dX + 16}" y="${dY + 186}" fill="${C.text}" font-size="11">needs-more-data / rejected - never auto-claimed or staked.</text>`;
pD += `<text x="${dX + 16}" y="${dY + 204}" fill="${C.amber}" font-size="11" font-weight="600">discoveryClaim false, anchored false - no on-chain money path.</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="24" y="30" fill="${C.title}" font-size="18" font-weight="700">Measure before you gate: four targeted follow-ups on real TESS photometry</text>
  <text x="24" y="48" fill="${C.text}" font-size="11">Every number re-derived from a committed report; positive controls on known planets; nothing gated, anchored or claimed (discoveryClaim = false).</text>
  ${pA}
  ${pB}
  ${pC}
  ${pD}
</svg>
`;

writeFileSync(OUT, svg, "utf8");
console.log(`wrote ${OUT} (${svg.length} bytes)`);
console.log(`  P62 arms (/${N62}): ${arms.map((a) => a.name + "=" + a.v).join("  ")}`);
console.log(`  P63 cut ${cut}: false-kill ${op.falseKills}/${op.nPlanets}, catch ${op.caughtBlends}/${op.nBlends}`);
console.log(`  P64 cache: cold ${(cold.cacheHitRate * 100).toFixed(0)}% -> warm ${(warm.hitRate * 100).toFixed(0)}%`);
console.log(`  P65 external: ${passes}/${outs.length} pass current gate`);
if (/[^\x00-\x7F]/.test(svg)) { console.log("WARNING: non-ASCII in SVG"); process.exitCode = 1; }
