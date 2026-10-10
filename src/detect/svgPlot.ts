// SVG plot generators (zero-dependency). anomaly-scout/reporter embed these in
// findings; the frontend renders them inline. SVG keeps everything crisp and
// dependency-free (no canvas/matplotlib needed).

export interface PlotOpts {
  width?: number;
  height?: number;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  color?: string;
  modelColor?: string;
  pad?: { l: number; r: number; t: number; b: number };
}

const DEFAULTS = {
  width: 640,
  height: 300,
  color: "#38bdf8",
  modelColor: "#f472b6",
  pad: { l: 54, r: 16, t: 30, b: 40 },
};

function scale(v: number, lo: number, hi: number, a: number, b: number): number {
  if (hi === lo) return (a + b) / 2;
  return a + ((v - lo) / (hi - lo)) * (b - a);
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

interface Series {
  points: { x: number; y: number }[];
  color?: string;
  asLine?: boolean;
  radius?: number;
}

/** Min-max bucket decimation: preserves extremes (transit dips) while cutting point count. */
function decimateMinMax(points: { x: number; y: number }[], maxPoints: number): { x: number; y: number }[] {
  const n = points.length;
  if (n <= maxPoints) return points;
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const per = n / buckets;
  const out: { x: number; y: number }[] = [];
  for (let b = 0; b < buckets; b++) {
    const i0 = Math.floor(b * per);
    const i1 = Math.min(n, Math.floor((b + 1) * per));
    if (i1 <= i0) continue;
    let mn = points[i0];
    let mx = points[i0];
    for (let i = i0; i < i1; i++) {
      if (points[i].y < mn.y) mn = points[i];
      if (points[i].y > mx.y) mx = points[i];
    }
    out.push(mn);
    if (mx !== mn) out.push(mx);
  }
  return out;
}

/** Stride decimation preserving order (for line series). */
function decimateStride(points: { x: number; y: number }[], maxPoints: number): { x: number; y: number }[] {
  const n = points.length;
  if (n <= maxPoints) return points;
  const step = n / maxPoints;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[n - 1]);
  return out;
}

/** Generic scatter/line plot -> SVG string. */
function plot(series: Series[], opts: PlotOpts = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const pad = { ...DEFAULTS.pad, ...(opts.pad ?? {}) };
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  if (!allX.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}"></svg>`;
  let xLo = Math.min(...allX);
  let xHi = Math.max(...allX);
  let yLo = Math.min(...allY);
  let yHi = Math.max(...allY);
  const yPadM = (yHi - yLo) * 0.08 || 0.001;
  yLo -= yPadM;
  yHi += yPadM;
  const xPadM = (xHi - xLo) * 0.02 || 0.5;
  xLo -= xPadM;
  xHi += xPadM;

  const X = (v: number) => scale(v, xLo, xHi, pad.l, o.width - pad.r);
  const Y = (v: number) => scale(v, yHi, yLo, pad.t, o.height - pad.b); // inverted

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.width} ${o.height}" width="100%" style="max-width:${o.width}px;font-family:ui-sans-serif,system-ui,sans-serif">`;
  svg += `<rect x="0" y="0" width="${o.width}" height="${o.height}" fill="#0b1220" rx="8"/>`;
  // grid + axes
  for (const tx of niceTicks(xLo, xHi, 6)) {
    const x = X(tx);
    svg += `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${o.height - pad.b}" stroke="#1e293b" stroke-width="1"/>`;
    svg += `<text x="${x.toFixed(1)}" y="${o.height - pad.b + 16}" fill="#64748b" font-size="10" text-anchor="middle">${tx}</text>`;
  }
  for (const ty of niceTicks(yLo, yHi, 5)) {
    const y = Y(ty);
    svg += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${o.width - pad.r}" y2="${y.toFixed(1)}" stroke="#1e293b" stroke-width="1"/>`;
    svg += `<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" fill="#64748b" font-size="10" text-anchor="end">${ty.toPrecision(4)}</text>`;
  }
  svg += `<line x1="${pad.l}" y1="${o.height - pad.b}" x2="${o.width - pad.r}" y2="${o.height - pad.b}" stroke="#334155"/>`;
  svg += `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${o.height - pad.b}" stroke="#334155"/>`;
  // data
  for (const raw of series) {
    const s = { ...raw, points: raw.asLine ? decimateStride(raw.points, 1500) : decimateMinMax(raw.points, 2500) };
    const col = s.color ?? o.color;
    if (s.asLine) {
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
      svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6"/>`;
    } else {
      const r = s.radius ?? 1.4;
      for (const p of s.points) {
        svg += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${r}" fill="${col}" fill-opacity="0.75"/>`;
      }
    }
  }
  if (o.title) svg += `<text x="${pad.l}" y="18" fill="#e2e8f0" font-size="12" font-weight="600">${escapeXml(o.title)}</text>`;
  if (o.xLabel) svg += `<text x="${(o.width + pad.l) / 2}" y="${o.height - 6}" fill="#94a3b8" font-size="10" text-anchor="middle">${escapeXml(o.xLabel)}</text>`;
  if (o.yLabel) svg += `<text x="14" y="${(o.height + pad.t) / 2}" fill="#94a3b8" font-size="10" text-anchor="middle" transform="rotate(-90 14,${(o.height + pad.t) / 2})">${escapeXml(o.yLabel)}</text>`;
  svg += `</svg>`;
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Folded light curve (phase vs normalized flux) with optional binned overlay. */
export function foldedPlotSVG(
  folded: { phase: number; flux: number }[],
  opts: PlotOpts & { binCount?: number } = {},
): string {
  const data = folded.map((p) => ({ x: p.phase, y: p.flux }));
  const series: Series[] = [{ points: data, color: "#38bdf8", radius: 1.2 }];
  // binned median overlay
  const nb = opts.binCount ?? 40;
  const bins: number[][] = Array.from({ length: nb }, () => []);
  for (const p of folded) {
    const idx = Math.min(nb - 1, Math.max(0, Math.floor(p.phase * nb)));
    bins[idx].push(p.flux);
  }
  const binned = bins
    .map((vals, i) => (vals.length ? { x: (i + 0.5) / nb, y: vals.reduce((a, b) => a + b, 0) / vals.length } : null))
    .filter((v): v is { x: number; y: number } => v != null);
  series.push({ points: binned, color: "#f472b6", asLine: true });
  return plot(series, { xLabel: "orbital phase", yLabel: "normalized flux", ...opts });
}

/** BLS periodogram (period vs power). */
export function periodogramSVG(grid: { period: number; power: number }[], opts: PlotOpts = {}): string {
  const pts = grid.map((g) => ({ x: g.period, y: g.power }));
  return plot([{ points: pts, color: "#a78bfa", asLine: true }], {
    xLabel: "trial period (days)",
    yLabel: "BLS power",
    ...opts,
  });
}

/** Time-series light curve with optional transit model overlay. */
export function timeSeriesPlotSVG(
  points: { time: number; flux: number }[],
  model: { time: number; flux: number }[] = [],
  opts: PlotOpts = {},
): string {
  const series: Series[] = [{ points: points.map((p) => ({ x: p.time, y: p.flux })), color: "#38bdf8", radius: 1.0 }];
  if (model.length) series.push({ points: model.map((p) => ({ x: p.time, y: p.flux })), color: "#f472b6", asLine: true });
  return plot(series, { xLabel: "time (BJD)", yLabel: "normalized flux", ...opts });
}
