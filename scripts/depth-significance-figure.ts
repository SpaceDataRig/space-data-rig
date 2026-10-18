// DEPTH vs SIGNIFICANCE figure (audit b1, second pass).
//
// WHAT IT SHOWS, MEASURED FROM THE PUBLIC ENDPOINT AT RUN TIME. Every published finding carries a depth and a
// signal-to-noise ratio, and `snr = depth/sigma*sqrt(nIn)` with the record's own `noiseSigmaFrac` and
// `nPointsInTransit`. So the quoted SNR implies a depth: `snr*sigma/sqrt(nIn)`. If that implied depth is not the
// published depth, the row's two headline numbers describe different transits. This panel plots exactly that pair
// for every record that publishes enough fields to check, and reports the count that fails.
//
// Pure I/O at the edge only (one GET), deterministic output for a given payload, ASCII-only text, no clock baked
// into the geometry. Writes web/depth-significance-figure.svg.
import { writeFileSync } from "node:fs";

const W = 980;
const H = 660;
const C = {
  bg: "#0b1020",
  fg: "#e6edf7",
  title: "#7dd3fc",
  good: "#4ade80",
  bad: "#f87171",
  amber: "#fbbf24",
  dim: "#94a3b8",
  card: "#131a2e",
  grid: "#243049",
};

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Rec {
  targetId: string;
  verdict: string;
  depthFrac: number;
  snr: number;
  sigma: number;
  nIn: number;
  implied: number;
  ratio: number;
  source: string;
}

async function load(url: string): Promise<Rec[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const j = (await res.json()) as { findings?: Array<Record<string, unknown>> };
  const out: Rec[] = [];
  for (const f of j.findings || []) {
    const c = (f.candidate || {}) as Record<string, unknown>;
    const n = (k: string): number => (typeof c[k] === "number" ? (c[k] as number) : NaN);
    const depthFrac = n("depthFrac");
    const snr = n("snr");
    const sigma = n("noiseSigmaFrac");
    const nIn = n("nPointsInTransit");
    if (![depthFrac, snr, sigma, nIn].every(Number.isFinite) || depthFrac <= 0 || snr <= 0 || sigma <= 0) continue;
    const implied = (snr * sigma) / Math.sqrt(Math.max(1, nIn));
    if (!(implied > 0)) continue;
    out.push({
      targetId: String(f.targetId || "?"),
      verdict: String(f.verdict || "?"),
      depthFrac,
      snr,
      sigma,
      nIn,
      implied,
      ratio: implied / depthFrac,
      source: String(c.depthSource || "unlabelled"),
    });
  }
  return out;
}

