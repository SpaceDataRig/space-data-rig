// P82 scale-up figure: "what we're doing right now" -- growing the audit-9 validation sample ~100x on real
// data via one resumable, concurrent, byte-cached harness. Progress counts are read LIVE from the JSONL
// checkpoints (out/scaled/*.jsonl, non-empty lines); the small-sample baselines are the previously published
// P77/P78/P80 numbers. ASCII output; every text node passes through esc(). -> web/p82-scaleup-figure.svg
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const W = 960, H = 560;
const C = { bg: "#0b1020", fg: "#e6edf7", title: "#7dd3fc", teal: "#2dd4bf", amber: "#fbbf24", good: "#4ade80", fp: "#f87171", blue: "#60a5fa", dim: "#94a3b8", card: "#131a2e" };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function countLines(f: string): number {
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length).length;
}
const blind = countLines("out/scaled/blind.jsonl");
const external = countLines("out/scaled/external.jsonl");
const centroid = countLines("out/scaled/centroid.jsonl");

function tile(x: number, y: number, w: number, h: number, tag: string, color: string, head: string, lines: string[]): string {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.card}" stroke="${color}" stroke-opacity="0.5"/>`;
  s += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${color}"/>`;
  s += `<text x="${x + 18}" y="${y + 28}" fill="${color}" font-size="15" font-weight="700" font-family="monospace">${esc(tag)}</text>`;
  s += `<text x="${x + 18}" y="${y + 50}" fill="${C.title}" font-size="15" font-weight="700">${esc(head)}</text>`;
  lines.forEach((ln, k) => { s += `<text x="${x + 18}" y="${y + 74 + k * 18}" fill="${C.fg}" font-size="12.5">${esc(ln)}</text>`; });
  return s;
}

const tw = 456, th = 172, gx = 24;
const colx = [gx, gx + tw + 16];
const rowy = [92, 92 + th + 14];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
svg += `<text x="24" y="32" fill="${C.title}" font-size="19" font-weight="700">Scaling the validation sample ~100x on real TESS data</text>`;
svg += `<text x="24" y="54" fill="${C.dim}" font-size="12.5">From a couple dozen hand-picked targets to hundreds per run, via one resumable, concurrent, byte-cached harness.</text>`;
svg += `<text x="24" y="72" fill="${C.amber}" font-size="12.5">Progress counts read live from the run checkpoints. Research only; discoveryClaim false.</text>`;

const tiles: [number, number, string, string, string, string[]][] = [
  [colx[0], rowy[0], "THE THREE PROBES", C.teal, "bigger, on real public data", [
    `Blind test (inject + recover, sector-by-sector): ${blind} hosts`,
    `External independent validation (ExoFOP claims): ${external} hosts`,
    `Centroid per-contaminant F-test (pixel cubes): ${centroid} (running)`,
    "Same statistics as the ~20-target P77/P78/P80/P81 probes,",
    "  just hundreds more stars behind every rate.",
  ]],
  [colx[1], rowy[0], "HOW IT FITS", C.blue, "one harness, resumable", [
    "Shared pool: 8,151 ExoFOP TOI rows -> unique bright hosts.",
    "Concurrent + byte-cached multi-sector SPOC fetcher.",
    "Gaia TAP throttled (anonymous endpoint rate limit).",
    "Append-only JSONL checkpoints: a long run survives",
    "  interruption and resumes where it stopped.",
  ]],
  [colx[0], rowy[1], "SCALE, HONESTLY", C.good, "compute was never the wall", [
    "Detection is embarrassingly parallel; a single machine",
    "  chews through hundreds of stars per run.",
    "Bigger N tightens Wilson error bars and grows the count",
    "  of independently validated external candidates.",
    "It does NOT manufacture a discovery.",
  ]],
  [colx[1], rowy[1], "THE REAL BOTTLENECK", C.fp, "data power + science quality", [
    "Short baseline (one 27-day sector is coarse in period).",
    "Seed wall: a blind single-sector period is often wrong.",
    "Coherent instrumental systematics dominate false positives",
    "  (P78: 2-sector corroboration only ~47% precise).",
    "Scaling sample sharpens the picture; it does not remove",
    "  these limits -- that needs better data + discriminants.",
  ]],
];
for (const t of tiles) svg += tile(t[0], t[1], tw, th, t[2], t[3], t[4], t[5]);
svg += `<text x="24" y="${H - 14}" fill="${C.dim}" font-size="12">SpaceDataRig/space-data-rig - spacedatarig.app - reproduce: npm run p82:scaled -- --probe all --limit 500 (resumable).</text>`;
svg += `</svg>\n`;
writeFileSync("web/p82-scaleup-figure.svg", svg, "utf8");
console.log(`wrote web/p82-scaleup-figure.svg (${Buffer.byteLength(svg, "utf8")} bytes) blind=${blind} external=${external} centroid=${centroid}`);
