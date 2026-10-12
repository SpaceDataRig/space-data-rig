// P15 - INDEPENDENT REVIEW of an external planet-candidate claim, using OUR rig.
//
// Target: Paras Chopra's two Earth-sized TESS candidates (public repo + Zenodo, checked 2026-10-09):
//   #1 "Aakanksha"  TIC 370612437  P=3.564921d  depth 210ppm  T14 1.44h  Rp 1.04 R_earth
//   #2 "Orbit"      TIC 252721481  P=4.933533d  depth 279ppm  T14 1.59h  Rp 1.10 R_earth
// Both are FFI-cadence (30-min) TESS-SPOC light curves of nearby dwarfs; he asks for independent review
// and flags that a faint neighbour eclipsing binary is NOT excluded.
//
// What we do INDEPENDENTLY (no reuse of his pipeline; his ephemeris is withheld from the detector):
//   A. Novelty: scan the NASA Exoplanet Archive confirmed list + the TOI candidate list for these TICs.
//   B. Host star via ESA Gaia by source_id: distance (parallax) and RUWE, and a neighbour/dilution audit
//      at the TESS aperture scale (his main false-positive worry).
//   C. BLIND re-detection: fetch the same public SPOC light curves through our token-free channel, stitch
//      sectors, run OUR BLS detector over the full period grid WITHOUT his ephemeris, and compare the
//      recovered period/depth to his claim.
//   D. Geometry: check that his (P, depth, Rp/R*, b) set implies a transit duration consistent with his T14.
//
// This is a review of SOMEONE ELSE'S candidate, not a discovery claim by us. Research probe only: no
// production path, no gating, nothing anchored. Degrades honestly offline / if a channel is unavailable.
//
// Run:  npx tsx scripts/p15-external-review.ts
import { detectTransit } from "../src/detect/pipeline.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import { fetchGaiaNeighborhood, dilutionFromNeighbors, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import type { LightCurve } from "../src/core/types.ts";

const GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync";
const UA = "Mozilla/5.0 (compatible; space-data-rig)";

interface Claim {
  label: string; tic: number; gaiaId: string; period: number; epoch: number;
  depthPpm: number; durH: number; rpRe: number; rpRs: number; b: number; teq: number; sectors: number[];
}
const CLAIMS: Claim[] = [
  { label: "Aakanksha", tic: 370612437, gaiaId: "1981360227180249088", period: 3.564921, epoch: 2458742.1409, depthPpm: 210, durH: 1.44, rpRe: 1.04, rpRs: 0.0144, b: 0.73, teq: 850, sectors: [16, 17, 56, 57, 76, 77, 83, 84] },
  { label: "Orbit", tic: 252721481, gaiaId: "1991778271640247808", period: 4.933533, epoch: 2458740.6616, depthPpm: 279, durH: 1.59, rpRe: 1.10, rpRs: 0.0167, b: 0.68, teq: 716, sectors: [16, 17, 57, 77, 84] },
];

async function gaiaById(id: string) {
  const adql = `select ra,dec,parallax,phot_g_mean_mag,ruwe from gaiadr3.gaia_source where source_id=${id}`;
  const url = `${GAIA_TAP}?REQUEST=doQuery&LANG=ADQL&FORMAT=json&PHASE=RUN&QUERY=${encodeURIComponent(adql)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Gaia HTTP ${r.status}`);
    const j = (await r.json()) as { metadata: { name: string }[]; data: (number | null)[][] };
    const idx: Record<string, number> = {};
    j.metadata.forEach((m, i) => (idx[m.name] = i));
    const row = j.data && j.data[0];
    if (!row) return null;
    const g = (k: string) => (row[idx[k]] == null ? NaN : Number(row[idx[k]]));
    return { ra: g("ra"), dec: g("dec"), parallax: g("parallax"), gmag: g("phot_g_mean_mag"), ruwe: g("ruwe") };
  } finally {
    clearTimeout(timer);
  }
}

function medianDt(lc: LightCurve): number {
  const p = lc.points;
  const d: number[] = [];
  for (let i = 1; i < p.length; i++) d.push(p[i].time - p[i - 1].time);
  d.sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : NaN;
}

console.log("P15 INDEPENDENT REVIEW of P. Chopra's two TESS planet candidates (public, checked 2026-10-09).");
console.log("Our rig reviews his claim independently; his ephemeris is WITHHELD from our detector. Not our discovery.\n");

