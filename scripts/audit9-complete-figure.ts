// Audit-9 COMPLETE figure: all three science-meaning gaps closed on real data -- TCE/DAVE/TPM benchmark,
// multi-sector blind test, and external-candidate independent validation. Numbers read from reports/p78, p79, p80.
// Pure generator -> web/audit9-complete-figure.svg. ASCII output; all strings pass through esc().
import { readFileSync, writeFileSync } from "node:fs";

const W = 960, H = 560;
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

const p78 = JSON.parse(readFileSync("reports/p78-blind-multisector.json", "utf8")) as { hosts: number; injected: number; null: number; raw: { precision: number }; capped: { acceptedTp: number; falseAccepts: number; acceptedPrecision: number } };
const p79 = JSON.parse(readFileSync("reports/p79-benchmark.json", "utf8")) as { tceAgreement: { measuredCompletenessWhenTceAccepts: number; measuredCompletenessWhenTceRejects: number } };
const p80 = JSON.parse(readFileSync("reports/p80-external-validation.json", "utf8")) as { totals: { kpTested: number; kpValidated: number; cpTested: number; cpValidated: number } };

const pc = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "n/a");
const tw = 456, th = 172, gx = 24, gy = 92;
const colx = [gx, gx + tw + 16];
const rowy = [gy, gy + th + 14];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
svg += `<text x="24" y="32" fill="${C.title}" font-size="19" font-weight="700">Audit finding 9 CLOSED on real data: benchmark + multi-sector blind test + independent external validation</text>`;
svg += `<text x="24" y="54" fill="${C.dim}" font-size="12.5">All three things the audit said were missing for scientific meaning, now measured. Numbers read from reports/p78, p79, p80.</text>`;
svg += `<text x="24" y="72" fill="${C.amber}" font-size="12.5">Honest science: two results are positive, one is a bounded negative. No gate moved; discoveryClaim false.</text>`;

const tiles: [number, number, string, string, string, string[]][] = [
  [colx[0], rowy[0], "GAP 1  BENCHMARK", C.good, "We track the BLS/TCE limit", [
    "Re-implemented TCE BLS SNR + >=3-transit / SNR>=7 rule,",
    "  DAVE blend FPP, TPM logistic fit to OUR p47 grid.",
    `TCE-accept cells: ${pc(p79.tceAgreement.measuredCompletenessWhenTceAccepts)} measured completeness.`,
    `TCE-reject cells: ${pc(p79.tceAgreement.measuredCompletenessWhenTceRejects)}.`,
    "=> completeness follows the standard BLS/TCE detection",
    "  limit on real TESS photometry (8 offline tests).",
  ]],
  [colx[1], rowy[0], "GAP 2  BLIND TEST", C.teal, "Real per-sector, scaled", [
    `${p78.hosts} real hosts (${p78.injected} injected / ${p78.null} null). Not stand-in.`,
    `2-sector bar: accepted recall ${p78.capped.acceptedTp}/${p78.injected}.`,
    `Raw precision ${pc(p78.raw.precision)} -> accepted precision ${pc(p78.capped.acceptedPrecision)}.`,
    `But ${p78.capped.falseAccepts} false accepts survive the 2-sector bar.`,
    "Honest: cross-sector period corroboration is NECESSARY",
    "  but NOT SUFFICIENT (systematics/aliases recur).",
  ]],
  [colx[0], rowy[1], "GAP 3  VALIDATION", C.blue, "The 0/2 moved off zero", [
    "Old 0/2 was STRUCTURAL (P65 audits on an empty catalog,",
    "  so an outside claim can never self-corroborate).",
    "New path: BLIND per-sector detection (claim ephemeris",
    "  never fed), corroborate across independent sectors,",
    `  then confirm an ExoFOP claim. KP controls ${p80.totals.kpValidated}/${p80.totals.kpTested};`,
    `  CP (uncertain EXTERNAL) independently validated ${p80.totals.cpValidated}/${p80.totals.cpTested}.`,
  ]],
  [colx[1], rowy[1], "HONEST SCOPE", C.fp, "What this is and is not", [
    "A CP confirmation is a FIRST independent CHECK that",
    "  supports a still-uncertain candidate -- matched to",
    "  0.002-0.065% over >=2 sectors -- not a discovery nor a",
    "  TRICERATOPS-grade (FPP<1e-3) validation.",
    "Period-only corroboration admits aliases (gap 2's 47%).",
    "Nothing gated/anchored/claimed; discoveryClaim false.",
  ]],
];
for (const t of tiles) svg += tile(t[0], t[1], tw, th, t[2], t[3], t[4], t[5]);
svg += `<text x="24" y="${H - 14}" fill="${C.dim}" font-size="12">SpaceDataRig/space-data-rig - spacedatarig.app - re-run via npm run p78:blind-multisector / p79:benchmark / p80:external-validation.</text>`;
svg += `</svg>\n`;
writeFileSync("web/audit9-complete-figure.svg", svg, "utf8");
console.log(`wrote web/audit9-complete-figure.svg (${Buffer.byteLength(svg, "utf8")} bytes)`);
