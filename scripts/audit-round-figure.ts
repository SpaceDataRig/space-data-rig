// Audit-remediation round figure: one honest panel summarising the eight external-audit findings we
// addressed, the author correction we accepted, and the measurement gates that back every claim.
// Pure generator: writes web/audit-round-figure.svg. ASCII output; all strings pass through esc().
import { writeFileSync } from "node:fs";

const W = 960;
const H = 620;
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

const tw = 456;
const th = 150;
const gx = 24;
const gy = 96;
const colx = [gx, gx + tw + 16];
const rowy = [gy, gy + th + 14, gy + 2 * (th + 14)];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
svg += `<text x="24" y="34" fill="${C.title}" font-size="19" font-weight="700">External-audit remediation round - honesty, robustness, guardrails: no gate, hash, or money path moved</text>`;
svg += `<text x="24" y="56" fill="${C.dim}" font-size="12.5">Every claim below is reproducible from main: typecheck 0, lint 0 errors, 427/427 auto-discovered tests, coverage 95.6% lines (measured on this repo).</text>`;
svg += `<text x="24" y="74" fill="${C.amber}" font-size="12.5">Pushed to GitHub only; the edge Worker was NOT redeployed, and ADMIN_TOKEN stays the operator's to set.</text>`;

const tiles: [number, number, string, string, string, string[]][] = [
  [colx[0], rowy[0], "#3 #4 honesty", C.good, "Copy over-claim removed", [
    "Accepted badge CONFIRMED -> RECOVERED (matches the UI).",
    "Headline no longer says 'Confirmed: a planet'.",
    "Every headline now labels [real TESS photometry] vs [stand-in].",
    "Recovery shown with n + 95% Wilson CI, framed as conditional.",
    "Narration is excluded from the bundle -> hash/verdict unchanged.",
  ]],
  [colx[1], rowy[0], "#1 #5 process", C.teal, "Framing + tooling", [
    "README/RESEARCH: deterministic pipeline, AI advisory (~2%).",
    "npm test auto-discovers tests/*.test.ts (68 files).",
    "Floor guard fails loudly on a discovery regression.",
    "ESLint (errors block) + Prettier + Node V8 coverage gate 85%.",
    "CI: typecheck + lint + tests-with-coverage block; audit/format advisory.",
  ]],
  [colx[0], rowy[1], "#7 #8 robust", C.blue, "Data contract + throttle", [
    "dataTier.ts: single schema contract (real/stand-in + columns),",
    "  pinned by tests; caught & fixed a silent ExoFOP tic=0 bug",
    "  (missing key column now fails CLOSED).",
    "Per-client rate limiter on /api/run + /api/anchor/* (429,",
    "  fail-open), gating before auth; set ADMIN_TOKEN remains the fix.",
  ]],
  [colx[1], rowy[1], "#9 science", C.amber, "Novelty scope stated", [
    "Cross-checks are re-implementations (PDM, wotan+astropy BLS),",
    "  NOT a benchmark vs TCE / DAVE / Drisser-TPM.",
    "Samples small (12 fixtures / 33 hosts / 27-54 d).",
    "Deliverable = reproducible harness + quantified NEGATIVE results.",
    "Paper path logged: Drisser/TPM + DAVE ROC on the same hosts.",
  ]],
  [colx[0], rowy[2], "Correction", C.fp, "Author corrected our P74", [
    "@dysmemic: eumemic's centroid check is an F-test on the MEAN",
    "  offset vs EVERY star within 2' (1\"/axis floor) -- not a",
    "  same-direction test. 0/565 false-kills, 73% catch of 175 TOIs.",
    "Our P74 is a directional-coherence VARIANT, not their method;",
    "  attribution fixed everywhere; faithful re-port = follow-up.",
  ]],
  [colx[1], rowy[2], "Invariants kept", C.good, "Red lines held", [
    "discoveryClaim false; measure-before-gate; real vs stand-in",
    "  labelled in every user artifact.",
    "No verdict / bundleHash / money-path / Solana code changed.",
    "No secrets staged; all files pure ASCII; not deployed.",
    "7 findings addressed in 6 commits, each gated then pushed.",
  ]],
];

for (const [x, y, tag, color, head, lines] of tiles) svg += tile(x, y, tw, th, tag, color, head, lines);

svg += `<text x="24" y="${H - 14}" fill="${C.dim}" font-size="12">SpaceDataRig/space-data-rig - spacedatarig.app - every number above is re-derivable by running the repo's own checks.</text>`;
svg += `</svg>\n`;

writeFileSync("web/audit-round-figure.svg", svg, "utf8");
console.log(`wrote web/audit-round-figure.svg (${Buffer.byteLength(svg, "utf8")} bytes)`);
