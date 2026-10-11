// P10 FIGURE GENERATOR: render ONE real, confirmed-planet transit -- folded TESS photometry plus the
// exact limb-darkened model we fit -- into a self-contained static SVG for the dashboard. This is a
// presentation artifact (a picture of real public data + our physical fit), NOT a live/bundled product:
// nothing in the analysis core or the reproducible bundle reads it, so bundle hashes are unchanged.
//
// It exists to make the method tangible for a non-specialist: the dots are the actual downlinked
// brightness measurements, folded on the planet's orbit; the smooth line is the exact occultation model
// fit to them. A viewer can SEE that we are not drawing a box -- we are fitting the real physical shape.
//
// Chain: confirmed planet (by name, default "HR 858 b") --(TESScut)--> sector --(SPOC _lc.fits)--> real
//        PDCSAP flux --(fold at the catalog period/epoch)--> phase curve --(fitExactTransit)--> model.
// Needs network at AUTHORING time only; the generated SVG is then a checked-in static asset. Not in CI.
//
// Usage:
//   npm run p10:figure
//   npm run p10:figure -- --name "TOI-5789 c"
import { writeFile } from "node:fs/promises";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";
import { exactTransitFlux, separationCircular } from "../src/sim/exactTransit.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function argStr(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}

// "" = auto-pick the deepest short-period planet that has a clean SPOC curve + a successful fit;
// or pass --name "WASP-121 b" to force a specific confirmed planet.
const NAME = argStr("name", "");
const OUT = "web/transit-example.svg";

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  console.log(NAME ? `P10 figure generator: forced target "${NAME}"` : `P10 figure generator: auto-picking the cleanest deep short-period transit`);
  const cat = await fetchConfirmedPlanets({ maxTmag: 11, requireTic: true, limit: 400 });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} (live TAP unavailable).`);
  const hasFields = (q: ArchivePlanet) =>
    Number.isFinite(q.tic!) && Number.isFinite(q.ra) && Number.isFinite(q.dec) &&
    Number.isFinite(q.pl_orbper!) && q.pl_orbper! > 0 && Number.isFinite(q.pl_tranmid!) &&
    Number.isFinite(q.pl_trandep!) && q.pl_trandep! > 0 && Number.isFinite(q.st_rad!) && q.st_rad! > 0;
  let list = cat.planets.filter(hasFields);
  if (NAME) {
    list = list.filter((q) => (q.pl_name ?? "").toLowerCase() === NAME.toLowerCase());
  } else {
    // a goldilocks band for a LEGIBLE textbook transit: deep enough to see, not so deep it is a grazing
    // or phase-curve oddity, and short enough to fold many transits. Brightest first (best SNR).
    list = list.filter((q) => (q.pl_trandep ?? 0) >= 3000 && (q.pl_trandep ?? 0) <= 12000 && q.pl_orbper! >= 1.5 && q.pl_orbper! <= 6);
    list = [...list].sort((a, b) => (a.sy_tmag ?? 99) - (b.sy_tmag ?? 99));
  }
  if (!list.length) throw new Error(NAME ? `planet "${NAME}" not found/measurable in the fetched catalog` : "no measurable goldilocks-band planets");

  // try candidates (brightest first) until one has a downloadable SPOC curve AND a clean exact fit
  let sel: null | { p: ArchivePlanet; period: number; aOverRs: number; folded: ReturnType<typeof foldAtPhase>; fit: ReturnType<typeof fitExactTransit> } = null;
  for (const cand of list.slice(0, 15)) {
    try {
      const sectors = await sectorsForCoord(cand.ra!, cand.dec!);
      let lc = null as null | Awaited<ReturnType<typeof fetchSpocLightCurve>>;
      for (const s of sectors.slice(0, 3)) {
        lc = await fetchSpocLightCurve(cand.tic!, [s], cand.pl_name ?? cand.hostname ?? `TIC ${cand.tic}`);
        if (lc) break;
      }
      if (!lc) continue;
      const clean = preprocess(lc, 0.5);
      const times = clean.points.map((pt) => pt.time);
      const flux = clean.points.map((pt) => pt.flux);
      const mass = Number.isFinite(cand.st_mass!) ? cand.st_mass! : mainSequenceMassFromRadius(cand.st_rad!);
      const aOverRs = aOverRsFromKepler(cand.pl_orbper!, mass, cand.st_rad!);
      if (!Number.isFinite(aOverRs) || aOverRs <= 1) continue;
      const folded = foldAtPhase(times, flux, cand.pl_orbper!, cand.pl_tranmid!);
      const fit = fitExactTransit(folded, { aOverRs, t0Window: 0.02 });
      // accept a clean, well-sampled, non-grazing transit; keep trying if this one is pathological
      if (!Number.isFinite(fit.depthFrac) || fit.nInWindow < 20 || fit.impactParam > 0.9) continue;
      console.log(`selected ${(cand.pl_name ?? "").trim()} (Tmag ${cand.sy_tmag}, P=${cand.pl_orbper!.toFixed(4)}d, npts=${clean.points.length})`);
      sel = { p: cand, period: cand.pl_orbper!, aOverRs, folded, fit };
      break;
    } catch { /* try next candidate */ }
  }
  if (!sel) throw new Error("could not fetch+fit any illustrative target from the candidate list");
  const { p, period, aOverRs, folded, fit } = sel;
  const targetName = (p.pl_name ?? p.hostname ?? `TIC ${p.tic}`).trim();
  const catPpm = p.pl_trandep ?? 0;
  const fitPpm = fit.depthFrac * 1e6;
  console.log(`fit: p=${fit.radiusRatio.toFixed(4)} b=${fit.impactParam.toFixed(2)} depth=${fitPpm.toFixed(0)}ppm (catalog ${catPpm.toFixed(0)}ppm) a/Rs=${aOverRs.toFixed(1)}`);

  // Build the figure over a window in orbital phase centered on transit (x shown in hours from mid-transit).
  const halfCyc = 0.08; // +/- 8% of the orbit
  const hours = (c: number) => c * period * 24; // phase cycles -> hours
  const xMax = hours(halfCyc);
  const NB = 54;
  const bins: { ph: number; t: number; med: number }[] = [];
  for (let i = 0; i < NB; i++) {
    const lo = -halfCyc + (2 * halfCyc * i) / NB;
    const hi = -halfCyc + (2 * halfCyc * (i + 1)) / NB;
    const c = (lo + hi) / 2;
    const vals = folded.filter((f) => f.phase >= lo && f.phase < hi && Math.abs(f.phase) <= halfCyc).map((f) => f.flux);
    if (vals.length >= 2) bins.push({ ph: c, t: hours(c), med: median(vals) });
  }
  if (bins.length < 8) throw new Error(`too few populated phase bins in the window (${bins.length})`);

  // exact-model curve across the window at the fitted parameters
  const MC = 160;
  const model: { t: number; f: number }[] = [];
  let modelMin = Infinity;
  for (let i = 0; i < MC; i++) {
    const c = -halfCyc + (2 * halfCyc * i) / (MC - 1);
    const z = separationCircular(c - fit.t0OffsetPhase, aOverRs, fit.impactParam);
    const f = exactTransitFlux(z, fit.radiusRatio, fit.ld, 1500);
    model.push({ t: hours(c), f });
    if (f < modelMin) modelMin = f;
  }
  const binMin = Math.min(...bins.map((b) => b.med));
  const binMax = Math.max(...bins.map((b) => b.med));
  const modelMax = Math.max(...model.map((m) => m.f));
  // domain must contain BOTH the transit floor and the baseline scatter so no point is clipped off-canvas
  const yLo = Math.min(binMin, modelMin);
  const yHi = Math.max(1.0, binMax, modelMax);
  const pad = (yHi - yLo) * 0.1 || 1e-4;
  const dLo = yLo - pad;
  const dHi = yHi + pad;

  // SVG geometry
  const W = 760, H = 300, mL = 64, mR = 18, mT = 40, mB = 46;
  const px = (t: number) => mL + ((t + xMax) / (2 * xMax)) * (W - mL - mR);
  const py = (f: number) => mT + (1 - (f - dLo) / (dHi - dLo)) * (H - mT - mB);

  const dots = bins
    .map((b) => `<circle cx="${px(b.t).toFixed(1)}" cy="${py(b.med).toFixed(1)}" r="2.6" fill="#cfe3ff" fill-opacity="0.85"/>`)
    .join("");
  const line = "M " + model.map((m) => `${px(m.t).toFixed(1)} ${py(m.f).toFixed(1)}`).join(" L ");
  const baseY = py(1.0).toFixed(1);

  // x ticks every 1h across the window
  let ticks = "";
  for (let h = Math.ceil(-xMax); h <= Math.floor(xMax); h++) {
    if (h % 2 !== 0 && Math.abs(h) > 1) continue;
    const xx = px(h).toFixed(1);
    ticks += `<line x1="${xx}" y1="${H - mB}" x2="${xx}" y2="${H - mB + 5}" stroke="#6f86a6"/><text x="${xx}" y="${H - mB + 18}" fill="#9fb4d4" font-size="11" text-anchor="middle">${h}</text>`;
  }

  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" font-family="ui-sans-serif, system-ui, Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#0b1220"/>
  <text x="${mL}" y="22" fill="#e7f0ff" font-size="15" font-weight="600">${targetName}: a real TESS transit, folded</text>
  <text x="${mL}" y="36" fill="#9fb4d4" font-size="11">dots = measured brightness (folded on the orbit); line = exact physical model we fit</text>
  <line x1="${mL}" y1="${baseY}" x2="${W - mR}" y2="${baseY}" stroke="#3b4a63" stroke-dasharray="4 4"/>
  <text x="${W - mR}" y="${(Number(baseY) - 5).toFixed(1)}" fill="#6f86a6" font-size="10" text-anchor="end">out of transit = 1.0</text>
  <line x1="${mL}" y1="${mT}" x2="${mL}" y2="${H - mB}" stroke="#3b4a63"/>
  <line x1="${mL}" y1="${H - mB}" x2="${W - mR}" y2="${H - mB}" stroke="#3b4a63"/>
  ${ticks}
  <text x="${(mL + (W - mL - mR) / 2).toFixed(0)}" y="${H - 8}" fill="#9fb4d4" font-size="11" text-anchor="middle">hours from mid-transit</text>
  <path d="${line}" fill="none" stroke="#5ad1a8" stroke-width="2"/>
  ${dots}
  <text x="${W - mR}" y="${mT + 6}" fill="#5ad1a8" font-size="11" text-anchor="end">fitted depth ~${fitPpm.toFixed(0)} ppm (catalog ${catPpm.toFixed(0)} ppm)</text>
</svg>
`;

  await writeFile(OUT, svg, "utf8");
  console.log(`wrote ${OUT} (${svg.length} bytes, ${bins.length} phase bins).`);
  if (/[^\x00-\x7F]/.test(svg)) console.log("WARNING: generated SVG contains a non-ASCII character.");
  else console.log("SVG is ASCII-clean.");
}

main().catch((e) => {
  console.error("figure generation failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
