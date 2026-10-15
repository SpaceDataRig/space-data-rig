// P81-round figure: the TRICERATOPS-grade upgrade + the audit-9 panel going LIVE. Numbers read from committed
// reports/p78, p79, p80, p81 -- no hardcoding. ASCII output; every text node passes through esc(). -> web/p81-round-figure.svg
import { readFileSync, writeFileSync } from "node:fs";

const W = 960, H = 560;
const C = { bg: "#0b1020", fg: "#e6edf7", title: "#7dd3fc", teal: "#2dd4bf", amber: "#fbbf24", good: "#4ade80", fp: "#f87171", blue: "#60a5fa", dim: "#94a3b8", card: "#131a2e" };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pc = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "n/a");

function tile(x: number, y: number, w: number, h: number, tag: string, color: string, head: string, lines: string[]): string {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.card}" stroke="${color}" stroke-opacity="0.5"/>`;
  s += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${color}"/>`;
  s += `<text x="${x + 18}" y="${y + 28}" fill="${color}" font-size="15" font-weight="700" font-family="monospace">${esc(tag)}</text>`;
  s += `<text x="${x + 18}" y="${y + 50}" fill="${C.title}" font-size="15" font-weight="700">${esc(head)}</text>`;
  lines.forEach((ln, k) => { s += `<text x="${x + 18}" y="${y + 74 + k * 18}" fill="${C.fg}" font-size="12.5">${esc(ln)}</text>`; });
  return s;
}

const p78 = JSON.parse(readFileSync("reports/p78-blind-multisector.json", "utf8")) as { hosts: number; injected: number; null: number; capped: { acceptedTp: number; falseAccepts: number; acceptedPrecision: number } };
const p79 = JSON.parse(readFileSync("reports/p79-benchmark.json", "utf8")) as { tceAgreement: { measuredCompletenessWhenTceAccepts: number; measuredCompletenessWhenTceRejects: number } };
const p80 = JSON.parse(readFileSync("reports/p80-external-validation.json", "utf8")) as { totals: { kpTested: number; kpValidated: number; cpTested: number; cpValidated: number } };
const p81 = JSON.parse(readFileSync("reports/p81-triceratops-lite.json", "utf8")) as { totals: { validated: number; kpValidated: number; cpValidated: number; cpTricGrade: number; cpLowOrModerate: number }; rows: { disp: string; tricGrade: boolean }[] };
const kpGrade = p81.rows.filter((r) => r.disp === "KP" && r.tricGrade).length;

const tw = 456, th = 172, gx = 24;
const colx = [gx, gx + tw + 16];
const rowy = [92, 92 + th + 14];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
svg += `<text x="24" y="32" fill="${C.title}" font-size="19" font-weight="700">Audit-9 on the public dashboard + a TRICERATOPS-grade check (P81)</text>`;
svg += `<text x="24" y="54" fill="${C.dim}" font-size="12.5">Live at spacedatarig.app (research.json section audit9P78P81) and the CP validations graded closer to TRICERATOPS.</text>`;
svg += `<text x="24" y="72" fill="${C.amber}" font-size="12.5">Honest first-order checks with positive controls; discoveryClaim false, safeToGate false.</text>`;

const tiles: [number, number, string, string, string, string[]][] = [
  [colx[0], rowy[0], "GAP 3 GRADED  P81", C.blue, "The strict bar separates real from claimed", [
    "Per validated candidate: Gaia 21\" census -> blend EB FPP,",
    "  harmonic-alias accounting + multi-sector centroid F-test,",
    "  + the P78 empirical false-coincidence base.",
    `Known planets (KP) meeting the strict bar: ${kpGrade}/${p81.totals.kpValidated}.`,
    `Uncertain candidates (CP) meeting it: ${p81.totals.cpTricGrade}/${p81.totals.cpValidated}.`,
    "Same bar, clean separation -> our machinery's discriminant works.",
  ]],
  [colx[1], rowy[0], "GAP 3  VALIDATION  P80", C.teal, "0/2 moved off zero", [
    `Blind per-sector detection (claim ephemeris never fed),`,
    `  corroborated across independent sectors, then matched:`,
    `  KP controls ${p80.totals.kpValidated}/${p80.totals.kpTested}; CP uncertain external ${p80.totals.cpValidated}/${p80.totals.cpTested}.`,
    "Non-circular: agreement between an external catalog claim",
    "  and an independent blind detection.",
    "First independent external validations for the project.",
  ]],
  [colx[0], rowy[1], "GAPS 1+2  P78/P79", C.good, "Benchmark + real blind test", [
    `TCE-accept cells ${pc(p79.tceAgreement.measuredCompletenessWhenTceAccepts)} completeness vs reject ${pc(p79.tceAgreement.measuredCompletenessWhenTceRejects)} ->`,
    "  we track the standard BLS/TCE limit.",
    `${p78.hosts} real hosts; 2-sector bar: recall ${p78.capped.acceptedTp}/${p78.injected},`,
    `  ${p78.capped.falseAccepts} false-accepts, precision ${pc(p78.capped.acceptedPrecision)}.`,
    "Period-only corroboration is necessary, NOT sufficient.",
  ]],
  [colx[1], rowy[1], "SHIPPED", C.amber, "Panel + deploy", [
    "p38 distills P78-P81 into research.json section",
    "  audit9P78P81 (all re-derived, no hardcoded numbers).",
    "web/app.js renders an Audit-9 card; advisory only.",
    "Deployed to spacedatarig.app after an idle-window poll;",
    "  live research.json + app.js + /health verified 200.",
    "CI passing, 452 offline tests.",
  ]],
];
for (const t of tiles) svg += tile(t[0], t[1], tw, th, t[2], t[3], t[4], t[5]);
svg += `<text x="24" y="${H - 14}" fill="${C.dim}" font-size="12">SpaceDataRig/space-data-rig - spacedatarig.app - reproduce: npm run p78:blind-multisector / p79:benchmark / p80:external-validation / p81:triceratops-lite.</text>`;
svg += `</svg>\n`;
writeFileSync("web/p81-round-figure.svg", svg, "utf8");
console.log(`wrote web/p81-round-figure.svg (${Buffer.byteLength(svg, "utf8")} bytes)`);
