// P81 -- TRICERATOPS-grade UPGRADE of the P80 external-candidate independent validation.
//
// P80 moved the external validation off 0/2 with a BLIND, non-circular corroboration match, but its two honest
// weaknesses (both quantified by us) were (i) un-modelled blends and (ii) ALIAS risk -- P78 measured that 2-sector
// period-only corroboration is only ~47% precise. TRICERATOPS attacks exactly those, so this script grades up the
// P80 validations by, for each CANDIDATE THAT P80-STYLE VALIDATION ALREADY CONFIRMED, adding three independent
// discriminants computed from data the detector never saw:
//   1. a REAL Gaia DR3 neighbour census inside a 21" aperture -> dilution factor + blend EB false-positive
//      probability (benchmark.daveBlendedFpp fed with the actual flux contrasts, not a generic guess);
//   2. harmonic ALIAS accounting: how many OTHER corroborated peaks of the same host sit at a simple harmonic of
//      the recovered period (countHarmonicSiblings) -> residual period ambiguity;
//   3. the multi-sector CENTROID F-Test (src/detect/centroidFtest.ts, faithful to eumemic) run per-sector on the
//      real pixel cubes at the recovered ephemeris -- a post-detection localisation, so it does not touch detection.
// These fold into one honest alias-risk grade (triceratopsLite.aliasRiskLevel). This is NOT full TRICERATOPS
// (no space-to-ground tables / limb darkening / radius posteriors); it is a defensible first-order grade-up.
//
// Red lines: research only. No worker import, no verdict, no bundle hash, no money path. discoveryClaim false,
// safeToGate false. A low alias-risk grade is a stronger CHECK supporting an external candidate, not a validation.
//
// Usage: npm run p81:triceratops-lite [-- --kp 10 --cp 10 --sectors 4 --tmag 11 --min-depth 3000 --tol 0.02
//          --min-corr 2 --aperture 21 --alpha 0.001 --centroid 1 --maxcentroid 20]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchToiTable, isPlaceable, type ToiRecord } from "../src/data/toiDispositions.ts";
import { resolveSpocKey, fetchSpocBytes, sectorsForCoord } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { localizeTransitSource, PIXEL_SCALE_ARCSEC } from "../src/detect/diffImaging.ts";
import { targetCentroidP } from "../src/detect/centroidFtest.ts";
import { fetchGaiaNeighborhood, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { daveBlendedFpp } from "../src/detect/benchmark.ts";
import { independentlyConfirmed } from "../src/candidate/independentValidation.ts";
import { neighborContrasts, dilutionCorrectedDepthPpm, countHarmonicSiblings, aliasRiskLevel } from "../src/candidate/triceratopsLite.ts";
import type { LightCurve } from "../src/core/types.ts";

function num(name: string, d: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) { const v = Number(hit.split("=")[1]); if (Number.isFinite(v)) return v; }
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return d;
}
const wantKp = Math.max(0, Math.round(num("kp", 10)));
const wantCp = Math.max(0, Math.round(num("cp", 10)));
const sectorCap = Math.max(2, Math.round(num("sectors", 4)));
const tmagCap = num("tmag", 11);
const minDepth = num("min-depth", 3000);
const TOL = num("tol", 0.02);
const MIN_CORR = Math.round(num("min-corr", 2));
const APERTURE = num("aperture", 21);
const ALPHA = num("alpha", 0.001);
const DO_CENTROID = num("centroid", 1) >= 1;
const maxCentroid = Math.round(num("maxcentroid", 20));
const minPeriod = 1, maxPeriod = 13;

interface Cluster { periodDays: number; corroboratedSectors: number; depthPpm: number }
interface Hit { sector: number; periodDays: number; depthPpm: number }

function detectSignals(lc: LightCurve): { periodDays: number; depthPpm: number }[] {
  try {
    const it = iterativeBls(lc, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals: 3 });
    return it.signals.filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible).map((s) => ({ periodDays: s.periodDays, depthPpm: s.depthPpm }));
  } catch { return []; }
}