// A. novelty -- fetch the lists once and scan for these two TICs.
let confirmedTics = new Set<number>();
let toiTics = new Set<number>();
let confirmedN = -1;
let toiN = -1;
try {
  const conf = await fetchConfirmedPlanets({ maxTmag: 14, requireTic: true, limit: 6000 });
  confirmedN = conf.planets.length;
  for (const p of conf.planets) if (p.tic != null) confirmedTics.add(p.tic);
  console.log(`[novelty] NASA Archive confirmed transiting planets scanned: ${conf.planets.length} (source=${conf.source})`);
} catch (e) { console.log(`[novelty] confirmed-list fetch failed: ${e instanceof Error ? e.message : e}`); }
try {
  const toi = await fetchTocCandidates({ excludeConfirmedHosts: false, limit: 20000 });
  toiN = toi.candidates.length;
  for (const c of toi.candidates) if (Number.isFinite(c.tic)) toiTics.add(c.tic);
  console.log(`[novelty] TOI candidate list scanned: ${toi.candidates.length} (source=${toi.source})`);
} catch (e) { console.log(`[novelty] TOI fetch failed: ${e instanceof Error ? e.message : e}`); }

for (const c of CLAIMS) {
  console.log(`\n================ ${c.label}  (TIC ${c.tic}) ================`);
  console.log(`  his claim: P=${c.period}d  epoch=${c.epoch}  depth=${c.depthPpm}ppm  T14=${c.durH}h  Rp=${c.rpRe}Re  Rp/R*=${c.rpRs}  b=${c.b}  Teq~${c.teq}K`);

  // A. novelty for this TIC
  console.log(`  [A novelty] in confirmed-archive list? ${confirmedTics.has(c.tic) ? "YES (contradicts him)" : "no"}; in TOI list? ${toiTics.has(c.tic) ? "YES (contradicts him)" : "no"}`);

  // B. Gaia host + neighbours
  let host: Awaited<ReturnType<typeof gaiaById>> = null;
  try {
    host = await gaiaById(c.gaiaId);
    if (host) {
      const distPc = 1000 / host.parallax;
      console.log(`  [B Gaia] ra=${host.ra.toFixed(4)} dec=${host.dec.toFixed(4)} parallax=${host.parallax.toFixed(3)}mas -> distance ${distPc.toFixed(1)} pc (${(distPc * 3.26156).toFixed(0)} ly); G=${host.gmag.toFixed(2)}; RUWE=${host.ruwe.toFixed(2)} ${host.ruwe < 1.2 ? "(astrometry clean, no strong close-binary perturbation)" : "(RUWE elevated -- possible binary)"}`);
      try {
        const neigh = await fetchGaiaNeighborhood(host.ra, host.dec, { radiusDeg: 21 / 3600 });
        // Exclude the host by POSITION: Gaia may return source_id as a precision-lost int64, so id-match fails.
        const hRa = host.ra;
        const hDec = host.dec;
        const others = neigh.filter((s) => angularSepArcsec(hRa, hDec, s.ra, s.dec) > 0.5);
        const dil = dilutionFromNeighbors(host.gmag, host.ra, host.dec, others, 21);
        console.log(`         neighbours within 21" (aperture): n=${dil.nInAperture}, brightest contrast ${(dil.brightestContrastMag).toFixed(1)} mag at ${dil.brightestSepArcsec.toFixed(1)}", dilution factor ${dil.dilutionFactor.toFixed(3)} (${dil.contaminationPct.toFixed(1)}% contaminating G-flux)`);
        console.log(`         -> blend/EB risk: ${dil.nInAperture === 0 ? "no resolved neighbour in aperture (blend unlikely)" : dil.brightestContrastMag > 4 ? "only FAINT neighbours (an EB there would need to be deep; low risk)" : "a BRIGHT-enough neighbour exists -> his EB caveat is live"}`);
      } catch (e) { console.log(`         neighbour query failed: ${e instanceof Error ? e.message : e}`); }
    } else console.log(`  [B Gaia] no Gaia row for source_id ${c.gaiaId}`);
  } catch (e) { console.log(`  [B Gaia] query failed: ${e instanceof Error ? e.message : e}`); }

  // C. blind re-detection through our own channel -- the fair test is whether HIS period is a top peak
  // in OUR full-grid BLS (his ephemeris never steers the search), on two data paths.
  try {
    const sectorLcs: LightCurve[] = [];
    for (const s of c.sectors) {
      const lc = await fetchSpocLightCurve(c.tic, [s], c.label);
      if (lc) sectorLcs.push(lc);
    }
    if (sectorLcs.length === 0) {
      console.log(`  [C blind] NO data via our token-free SPOC channel for these sectors (cannot re-detect here).`);
    } else {
      const dtMin = medianDt(sectorLcs[0]) * 1440;
      const stitched = stitchLightCurves(sectorLcs) ?? sectorLcs[0];
      const span = stitched.points.length ? stitched.points[stitched.points.length - 1].time - stitched.points[0].time : 0;
      console.log(`  [C blind] sectors ${sectorLcs.length}/${c.sectors.length}, cadence ~${dtMin.toFixed(1)} min, stitched n=${stitched.points.length}, span ${span.toFixed(0)} d`);
      const probe = (lc: LightCurve, tag: string): number => {
        const b = detectTransit(lc).bls; // full-grid, blind
        if (!b.periodGrid.length) { console.log(`     ${tag}: empty grid`); return -1; }
        const gp = b.periodGrid.reduce((best, g) => (Math.abs(g.period - c.period) < Math.abs(best.period - c.period) ? g : best), b.periodGrid[0]);
        const rank = b.periodGrid.filter((g) => g.power > gp.power).length; // 0 = his period is the global peak
        console.log(`     ${tag}: our BLS peak ${b.periodDays.toFixed(4)}d (SNR ${b.snr.toFixed(1)}, ${(b.depth * 1e6).toFixed(0)}ppm); his ${c.period}d = grid #${rank + 1}/${b.periodGrid.length} by power (${gp.power.toFixed(2)} vs peak ${b.power.toFixed(2)})`);
        return rank;
      };
      const rankStitched = probe(stitched, "stitched multi-season");
      const one = sectorLcs.reduce((a, x) => (x.points.length > a.points.length ? x : a));
      const rankSingle = probe(one, `longest single sector (n=${one.points.length})`);
      const corroborated = rankStitched === 0 || rankSingle === 0;
      console.log(`     -> our blind BLS ${corroborated ? "peaks AT his period on at least one path: the signal is present in the pixels independent of his pipeline." : "does NOT rank his period first on either path -- our box statistic at this cadence puts it near the detection floor (his SDE is a different, tuned metric); this neither confirms nor refutes, but flags it as marginal for our detector."}`);
    }
  } catch (e) { console.log(`  [C blind] detection failed: ${e instanceof Error ? e.message : e}`); }

  // D. geometry self-consistency of HIS parameter set
  try {
    const rStarRsun = (c.rpRe / 109.2) / c.rpRs; // implied stellar radius from his Rp and Rp/R*
    const mStar = mainSequenceMassFromRadius(rStarRsun);
    const aRs = aOverRsFromKepler(c.period, mStar, rStarRsun);
    const halfDurDays = (c.period / Math.PI) * Math.asin(Math.min(1, Math.sqrt(Math.max(0, (1 + c.rpRs) ** 2 - c.b ** 2)) / aRs));
    const t14h = halfDurDays * 24; // the asin formula already yields the FULL T14 (do not double)
    console.log(`  [D geometry] his numbers imply R*=${rStarRsun.toFixed(2)} Rsun, a/Rs=${aRs.toFixed(1)} -> expected T14=${t14h.toFixed(2)} h vs his ${c.durH} h (${Math.abs(t14h - c.durH) / c.durH < 0.25 ? "consistent" : "INCONSISTENT -- check his R* or b"})`);
  } catch (e) { console.log(`  [D geometry] failed: ${e instanceof Error ? e.message : e}`); }
}

console.log(`\n=== HOW TO READ THIS ===`);
console.log(`  A: if neither list contains the TIC, his "not on any NASA list" is independently corroborated.`);
console.log(`  B: Gaia distance should match his; low RUWE + no bright in-aperture neighbour weakens the EB-false-positive worry (a faint one can still hide at 21").`);
console.log(`  C: if OUR blind period (his ephemeris withheld) lands on his within ~0.1%, the signal is real in the downlinked pixels independent of his pipeline.`);
console.log(`  D: his (P, depth, Rp/R*, b) should predict his observed duration; a large gap would flag an internally inconsistent fit.`);
console.log(`  This is an independent review of another party's CANDIDATE -- not a confirmation and not our discovery. Follow-up (neighbour clearing, the preregistered 2027 sectors) decides.`);
