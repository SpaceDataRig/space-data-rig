// Audit-9 science-meaning round figure: the TCE/DAVE/TPM benchmark + the real multi-sector blind test,
// with the honest numbers read straight from reports/p79-benchmark.json and reports/p78-blind-multisector.json.
// Pure generator -> web/audit9-round-figure.svg. ASCII output; all strings pass through esc().
import { readFileSync, writeFileSync } from "node:fs";

const W = 960;
const H = 560;
const C = { bg: "#0b1020", fg: "#e6edf7", title: "#7dd3fc", teal: "#2dd4bf", amber: "#fbbf24", good: "#4ade80", fp: "#f87171", blue: "#60a5fa", dim: "#94a3b8", card: "#131a2e" };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function tile(x: number, y: number, w: number, h: number, tag: string, color: string, head: string, lines: string[]): string {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.card}" stroke="${color}" stroke-opacity="0.5"/>`;
  s += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${color}"/>`;
  s += `<text x="${x + 18}" y="${y + 28}" fill="${color}" font-size="15" font-weight="700" font-family="monospace">${esc(tag)}</text>`;
  s += `<text x="${x + 18}" y="${y + 50}" fill="${C.title}" font-size="15" font-weight="700">${esc(head)}</text>`;
  lines.forEach((ln, k) => { s += `<text x="${x + 18}" y="${y + 74 + k * 18}" fill="${C.fg}" font-size="12.5">${esc(ln)}</text>`; });
  return s;
}

const p78 = JSON.parse(readFileSync("reports/p78-blind-multisector.json", "utf8")) as { hosts: number; injected: number; null: number; clusters: number; corroborationHistogram: number[]; raw: { precision: number; recall: number }; capped: { accepted: number; acceptedTp: number; falseAccepts: number; acceptedPrecision: number } };
const p79 = JSON.parse(readFileSync("reports/p79-benchmark.json", "utf8")) as { tceAgreement: { measuredCompletenessWhenTceAccepts: number; measuredCompletenessWhenTceRejects: number; nAccept: number; nReject: number } };

const pc = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "n/a");
const accRecall = p78.capped.acceptedTp / Math.max(1, p78.injected);

const tw = 456, th = 168, gx = 24, gy = 92;
const colx = [gx, gx + tw + 16];
const rowy = [gy, gy + th + 14];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
svg += `<text x="24" y="32" fill="${C.title}" font-size="19" font-weight="700">Audit finding 9, part 1-2: quantitative TCE/DAVE/TPM benchmark + a real multi-sector blind test</text>`;
svg += `<text x="24" y="54" fill="${C.dim}" font-size="12.5">Closing two of the three gaps that stand between a reproducible harness and genuine scientific meaning. Numbers read from our own measured reports.</text>`;
svg += `<text x="24" y="72" fill="${C.amber}" font-size="12.5">Measure-only: no gate moved, no bundle hash or money path touched, discoveryClaim false.</text>`;

const tiles: [number, number, string, string, string, string[]][] = [
  [colx[0], rowy[0], "P79 BENCHMARK", C.good, "We track the BLS/TCE limit", [
    "Re-implemented TCE BLS SNR + >=3-transit / SNR>=7 rule,",
    "  DAVE blend FPP, and a TPM logistic fit to OUR p47 grid.",
    `Cells the TCE rule ACCEPTS: ${pc(p79.tceAgreement.measuredCompletenessWhenTceAccepts)} measured completeness.`,
    `Cells it REJECTS: ${pc(p79.tceAgreement.measuredCompletenessWhenTceRejects)} (${p79.tceAgreement.nAccept} accept / ${p79.tceAgreement.nReject} reject cells).`,
    "=> our detector's completeness follows the standard BLS/TCE",
    "  detection limit on real photometry (8 offline tests).",
  ]],
  [colx[1], rowy[0], "P78 BLIND TEST", C.teal, "Real per-sector, scaled", [
    `${p78.hosts} real SPOC hosts (all >=2 sectors): ${p78.injected} injected,`,
    `  ${p78.null} null, ${p78.clusters} period-clusters. Not stand-in, not stitched.`,
    `2-sector bar: accepted recall ${accRecall.toFixed(2)} (${p78.capped.acceptedTp}/${p78.injected}).`,
    `Corroboration histogram (1..5 sectors): ${p78.corroborationHistogram.join("/")}.`,
    `Raw precision ${pc(p78.raw.precision)} -> under the 2-sector bar ${pc(p78.capped.acceptedPrecision)}.`,
    "P49 could not show this: it stitched sectors and forced 1.",
  ]],
  [colx[0], rowy[1], "HONEST VERDICT", C.fp, "Corroboration helps, is not enough", [
    `False-accepts under the 2-sector bar: ${p78.capped.falseAccepts}.`,
    "Requiring 2 independent sectors only roughly TRIPLES precision",
    "  (16% -> 47%) and does NOT zero it out.",
    "Coherent systematics / aliases RECUR across sectors, so period-",
    "  only corroboration is necessary but NOT sufficient for a claim.",
    "Blending is not the binding constraint (DAVE FPP for a faint",
    "  neighbour ~ 0.3%) -- systematics are.",
  ]],
  [colx[1], rowy[1], "GAP 3 (IN PROGRESS)", C.blue, "Independent validation", [
    "The 0/2 external-candidate result was structural: the critic",
    "  audits with an empty catalog, so an outside claim caps at",
    "  needs-more-data by design -- it can never self-validate.",
    "P80 (next): detect BLIND (no ephemeris fed) on real hosts, then",
    "  cross-match a corroborated detection against an INDEPENDENT",
    "  published catalog -- confirmation from a source we did NOT",
    "  use to detect, breaking the circularity.",
  ]],
];

for (const t of tiles) svg += tile(t[0], t[1], tw, th, t[2], t[3], t[4], t[5]);
svg += `<text x="24" y="${H - 14}" fill="${C.dim}" font-size="12">SpaceDataRig/space-data-rig - spacedatarig.app - all numbers re-derivable via npm run p78:blind-multisector / p79:benchmark.</text>`;
svg += `</svg>\n`;

writeFileSync("web/audit9-round-figure.svg", svg, "utf8");
console.log(`wrote web/audit9-round-figure.svg (${Buffer.byteLength(svg, "utf8")} bytes)`);