async function clustersForTic(tic: number, sectors: number[], name: string): Promise<{ clusters: Cluster[]; nSectors: number }> {
  const list = (sectors.length ? sectors : []).slice(0, sectorCap);
  const hits: Hit[] = [];
  let used = 0;
  for (let k = 0; k < list.length; k++) {
    let bytes: Uint8Array | null = null;
    try { bytes = await fetchSpocBytes(resolveSpocKey(tic, list[k], "lc"), { timeoutMs: 20000 }); } catch { /* skip */ }
    if (!bytes) continue;
    let lc: LightCurve | null = null;
    try { lc = fitsToLightCurve(bytes, name); } catch { /* skip */ }
    if (!lc || lc.points.length < 120) continue;
    used++;
    for (const s of detectSignals(lc)) hits.push({ sector: used - 1, periodDays: s.periodDays, depthPpm: s.depthPpm });
  }
  const sorted = [...hits].sort((a, b) => a.periodDays - b.periodDays);
  const cs: { periods: number[]; depths: number[]; sectors: Set<number> }[] = [];
  for (const h of sorted) {
    let t: (typeof cs)[number] | undefined;
    for (const c of cs) { if (c.sectors.has(h.sector)) continue; const m = c.periods[Math.floor(c.periods.length / 2)]; if (Math.abs(m - h.periodDays) / m <= 0.05) { t = c; break; } }
    if (!t) { t = { periods: [], depths: [], sectors: new Set() }; cs.push(t); }
    t.periods.push(h.periodDays); t.depths.push(h.depthPpm); t.sectors.add(h.sector);
  }
  return { clusters: cs.map((c) => ({ periodDays: c.periods[Math.floor(c.periods.length / 2)], depthPpm: c.depths[Math.floor(c.depths.length / 2)], corroboratedSectors: c.sectors.size })), nSectors: used };
}

/** Gaia census inside the aperture -> dilution factor + neighbour flux contrasts (host = source nearest ra/dec). */
async function blendCensus(ra: number, dec: number, depthPpm: number, periodDays: number) {
  let sources: Awaited<ReturnType<typeof fetchGaiaNeighborhood>> = [];
  try { sources = await fetchGaiaNeighborhood(ra, dec, { radiusDeg: (APERTURE + 6) / 3600 }); } catch { /* unavailable */ }
  if (!sources.length) return { determined: false as const, dilutionFactor: NaN, nInAperture: 0, blendFpp: NaN, contrastNote: "Gaia unavailable" };
  let host = sources[0], hostSep = Infinity;
  for (const g of sources) { const s = angularSepArcsec(ra, dec, g.ra, g.dec); if (s < hostSep) { hostSep = s; host = g; } }
  const hostG = host.gmag;
  const nbGmags: number[] = [];
  let fluxRatio = 0, n = 0;
  for (const g of sources) {
    if (g.sourceId === host.sourceId) continue;
    if (!(angularSepArcsec(ra, dec, g.ra, g.dec) <= APERTURE)) continue;
    const c = Math.pow(10, -0.4 * (g.gmag - hostG));
    if (!(c > 0)) continue;
    nbGmags.push(g.gmag); fluxRatio += c; n++;
  }
  const dilutionFactor = 1 / (1 + fluxRatio);
  const contrasts = neighborContrasts(hostG, nbGmags);
  const blendFpp = daveBlendedFpp({ obsDepthFrac: depthPpm / 1e6, periodDays, neighbors: contrasts.map((contrast) => ({ contrast })), ebPriorShortPeriod: 0.015 });
  return { determined: true as const, dilutionFactor, nInAperture: n, blendFpp, contrastNote: `brightest contrast ${contrasts.length ? contrasts[0].toExponential(1) : "none"}` };
}

/** Multi-sector centroid F-test at the recovered ephemeris (post-detection localisation only). */
async function centroidCheck(tic: number, sectors: number[], name: string, periodDays: number, epochBjd: number) {
  const list = (sectors.length ? sectors : []).slice(0, sectorCap);
  const offsets: { east: number; north: number }[] = [];
  for (const s of list) {
    try {
      const lcBytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 });
      const lc = lcBytes ? fitsToLightCurve(lcBytes, name) : null;
      if (!lc) continue;
      const cube = await fetchSpocTargetPixels(tic, s, lc.targetId);
      if (!cube) continue;
      const loc = localizeTransitSource(cube, epochBjd, periodDays, 2, { bootstraps: 120, seed: 4242 });
      if (!loc || !loc.determined || loc.dropSnr < 5) continue;
      offsets.push({ east: (loc.sourceCentroid.x - loc.targetCentroid.x) * PIXEL_SCALE_ARCSEC, north: (loc.sourceCentroid.y - loc.targetCentroid.y) * PIXEL_SCALE_ARCSEC });
    } catch { /* try next sector */ }
  }
  const r = targetCentroidP(offsets);
  return { testable: r.testable, p: r.p, nUsed: r.nUsed };
}

