// Deploy + dependency-merge + centroid-F-test-retest round figure.
// Pure generator: reads reports/p77-centroid-ctest.json for the measured numbers and writes
// web/deploy-retest-round-figure.svg. ASCII output; all strings pass through esc().
import { readFileSync, writeFileSync } from "node:fs";

const W = 960;
const H = 560;
const C = {
  bg: "#0b1020",
  fg: "#e6edf7",
  title: "#7dd3fc",
  teal: "#2dd4bf",
  amber: "#fbbf24",
  good: "#4ade80",
  fp: "#f87171",
  blue: "#60a5fa",
  dim: "#94a3b8",
  card: "#131a2e",
};

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function tile(x: number, y: number, w: number, h: number, tag: string, color: string, head: string, lines: string[]): string {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.card}" stroke="${color}" stroke-opacity="0.5"/>`;
  s += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${color}"/>`;
  s += `<text x="${x + 18}" y="${y + 28}" fill="${color}" font-size="15" font-weight="700" font-family="monospace">${esc(tag)}</text>`;
  s += `<text x="${x + 18}" y="${y + 50}" fill="${C.title}" font-size="15" font-weight="700">${esc(head)}</text>`;
  lines.forEach((ln, k) => {
    s += `<text x="${x + 18}" y="${y + 74 + k * 18}" fill="${C.fg}" font-size="12.5">${esc(ln)}</text>`;
  });
  return s;
}

interface P77 { counts: { testable: number; planetsTestable: number; blendsTestable: number }; planets: { rejectAtAlpha: number; rejectAt01: number; n: number }; blends: { catchAtAlpha: number; n: number } }
const p77 = JSON.parse(readFileSync("reports/p77-centroid-ctest.json", "utf8")) as P77;

const tw = 456;
const th = 168;
const gx = 24;
const gy = 92;
const colx = [gx, gx + tw + 16];
const rowy = [gy, gy + th + 14];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
svg += `<text x="24" y="32" fill="${C.title}" font-size="19" font-weight="700">Deployed to spacedatarig.app + CI deps merged + faithful centroid F-test re-ported and re-measured</text>`;
svg += `<text x="24" y="54" fill="${C.dim}" font-size="12.5">This round: shipped the audit fixes to production, took the two low-risk dependency bumps, and re-tested the borrowed centroid idea honestly.</text>`;
svg += `<text x="24" y="72" fill="${C.amber}" font-size="12.5">434/434 auto-discovered tests pass; CI passing; no verdict, bundle hash, or money path moved.</text>`;

const tiles: [number, number, string, string, string, string[]][] = [
  [colx[0], rowy[0], "DEPLOYED", C.good, "Audit fixes live on the edge", [
    "wrangler deploy -> version 05198118, custom domain live.",
    "Badge reads RECOVERED; headline drops 'Confirmed: a planet'.",
    "Every result line labels [real TESS photometry] vs [stand-in].",
    "Recovery stat now shows n + 95% Wilson CI, framed conditional.",
    "Per-client rate limiting on /api/run + /api/anchor/* (429).",
    "Verified live: /health 200, findings/state 200, assets 200.",
  ]],
  [colx[1], rowy[0], "DEPS MERGED", C.teal, "Two CI bumps, one held", [
    "actions/checkout v4 -> v7 (9 workflows) + setup-node v4 -> v7 (7).",
    "Merged as commit 41a5aab; Dependabot auto-closed PRs #1 and #2.",
    "Preserved the audit CI additions (lint / coverage / audit / format).",
    "Production-dependency PR #4 LEFT OPEN on purpose:",
    "  it touches the wallet/crypto path and waits for a human review.",
    "CI re-run on @v7: passing.",
  ]],
  [colx[0], rowy[1], "P77 RE-PORT", C.blue, "Faithful, not guessed", [
    "Built from eumemic validation/centroid_sectors.md after their",
    "  correction -- P74 had mislabelled it a same-direction test.",
    "Statistic: F = n(n-1)|mean-s|^2 / RSS, per-axis scatter floored",
    "  at 1\", drop offsets over 60\", needs 2+ sectors.",
    "df1=2 so p has a closed form: (1 + F/(n-1))^-(n-1).",
    "7 hand-checked offline tests; full suite 434/434.",
  ]],
  [colx[1], rowy[1], "MEASURED", p77.planets.rejectAtAlpha > 0 ? C.fp : C.amber, "On our data, honestly", [
    `28 bright targets; only ${p77.counts.testable} have 2+ usable sectors`,
    `  (our short-baseline limit).`,
    `Known-planet false-reject: ${p77.planets.rejectAtAlpha}/${p77.planets.n} at p<0.001`,
    `  (eumemic calibration: 0/565).`,
    `Blend catch: ${p77.blends.catchAtAlpha}/${p77.blends.n} (ours are on-target EBs).`,
    "Verdict: the statistic is right; our difference-image",
    "  localization is too coarse to re-validate or gate on it.",
  ]],
];

for (const [x, y, tag, color, head, lines] of tiles) svg += tile(x, y, tw, th, tag, color, head, lines);

svg += `<text x="24" y="${H - 14}" fill="${C.dim}" font-size="12">SpaceDataRig/space-data-rig - spacedatarig.app - every number re-derivable by running the repo's own checks.</text>`;
svg += `</svg>\n`;

writeFileSync("web/deploy-retest-round-figure.svg", svg, "utf8");
console.log(`wrote web/deploy-retest-round-figure.svg (${Buffer.byteLength(svg, "utf8")} bytes)`);
