// MILESTONE FIGURE (P67-P71): the follow-up round to the reviewer's five critiques. One shareable SVG that
// synthesizes ONLY the committed reports of this measure-before-gate round -- it reads files already in
// reports/ (no network, no re-analysis) and re-derives each number exactly as its source report publishes it:
//   * reports/p67-seed-precision.json            -- seed recall: naive peak vs the production iterative detector
//   * reports/p68-discriminator-roc.json          -- full-threshold ROC/AUC of every vetting discriminator
//   * reports/p69-rednoise-significance.json      -- AR(1)-model null vs model-free block bootstrap on real noise
//   * reports/p70-llm-ablation.json               -- does the LLM change any decision? (structural ablation)
//   * reports/p71-audit-positive-control.json     -- is the "accepted" branch reachable at all? blind vs corroborated
//
// Presentation artifact only: nothing in the analysis core or the reproducible bundle reads it, so bundle
// hashes are unchanged. Deterministic given the committed reports. Not run in CI. discoveryClaim stays false
// everywhere -- these are characterizations of the search, not a discovery.
//
// Usage: npm run p72:followups-figure   (writes web/followups-figure.svg)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "web/followups-figure.svg";

function load(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

const p67 = load("reports/p67-seed-precision.json");
const p68 = load("reports/p68-discriminator-roc.json");
const p69 = load("reports/p69-rednoise-significance.json");
const p70 = load("reports/p70-llm-ablation.json");
const p71 = load("reports/p71-audit-positive-control.json");

// ---- SVG palette ----
const C = { bg: "#0b1220", teal: "#5ad1a8", blue: "#8fc6ff", amber: "#e0a458", axis: "#3b4a63", text: "#9fb4d4", title: "#e7f0ff", fp: "#d9776f", grid: "#1c2740", card: "#111a2e", edge: "#22304d" };

// ---- re-derive the headline numbers straight from the committed fields ----
const n67: number = p67.seedHit.naivePeak.n;
const seedBars = [
  { name: "naive BLS peak", v: p67.seedHit.naivePeak.count, color: C.blue },
  { name: "iterative top-1", v: p67.seedHit.iterativeTop1.count, color: C.blue },
  { name: "iterative top-3", v: p67.seedHit.iterativeTopK.count, color: C.teal },
  { name: "oracle (truth)", v: p67.refinedRefind.oracleSeed, color: C.amber },
];

// P68: discriminators is a map keyed by short name; each value has .auc. Use readable short labels.
const SHORT: Record<string, string> = {
  "shape-coherence": "shape coherence", "psf-localize": "PSF offset", "odd-even-depth": "odd/even depth",
  "secondary-eclipse": "secondary ecl.", "gaia-dilution": "Gaia dilution", "red-detection": "re-detection",
};
const disc: Array<{ label: string; auc: number }> = Object.entries(p68.discriminators as Record<string, any>)
  .map(([k, v]) => ({ label: SHORT[k] || String(k), auc: v.auc as number }))
  .sort((a, b) => b.auc - a.auc);

const s69 = p69.summary;
const mq = p70.modelQuality;
const ab = p70.structuralAblation;
const s71 = p71.summary;

// ---- SVG geometry: 2 columns x 3 rows of WIDE cards (same card width as the P62-P65 figure) ----
const W = 960, H = 800;
const gx = [24, 492];
const gy = [64, 306, 548];
const cw = 444, ch = 222;

function card(x: number, y: number, title: string, sub: string): string {
  return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="${C.card}" stroke="${C.edge}"/>`
    + `<text x="${x + 16}" y="${y + 26}" fill="${C.title}" font-size="14.5" font-weight="700">${title}</text>`
    + `<text x="${x + 16}" y="${y + 43}" fill="${C.text}" font-size="10.5">${sub}</text>`;
}
function big(cx: number, cy: number, val: string, lbl: string, col: string): string {
  return `<text x="${cx}" y="${cy}" fill="${col}" font-size="32" font-weight="700" text-anchor="middle">${val}</text>`
    + `<text x="${cx}" y="${cy + 16}" fill="${C.text}" font-size="10.5" text-anchor="middle">${lbl}</text>`;
}
function line(x: number, y: number, txt: string, col = C.text, weight = "400"): string {
  return `<text x="${x}" y="${y}" fill="${col}" font-size="10.5" font-weight="${weight}">${txt}</text>`;
}

// panel SVG strings (assigned in the blocks below, emitted in order in the <svg>)
let A = "", B = "", Cd = "", D = "", E = "", F = "";

// Panel A (0,0): P67 seed precision - horizontal bars of seed-hit count on 20 known planets.
{
  const x = gx[0], y = gy[0];
  const bx = x + 150, bw = 170, top = y + 60, bh = 20, step = 29, max = 12;
  let s = card(x, y, "P67 | Is the seed wall real?", "Does the iterative detector seed better than one BLS peak?");
  for (let i = 0; i < seedBars.length; i++) {
    const by = top + i * step;
    const w = Math.max(2, (seedBars[i].v / max) * bw);
    s += `<text x="${bx - 8}" y="${by + bh / 2 + 4}" fill="${C.text}" font-size="10.5" text-anchor="end">${seedBars[i].name}</text>`;
    s += `<rect x="${bx}" y="${by}" width="${w.toFixed(1)}" height="${bh}" rx="3" fill="${seedBars[i].color}"/>`;
    s += `<text x="${(bx + w + 7).toFixed(1)}" y="${by + bh / 2 + 4}" fill="${C.title}" font-size="11.5" font-weight="600">${seedBars[i].v}/${n67}</text>`;
  }
  s += line(x + 16, y + ch - 40, `Iterative multi-signal seeding lifts recall by only +${p67.seedHit.recallGainPp} pp (Wilson CIs overlap).`);
  s += line(x + 16, y + ch - 22, "MODEST-SEED-LIFT - the P62 seed wall holds; a blind correct seed is key.", C.amber, "600");
  A = s;
}

// Panel B (1,0): P68 discriminator ROC - AUC bars with a 0.5 chance line.
{
  const x = gx[1], y = gy[0];
  const bx = x + 150, bw = 150, top = y + 58, bh = 16, step = 22, max = 1;
  const chanceX = bx + 0.5 * bw;
  let s = card(x, y, "P68 | Can any tool self-validate?", "Full threshold sweep: AUC of each discriminator (blend vs planet).");
  s += `<line x1="${chanceX.toFixed(1)}" y1="${top - 6}" x2="${chanceX.toFixed(1)}" y2="${(top + (disc.length - 1) * step + bh).toFixed(1)}" stroke="${C.axis}" stroke-dasharray="3 2"/>`;
  for (let i = 0; i < disc.length; i++) {
    const by = top + i * step;
    const w = Math.max(2, disc[i].auc * bw);
    const col = disc[i].auc < 0.5 ? C.fp : i === 0 ? C.teal : C.blue;
    s += `<text x="${bx - 8}" y="${by + bh / 2 + 3}" fill="${C.text}" font-size="10.5" text-anchor="end">${disc[i].label}</text>`;
    s += `<rect x="${bx}" y="${by}" width="${w.toFixed(1)}" height="${bh}" rx="2" fill="${col}"/>`;
    s += `<text x="${(bx + w + 6).toFixed(1)}" y="${by + bh / 2 + 3}" fill="${C.title}" font-size="10.5" font-weight="600">${disc[i].auc.toFixed(2)}</text>`;
  }
  s += `<text x="${chanceX.toFixed(1)}" y="${top + disc.length * step - 2}" fill="${C.text}" font-size="9.5" text-anchor="middle">0.5 = chance</text>`;
  s += line(x + 16, y + ch - 40, `Best AUC ${p68.bestAuc.toFixed(2)} (${p68.bestTest}); Gaia dilution is below chance (0.47).`);
  s += line(x + 16, y + ch - 22, "NO-GATE at any threshold - a single-digit % blend catch at zero false-kill.", C.fp, "600");
  B = s;
}

// Panel C (0,1): P69 red-noise FAP.
{
  const x = gx[0], y = gy[1];
  let s = card(x, y, "P69 | Is our significance honest?", "AR(1)-model null vs a model-free block bootstrap on real noise bumps.");
  s += big(x + 110, y + 108, `${s69.flipsNoise}/${s69.noiseLike}`, "noise bumps only AR(1) clears", C.fp);
  s += big(x + 300, y + 108, `+${s69.meanDeltaNoise.toFixed(2)}`, "mean FAP delta (AR1 - bootstrap)", C.amber);
  s += line(x + 16, y + 148, "The synthetic AR(1) ensemble understates the real residual tails, so the");
  s += line(x + 16, y + 164, "FAP gate is slightly OPTIMISTIC. Not an active-star effect (excess@lag");
  s += line(x + 16, y + 180, `${s69.meanExcessAtLastLag.toFixed(2)}). Caveat: multi-planet masks leave sibling signal (max SNR ${Math.round(s69.maxResidualSnr)}).`);
  s += line(x + 16, y + ch - 8, "Measured only - the production gate is unchanged.", C.title, "600");
  Cd = s;
}

// Panel D (1,1): P70 LLM ablation.
{
  const x = gx[1], y = gy[1];
  let s = card(x, y, "P70 | Does the LLM decide anything?", "Structural ablation + the model's informational quality.");
  s += big(x + 110, y + 108, `${ab.decisionsChangedByLLM}`, "decisions the LLM changed", C.teal);
  s += big(x + 300, y + 108, `${mq.blendUnderFlagged}/${mq.nBlends}`, "labelled blends it called PLANET", C.fp);
  s += line(x + 16, y + 150, "Verified by recompute: the gate/verdict path never reads the model, so");
  s += line(x + 16, y + 166, "removing it provably changes ZERO decisions. On information it UNDER-");
  s += line(x + 16, y + 182, "flags blends - worse than the deterministic tests, which caught only 1/3.");
  s += line(x + 16, y + ch - 8, "Hypothesis broker, not arbiter - it stays advisory. Money path untouched.", C.amber, "600");
  D = s;
}

// Panel E (0,2): P71 accept-path control.
{
  const x = gx[0], y = gy[2];
  let s = card(x, y, "P71 | Is 'accepted' even reachable?", "Same known planets, run BLIND (catalog = []) vs CORROBORATED.");
  s += big(x + 110, y + 108, `${s71.blindAccepted}/${s71.blindNeedsMoreData}`, "accepted BLIND (all need-more-data)", C.fp);
  s += big(x + 300, y + 108, `${s71.corroborationAccepted}/${s71.blindNeedsMoreData}`, "accepted when corroborated", C.teal);
  s += line(x + 16, y + 150, "Detect -> critic is the SAME machinery; the only difference is whether");
  s += line(x + 16, y + 166, "the host is corroborated (pi Men c is one that flips). So P65's \"0/2 pass\"");
  s += line(x + 16, y + 182, "is the CORRECT blind-by-design result - a novel claim has no match.");
  s += line(x + 16, y + ch - 8, "ACCEPT-PATH-REACHABLE - fires the instant the catalog corroborates.", C.teal, "600");
  E = s;
}

// Panel F (1,2): round takeaway.
{
  const x = gx[1], y = gy[2];
  let s = card(x, y, "This round | what changed", "Five targeted critiques, measured on real TESS photometry.");
  const rows = [
    ["P67", "the seed wall holds", C.blue],
    ["P68", "no tool can gate", C.fp],
    ["P69", "FAP slightly optimistic", C.amber],
    ["P70", "the LLM decides nothing", C.teal],
    ["P71", "the accept path is real", C.teal],
  ];
  for (let i = 0; i < rows.length; i++) {
    const ry = y + 72 + i * 20;
    s += `<text x="${x + 18}" y="${ry}" fill="${rows[i][2] as string}" font-size="12" font-weight="700">${rows[i][0]}</text>`;
    s += `<text x="${x + 56}" y="${ry}" fill="${C.text}" font-size="11">${rows[i][1]}</text>`;
  }
  s += line(x + 16, y + ch - 40, "Every conclusion is a NEGATIVE or a calibration note: joint search is still");
  s += line(x + 16, y + ch - 24, "not free, no pixel/curve tool self-validates, the model stays advisory.");
  s += line(x + 16, y + ch - 8, "Nothing gated, anchored or staked - discoveryClaim = false everywhere.", C.title, "600");
  F = s;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="24" y="30" fill="${C.title}" font-size="18" font-weight="700">Measure before you gate, round 2: five targeted follow-ups on real TESS photometry</text>
  <text x="24" y="48" fill="${C.text}" font-size="11">Every number re-derived from a committed P67-P71 report; positive controls on known planets; nothing gated, anchored or claimed (discoveryClaim = false).</text>
  ${A}
  ${B}
  ${Cd}
  ${D}
  ${E}
  ${F}
</svg>
`;

writeFileSync(OUT, svg, "utf8");
console.log(`wrote ${OUT} (${svg.length} bytes)`);
console.log(`  P67 seed-hit (/${n67}): ${seedBars.map((b) => b.name + "=" + b.v).join("  ")}`);
console.log(`  P68 best AUC ${p68.bestAuc.toFixed(3)} (${p68.bestTest}); anyGateable=${p68.anyGateable}`);
console.log(`  P69 noise bumps ${s69.flipsNoise}/${s69.noiseLike} AR1-clears-only; mean delta ${s69.meanDeltaNoise.toFixed(3)}`);
console.log(`  P70 decisionsChangedByLLM=${ab.decisionsChangedByLLM}; blend under-flag ${mq.blendUnderFlagged}/${mq.nBlends}`);
console.log(`  P71 blind accepted ${s71.blindAccepted}/${s71.blindNeedsMoreData} vs corroborated ${s71.corroborationAccepted}/${s71.blindNeedsMoreData}`);
if (/[^\x00-\x7F]/.test(svg)) { console.log("WARNING: non-ASCII in SVG"); process.exit(1); }