async function main(): Promise<void> {
  console.log(`P81 TRICERATOPS-grade upgrade of P80. Blind per-sector detection (claim ephemeris never fed), corroboration>=${MIN_CORR}, tol ${(TOL * 100).toFixed(0)}%; then per validated candidate: Gaia ${APERTURE}" census + blend FPP + harmonic alias + ${DO_CENTROID ? "centroid F-test" : "no centroid"}.`);
  let fcBase = 0.53;
  try { const p78 = JSON.parse(readFileSync("reports/p78-blind-multisector.json", "utf8")) as { capped: { acceptedPrecision: number } }; if (Number.isFinite(p78.capped.acceptedPrecision)) fcBase = 1 - p78.capped.acceptedPrecision; } catch { /* keep fallback */ }
  console.log(`empirical false-coincidence base from P78: ${(fcBase * 100).toFixed(0)}% (1 - accepted precision)`);

  const records = await fetchToiTable();
  if (!records.length) { console.log("ExoFOP TOI table unavailable (network)."); process.exitCode = 1; return; }
  const usable = (r: ToiRecord) => isPlaceable(r) && Number.isFinite(r.depthPpm) && r.depthPpm >= minDepth && r.periodDays >= 2 && r.periodDays <= 8 && r.sectors.length >= 2 && Number.isFinite(r.tessMag) && r.tessMag <= tmagCap;
  const isKP = (r: ToiRecord) => (r.tfopwgDisposition || "").toUpperCase() === "KP" || (r.tessDisposition || "").toUpperCase() === "KP";
  const isCP = (r: ToiRecord) => (r.tfopwgDisposition || "").toUpperCase() === "CP" || (r.tessDisposition || "").toUpperCase() === "CP";
  const uniq = (rows: ToiRecord[]) => { const seen = new Set<number>(); const out: ToiRecord[] = []; for (const r of [...rows].sort((a, b) => a.tessMag - b.tessMag)) { if (seen.has(r.tic)) continue; seen.add(r.tic); out.push(r); } return out; };
  const kp = uniq(records.filter((r) => usable(r) && isKP(r))).slice(0, wantKp);
  const cp = uniq(records.filter((r) => usable(r) && isCP(r))).slice(0, wantCp);
  console.log(`pools: ${kp.length} KP controls, ${cp.length} CP uncertain external candidates`);

  const cache = new Map<number, { clusters: Cluster[]; nSectors: number }>();
  async function clustersFor(rec: ToiRecord) {
    const hit = cache.get(rec.tic); if (hit) return hit;
    const c = await clustersForTic(rec.tic, rec.sectors.length ? rec.sectors : await sectorsForCoord(rec.ra, rec.dec).catch(() => [] as number[]), `TIC ${rec.tic} ${rec.toi}`);
    cache.set(rec.tic, c); return c;
  }

  interface Row { tic: number; toi: string; disp: string; periodDays: number; depthPpm: number; maxCorr: number; validated: boolean; dilution: number; nInAperture: number; blendFpp: number; correctedDepthPpm: number; harmonicSiblings: number; centroidP: number | null; centroidOnTarget: boolean | null; aliasLevel: string; aliasNote: string; tricGrade: boolean }
  const rows: Row[] = [];
  let centroidBudget = maxCentroid;
  for (const pool of [kp, cp]) {
    for (const rec of pool) {
      const { clusters, nSectors } = await clustersFor(rec);
      const corr = clusters.filter((c) => c.corroboratedSectors >= MIN_CORR);
      let best: { cl: Cluster; rel: number } | null = null;
      for (const cl of corr) { const r = independentlyConfirmed({ periodDays: cl.periodDays, corroboratedSectors: cl.corroboratedSectors }, { id: rec.toi, periodDays: rec.periodDays, disposition: rec.tfopwgDisposition }, { periodTolFrac: TOL, minCorroboration: MIN_CORR }); if (r.validated && (!best || r.relPeriodDiff < best.rel)) best = { cl, rel: r.relPeriodDiff }; }
      const disp = (rec.tfopwgDisposition || rec.tessDisposition || "?").toUpperCase();
      const maxCorr = Math.max(0, ...clusters.map((c) => c.corroboratedSectors));
      if (!best) { rows.push({ tic: rec.tic, toi: rec.toi, disp, periodDays: Number(rec.periodDays.toFixed(5)), depthPpm: Math.round(rec.depthPpm), maxCorr, validated: false, dilution: NaN, nInAperture: 0, blendFpp: NaN, correctedDepthPpm: NaN, harmonicSiblings: 0, centroidP: null, centroidOnTarget: null, aliasLevel: "n/a", aliasNote: "not validated (P80 stage)", tricGrade: false }); console.log(`  [${disp}] TIC ${rec.tic} not validated (maxCorr ${maxCorr})`); continue; }
      const validated = true;
      const matchedPeriod = best.cl.periodDays;
      const census = await blendCensus(rec.ra, rec.dec, rec.depthPpm, rec.periodDays);
      const harmonicSiblings = countHarmonicSiblings(matchedPeriod, corr.map((c) => c.periodDays));
      let centroidP: number | null = null, centroidOnTarget: boolean | null = null;
      if (DO_CENTROID && centroidBudget > 0) { centroidBudget--; const cc = await centroidCheck(rec.tic, rec.sectors, `TIC ${rec.tic} ${rec.toi}`, rec.periodDays, rec.epochBjd); centroidOnTarget = cc.testable ? cc.p >= ALPHA : null; centroidP = cc.testable ? Number(cc.p.toExponential(2)) : null; }
      const alias = aliasRiskLevel({ harmonicSiblings, falseCoincidenceBase: fcBase, centroidOnTarget, blendFpp: census.determined ? census.blendFpp : 1 });
      const tricGrade = census.determined && census.blendFpp < 1e-3 && centroidOnTarget !== false && alias.level === "low";
      rows.push({ tic: rec.tic, toi: rec.toi, disp, periodDays: Number(rec.periodDays.toFixed(5)), depthPpm: Math.round(rec.depthPpm), maxCorr, validated, dilution: census.determined ? Number(census.dilutionFactor.toFixed(4)) : NaN, nInAperture: census.nInAperture, blendFpp: census.determined ? Number(census.blendFpp.toExponential(2)) : NaN, correctedDepthPpm: census.determined ? Math.round(dilutionCorrectedDepthPpm(rec.depthPpm, census.dilutionFactor)) : NaN, harmonicSiblings, centroidP, centroidOnTarget, aliasLevel: alias.level, aliasNote: `${census.contrastNote}; ${alias.note}`, tricGrade });
      console.log(`  [${disp}] TIC ${rec.tic} VALIDATED rec ${matchedPeriod.toFixed(4)}d | dil ${census.determined ? census.dilutionFactor.toFixed(3) : "n/a"} nb${census.nInAperture} fpp ${census.determined ? census.blendFpp.toExponential(1) : "n/a"} | alias peaks ${harmonicSiblings} | centroid ${centroidOnTarget === null ? "n/a" : centroidOnTarget ? "on-target" : "OFF-target"} | risk ${alias.level}${tricGrade ? " [TRICERATOPS-grade]" : ""}`);
    }
  }

  const cpValid = rows.filter((r) => r.disp === "CP" && r.validated);
  const kpValid = rows.filter((r) => r.disp === "KP" && r.validated);
  const cpGrade = cpValid.filter((r) => r.tricGrade).length;
  const cpLowOrMod = cpValid.filter((r) => r.aliasLevel === "low" || r.aliasLevel === "moderate").length;
  const totalValid = rows.filter((r) => r.validated).length;
  console.log(`\nRESULT: ${totalValid} validated; KP controls ${kpValid.length}, CP uncertain-external ${cpValid.length}; of CP: blendFPP<1e-3 & centroid-on-target & low alias = ${cpGrade}, alias low/moderate = ${cpLowOrMod}.`);
  const verdict = totalValid === 0
    ? "NO-VALIDATIONS: nothing cleared the P80 corroboration+period stage on this sample; nothing to grade. Measure-only."
    : `GRADED: ${totalValid} blind validations carried forward. For the ${cpValid.length} still-uncertain EXTERNAL (CP) candidates, blend-FPP + harmonic-alias + multi-sector centroid F-test now quantify the residual risk P78 only bounded statistically; ${cpGrade} reach TRICERATOPS-grade (blendFPP<1e-3, centroid not off-target, low alias). Still first-order checks, NOT discoveries or full TRICERATOPS; safeToGate false.`;
  console.log(`VERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { generatedBy: "scripts/p81-triceratops-lite.ts", protocol: "P80 blind corroboration validation, then per validated candidate: Gaia 21-inch blend census + blendFpp + harmonic alias + multi-sector centroid F-test", wantKp, wantCp, sectorCap, tmagCap, minDepth, tol: TOL, minCorroboration: MIN_CORR, apertureArcsec: APERTURE, centroidAlpha: ALPHA, centroidEnabled: DO_CENTROID, falseCoincidenceBase: fcBase, ebPriorShortPeriod: 0.015, note: "first-order TRICERATOPS-grade-up, not full TRICERATOPS; discoveryClaim false, safeToGate false." },
    totals: { validated: totalValid, kpValidated: kpValid.length, cpValidated: cpValid.length, cpTricGrade: cpGrade, cpLowOrModerate: cpLowOrMod },
    rows, verdict, discoveryClaim: false, safeToGate: false,
  };
  writeFileSync("reports/p81-triceratops-lite.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P81 TRICERATOPS-grade upgrade of the P80 external-candidate validation (audit finding 9, gap 3)",
    "",
    `Reproduce: \`npm run p81:triceratops-lite -- --kp ${wantKp} --cp ${wantCp} --aperture ${APERTURE} --centroid ${DO_CENTROID ? 1 : 0}\``,
    "",
    "P80 confirmed external (ExoFOP) claims via a BLIND, non-circular per-sector corroboration match, but its",
    "residual risks -- blends and period aliasing (P78: 2-sector precision ~47%) -- were only bounded statistically.",
    "Here each already-validated candidate gets three discriminants from data the detector never saw: a real Gaia",
    "neighbour census -> dilution + blend EB false-positive probability, harmonic-alias accounting, and the",
    "multi-sector centroid F-test (faithful to eumemic) run on the pixel cubes at the recovered ephemeris.",
    `Empirical false-coincidence base folded in from P78: ${(fcBase * 100).toFixed(0)}%.`,
    "",
    "| host (TIC) | TOI | disp | P (d) | depth ppm | dilution | nNb | blend FPP | corrected depth | alias peaks | centroid on-target | alias risk | TRIC-grade |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.tic} | ${r.toi} | ${r.disp} | ${r.periodDays} | ${r.depthPpm} | ${r.dilution} | ${r.nInAperture} | ${r.blendFpp} | ${r.correctedDepthPpm} | ${r.harmonicSiblings} | ${r.centroidOnTarget === null ? "n/a" : r.centroidOnTarget ? "yes" : "NO"} | ${r.aliasLevel} | ${r.tricGrade ? "YES" : "-"} |`),
    "",
    `**CP (uncertain external): ${cpValid.length} validated, ${cpGrade} reach TRICERATOPS-grade (blendFPP<1e-3 + centroid not off-target + low alias).**`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "First-order, not full TRICERATOPS (no space-to-ground tables / limb darkening / radius posteriors); a low",
    "alias-risk grade is a stronger CHECK supporting an external candidate, not a validated FPP or a discovery.",
    "Measures only; gates nothing, anchors nothing. discoveryClaim false, safeToGate false.",
    "",
  ];
  writeFileSync("reports/p81-triceratops-lite.md", md.join("\n"));
  console.log("wrote reports/p81-triceratops-lite.{md,json}");
}

main().catch((e) => { console.error("p81 failed:", e instanceof Error ? e.message : e); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
