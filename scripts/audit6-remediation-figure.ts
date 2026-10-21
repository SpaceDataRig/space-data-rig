// Six-point-audit remediation poster -- REGENERATED, not hand-written (external audit R3).
//
// The previous copy of web/audit-remediation6-figure.svg had NO generator: it was typed-in literals that went stale
// INSIDE the same batch they shipped in -- "stamped 8 -> 12 of 54" (the library now carries far more), "p59/p90
// flagged STALE (red banner)" (the live library is stale:[] after the freshness-regen CI cleared them), "crossmatch
// tri-state ... still deferred" (shipped in ee7389d and extended with lookup-not-run in this pass), and a baked
// "deploy f31b87a" (a deployment revision that any later deploy supersedes). A figure-no-retracted gate only blocks
// already-known withdrawn tokens; it cannot catch a number that merely ages. So every volatile figure here is READ
// from committed bytes, and the deploy revision is referred to by the endpoint that always reflects it (/health.gitSha)
// rather than a frozen SHA.
//
// Usage: npm run figure:audit6   (writes web/audit-remediation6-figure.svg)
import { readFileSync, writeFileSync } from "node:fs";

const lib = JSON.parse(readFileSync("web/reports/index.json", "utf8")) as {
  freshness: { stamped: number; verified: number; fullyVerified: number; total: number; stale: string[] };
};
const fr = lib.freshness;
const staleCount = (fr.stale ?? []).length;

const p84 = JSON.parse(readFileSync("reports/p84-centroid-diagnosis.json", "utf8")) as {
  blends: { caught: number; testable: number; coverageLossFrac: number };
};
const blendCaught = `${p84.blends.caught}/${p84.blends.testable}`;
const coverLossPct = Math.round(p84.blends.coverageLossFrac * 100);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 675;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#0e1428" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/><rect x="0" y="0" width="${W}" height="6" fill="#5aa9ff"/>`;
const head =
  T(40, 58, "SIX-POINT EXTERNAL AUDIT -- CLOSED AND DEPLOYED", 29, "#e8ecf7", "800") +
  T(40, 86, "spacedatarig.app -- a deterministic TESS transit research rig. Research only; every number here is re-derived from a committed report, not typed in.", 13.5, "#9fb0d6");

// Left: what this pass closed (green).
let left = card(40, 112, 540, 470) + T(64, 144, "CLOSED THIS PASS", 20, "#37d39b", "800");
const closed: [string, string][] = [
  ["#1  a withdrawn coverage-loss figure purged", `both posters re-derived from P84 (now ${coverLossPct}% never-localise); no stale % remains`],
  [`#3  freshness gate now covers ${fr.stamped}/${fr.total} stamped, ${fr.verified}/${fr.total} machine-verified`, `report-driven counts, read live from the served library index`],
  [`#3  stale red banners cleared: ${staleCount} stale now`, `freshness-regen CI re-runs the network-bound reports where ExoFOP/Gaia/MAST answer`],
  ["#4  README on-chain claim bounded AND made true", "a keyless /api/bundles/:id/verify-onchain read-back now decodes the sealed memo, and each card exposes it"],
  ["#5  degenerate fits no longer 'physically-consistent'", "harmonics widened (x4, x1/4); tri-state crossmatch shipped, with a distinct 'lookup-not-run' state"],
  ["#6  candidate countdown projected live", "the stale baked day-count is no longer read; P75 depth/FAP figures frozen so a cited number stops moving"],
];
let yy = 176;
for (const [a, b] of closed) {
  left += T(64, yy, a, 13.5, "#e8ecf7", "700");
  left += T(80, yy + 20, b, 12.5, "#9fb0d6");
  yy += 54;
}

// Right: standing limits (amber) -- the ceilings we state rather than hide.
let right = card(620, 112, 540, 470) + T(644, 144, "STANDING LIMITS (stated, not hidden)", 20, "#f5b544", "800");
const limits: string[] = [
  "#5  SNR optima (P92 vs P95) disagree and are both under-powered; the deployed detection floor stays 7.",
  `#5  centroid blend catch ${blendCaught}: pixel-baseline-bound, not a threshold problem (P84 / P85).`,
  "accepted-call precision is a measured ceiling on the sampled curves (P82); the coherent-systematics wall stands.",
  "P76 ExoFOP novelty leg is a point-in-time snapshot -- the multi-MB anonymous pull is throttled, treated as stamped not continuously re-verified.",
  "The on-chain read-back reports bundle drift honestly for a re-derived historical bundle and distinguishes it from a science-address change.",
];
let ly = 182;
for (const line of limits) {
  right += T(644, ly, line, 13, "#9fb0d6");
  ly += 46;
}
right += T(644, 470, "Nothing here widens a gate or supports a discovery claim.", 13, "#6d7fa3");
right += T(644, 496, "safeToGate false   discoveryClaim false", 14, "#9fb0d6", "700");

const footer =
  card(40, 600, 1120, 46) +
  T(60, 628, `${fr.verified}/${fr.total} machine-verified   |   ${fr.stamped}/${fr.total} stamped   |   ${staleCount} stale   |   deployed revision is whatever /health.gitSha reports`, 14, "#37d39b") +
  T(870, 628, "counts read from web/reports/index.json", 12, "#6d7fa3");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI',Helvetica,Arial,sans-serif">\n` +
  `  ${bg}\n  ${head}\n  ${left}\n  ${right}\n  ${footer}\n</svg>\n`;
writeFileSync("web/audit-remediation6-figure.svg", svg);

const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/audit-remediation6-figure.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii} (from index freshness stamped=${fr.stamped} verified=${fr.verified} total=${fr.total} stale=${staleCount}; p84 blend=${blendCaught})`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