function panel(recs: Rec[], checkedTotal: number, failTol: number): string {
  const px = 96;
  const py = 132;
  const pw = W - 150;
  const ph = 330;
  const lo = Math.log10(20);
  const hi = Math.log10(20000);
  const X = (v: number) => px + ((Math.log10(Math.max(lo, Math.min(hi, v))) - lo) / (hi - lo)) * pw;
  const Y = (v: number) => py + ph - ((Math.log10(Math.max(lo, Math.min(hi, v))) - lo) / (hi - lo)) * ph;

  let s = `<rect x="${px - 12}" y="${py - 44}" width="${pw + 66}" height="${ph + 96}" rx="10" fill="${C.card}" stroke="${C.grid}"/>`;
  s += `<text x="${px}" y="${py - 18}" fill="${C.title}" font-size="16" font-weight="700">Every checkable record: published depth (x) against the depth its own SNR implies (y)</text>`;
  s += `<text x="${px}" y="${py - 2}" fill="${C.dim}" font-size="12">implied = snr * noiseSigmaFrac / sqrt(nPointsInTransit), all three taken from the same row. On the line means the two headline numbers agree.</text>`;

  // decade grid + the identity line + the 1.5x band the critic flags
  for (const d of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    s += `<line x1="${X(d)}" y1="${py}" x2="${X(d)}" y2="${py + ph}" stroke="${C.grid}" stroke-opacity="0.6"/>`;
    s += `<line x1="${px}" y1="${Y(d)}" x2="${px + pw}" y2="${Y(d)}" stroke="${C.grid}" stroke-opacity="0.6"/>`;
    s += `<text x="${X(d)}" y="${py + ph + 16}" fill="${C.dim}" font-size="10.5" text-anchor="middle">${d}</text>`;
    s += `<text x="${px - 16}" y="${Y(d) + 4}" fill="${C.dim}" font-size="10.5" text-anchor="end">${d}</text>`;
  }
  s += `<rect x="${X(20)}" y="${Y(20000)}" width="${X(20000) - X(20)}" height="${Y(20) - Y(20000)}" fill="none"/>`;
  s += `<line x1="${X(20)}" y1="${Y(20)}" x2="${X(20000)}" y2="${Y(20000)}" stroke="${C.dim}" stroke-dasharray="5 4"/>`;
  const bandLo = 1 / failTol;
  const bandHi = failTol;
  for (const f of [bandLo, bandHi]) {
    const x0 = Math.max(20, Math.min(20000, 20 * f));
    const x1 = Math.max(20, Math.min(20000, 20000 * f));
    const y0 = Math.max(20, Math.min(20000, 20 / f));
    const y1 = Math.max(20, Math.min(20000, 20000 / f));
    s += `<line x1="${X(x0)}" y1="${Y(y0)}" x2="${X(x1)}" y2="${Y(y1)}" stroke="${C.amber}" stroke-opacity="0.55" stroke-dasharray="3 3"/>`;
  }

  let fails = 0;
  for (const r of recs) {
    const bad = r.ratio > failTol || r.ratio < 1 / failTol;
    if (bad) fails++;
    const col = bad ? C.bad : C.good;
    s += `<circle cx="${X(r.depthFrac)}" cy="${Y(r.implied)}" r="${bad ? 5.6 : 4.2}" fill="${col}" fill-opacity="0.85"/>`;
  }
  s += `<text x="${px}" y="${py + ph + 40}" fill="${C.fg}" font-size="12.5">${esc(
    `x-axis: transit depth published in ppm (log). y-axis: depth implied by the row's own SNR (log). Points above the line quote a significance belonging to a DEEPER measurement.`,
  )}</text>`;
  s += `<text x="${px}" y="${py + ph + 58}" fill="${fails ? C.bad : C.good}" font-size="13" font-weight="700">${esc(
    `${fails} of ${recs.length} checkable records fall outside the ${failTol}x agreement band`,
  )} ${esc(`(records lacking a published scatter or a non-positive depth cannot be checked: ${checkedTotal - recs.length} of ${checkedTotal})`)}</text>`;
  return s;
}

function summary(recs: Rec[], sampled: string): string {
  const adopted = recs.filter((r) => r.source === "per-sector-median");
  const adoptFail = adopted.filter((r) => r.ratio > 1.5 || r.ratio < 1 / 1.5);
  const worst = [...recs].sort((a, b) => Math.abs(Math.log10(b.ratio)) - Math.abs(Math.log10(a.ratio)))[0];
  const tiles: Array<[string, string, string, number]> = [
    ["records checked", String(recs.length), C.title, 0],
    ["depths adopted from a shape fit", String(adopted.length), C.title, 1],
    ["adoptions still quoting the box SNR", String(adoptFail.length), adoptFail.length ? C.bad : C.good, 2],
    ["worst disagreement", worst ? `${worst.ratio.toFixed(2)}x on ${worst.targetId}` : "n/a", worst && (worst.ratio > 1.5 || worst.ratio < 1 / 1.5) ? C.bad : C.good, 3],
  ];
  let s = "";
  for (const [label, value, color, i] of tiles) {
    const x = 96 + (i % 4) * 200;
    const y = 528;
    s += `<rect x="${x}" y="${y}" width="188" height="68" rx="8" fill="${C.card}" stroke="${color}" stroke-opacity="0.55"/>`;
    s += `<rect x="${x}" y="${y}" width="5" height="68" rx="3" fill="${color}"/>`;
    s += `<text x="${x + 14}" y="${y + 22}" fill="${color}" font-size="17" font-weight="700">${esc(value.slice(0, 26))}</text>`;
    s += `<text x="${x + 14}" y="${y + 42}" fill="${C.dim}" font-size="11">${esc(label)}</text>`;
    s += `<text x="${x + 14}" y="${y + 57}" fill="${C.dim}" font-size="10.5">${esc(i === 3 ? "implied/published" : `sampled ${sampled}`)}</text>`;
  }
  return s;
}

async function main(): Promise<void> {
  const url = process.argv.find((a) => a.startsWith("--url="))?.slice(6) || "https://spacedatarig.app/api/findings";
  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6) || "web/depth-significance-figure.svg";
  const failTol = Number(process.argv.find((a) => a.startsWith("--tol="))?.slice(6) || "1.5");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const j = (await res.json()) as { findings?: Array<Record<string, unknown>> };
  const total = (j.findings || []).length;
  const recs = await load(url);
  const sampled = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, sans-serif">`;
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`;
  svg += `<text x="24" y="34" fill="${C.title}" font-size="19" font-weight="700">A published depth and a published SNR must describe the same transit</text>`;
  svg += `<text x="24" y="58" fill="${C.dim}" font-size="12.5">Source: ${esc(url)} sampled ${sampled} (${total} findings). Checkable = the row also publishes noiseSigmaFrac and a positive depth and SNR.</text>`;
  svg += `<text x="24" y="78" fill="${C.amber}" font-size="12.5">snr is not an independent measurement: it is depth/sigma*sqrt(nIn). Re-pricing a refined depth is required, or the row refutes itself.</text>`;
  svg += `<text x="24" y="98" fill="${C.dim}" font-size="12">Rows written before the guard published no scatter, so they cannot be checked here; they are disclosed as a count, not hidden.</text>`;
  svg += panel(recs, total, failTol);
  svg += summary(recs, sampled.slice(0, 16));
  svg += `<text x="24" y="${H - 18}" fill="${C.dim}" font-size="11.5">Generated by npm run figure:depth-significance. Every number on this panel is recomputed from the public endpoint on each run.</text>`;
  svg += `</svg>`;

  writeFileSync(out, svg, "utf8");
  console.log(`figure: wrote ${out} (${svg.length} bytes) from ${total} findings, ${recs.length} checkable, sampled ${sampled}`);
}

main().catch((e) => {
  console.error(`figure:depth-significance failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
