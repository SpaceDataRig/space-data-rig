// REUSABLE INDEPENDENT-REVIEW LIBRARY (turns the one-off p15 probe into a first-class capability).
//
// WHY. The single most valuable thing this rig can do is not "re-confirm a planet we already know"
// -- it is OBJECTIVELY AUDIT a claim a third party published, using only public data and our own
// detector, with the claim's ephemeris withheld. p15 did that once as a hand-assembled script. This
// module makes it a durable, unit-tested, dependency-injectable function so the same audit is a
// reproducible primitive rather than prose in a throwaway file.
//
// HONEST FRAMING (hard rules baked in):
//   - This reviews SOMEONE ELSE'S candidate. It is NOT our discovery and never claims one.
//   - "Our untuned box-BLS did not rank his period first" is a limit of OUR detector at that cadence,
//     NOT a refutation of him. detectabilityFloor() quantifies exactly when we are blind.
//   - Nothing here is on the money path: no gating, no verdict, no anchoring. The worker does not
//     import this module, so the production bundle is unchanged. It is research infrastructure.
//
// The pure functions (impliedGeometry, periodPowerRank, blendRiskTier, detectabilityFloor, novelty)
// are deterministic and unit-tested offline. reviewExternalCandidate() orchestrates the networked
// channels through an injectable `deps` object so its LOGIC is also testable without the internet.

import {
  dilutionFromNeighbors,
  angularSepArcsec,
  distancePcFromParallax,
  type DilutionResult,
  type GaiaSource,
} from "../data/gaiaDilution.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../sim/transitModel.ts";
import type { BLSResult } from "../detect/bls.ts";
import type { LightCurve } from "../core/types.ts";

// ---------- input shape ----------

/** One externally-claimed candidate. Units: depthPpm (ppm), t14Hours, rpEarth in R_earth, rpOverRs = Rp/R*. */
export interface CandidateClaim {
  label: string;
  tic: number;
  gaiaSourceId: string;
  periodDays: number;
  epochBjd: number;
  depthPpm: number;
  t14Hours: number;
  rpEarth: number;
  rpOverRs: number;
  impactParam: number;
  sectors: number[];
}

// ---------- D. geometry self-consistency ----------

export interface GeometryResult {
  starRadiusRsun: number;
  aOverRs: number;
  expectedT14Hours: number;
  deltaPct: number;
  consistent: boolean;
}

/**
 * From a claim's own (P, Rp, Rp/R*, b) derive the stellar radius + a/R* (Kepler III with an MS
 * mass-radius proxy) and the expected full T14; compare to the reported T14. Internally INCONSISTENT
 * numbers flag a fit problem -- they are not evidence the planet is real or fake.
 */
export function impliedGeometry(c: Pick<CandidateClaim, "periodDays" | "rpEarth" | "rpOverRs" | "impactParam" | "t14Hours">): GeometryResult {
  if (!(c.rpOverRs > 0) || !(c.t14Hours > 0) || !(c.periodDays > 0)) {
    return { starRadiusRsun: NaN, aOverRs: NaN, expectedT14Hours: NaN, deltaPct: NaN, consistent: false };
  }
  const starRadiusRsun = c.rpEarth / 109.2 / c.rpOverRs; // R* = (Rp[Rsun]) / (Rp/R*)
  const mStar = mainSequenceMassFromRadius(starRadiusRsun);
  const aOverRs = aOverRsFromKepler(c.periodDays, mStar, starRadiusRsun);
  const p = c.rpOverRs;
  const b = c.impactParam;
  const arg = Math.min(1, Math.sqrt(Math.max(0, (1 + p) ** 2 - b ** 2)) / aOverRs);
  const expectedT14Hours = (c.periodDays / Math.PI) * Math.asin(arg) * 24; // asin form already yields FULL T14
  const deltaPct = Math.abs(expectedT14Hours - c.t14Hours) / c.t14Hours;
  return { starRadiusRsun, aOverRs, expectedT14Hours, deltaPct, consistent: deltaPct < 0.25 };
}

// ---------- C. where the claimed period ranks in OUR blind full-grid power ----------

export interface RankResult {
  targetPeriodDays: number;
  nearestGridPeriod: number;
  nearestPower: number;
  rank: number; // 0 = the claimed period sits at the global power peak
  total: number;
  isGlobalPeak: boolean;
  gridPeakPeriod: number;
  gridPeakPower: number;
}

export function periodPowerRank(grid: { period: number; power: number }[], targetPeriodDays: number): RankResult | null {
  if (!grid || grid.length === 0 || !Number.isFinite(targetPeriodDays)) return null;
  let nearest = grid[0];
  let peak = grid[0];
  for (const g of grid) {
    if (Math.abs(g.period - targetPeriodDays) < Math.abs(nearest.period - targetPeriodDays)) nearest = g;
    if (g.power > peak.power) peak = g;
  }
  const rank = grid.filter((g) => g.power > nearest.power).length;
  return {
    targetPeriodDays,
    nearestGridPeriod: nearest.period,
    nearestPower: nearest.power,
    rank,
    total: grid.length,
    isGlobalPeak: rank === 0,
    gridPeakPeriod: peak.period,
    gridPeakPower: peak.power,
  };
}

// ---------- B. blend / EB false-positive risk tiering (diagnostic, never a reject gate) ----------

export type BlendTier = "low" | "moderate" | "high" | "undetermined";

export interface BlendRisk {
  tier: BlendTier;
  needsGroundBased: boolean;
  contaminationPct: number;
  nInAperture: number;
  brightestContrastMag: number;
  rationale: string;
}

export function blendRiskTier(d: DilutionResult): BlendRisk {
  if (!d.determined) {
    return {
      tier: "undetermined",
      needsGroundBased: true,
      contaminationPct: d.contaminationPct,
      nInAperture: d.nInAperture,
      brightestContrastMag: d.brightestContrastMag,
      rationale: "Gaia resolved no neighbour in the aperture -> dilution undetermined; faint unresolved EBs are not excluded, ground-based resolution still recommended.",
    };
  }
  const c = d.contaminationPct;
  const contrast = d.brightestContrastMag;
  if (c >= 25 || contrast < 2) {
    return { tier: "high", needsGroundBased: true, contaminationPct: c, nInAperture: d.nInAperture, brightestContrastMag: contrast, rationale: "a bright (<=2 mag fainter) in-aperture neighbour could itself be a diluted eclipsing binary -> the EB caveat is live; resolve it before believing the depth." };
  }
  if (c < 5 && contrast > 4) {
    return { tier: "low", needsGroundBased: false, contaminationPct: c, nInAperture: d.nInAperture, brightestContrastMag: contrast, rationale: "only faint neighbours (>=4 mag fainter, <5% flux) -> a blend/EB there would need implausible depth; low contamination risk (non-zero)." };
  }
  return { tier: "moderate", needsGroundBased: true, contaminationPct: c, nInAperture: d.nInAperture, brightestContrastMag: contrast, rationale: "intermediate contamination -> worth a ground-based look, but not disqualifying on its own." };
}

// ---------- detection floor (roadmap item 2): a coarse analytic sensitivity proxy (NOT a calibration) ----------

export interface Detectability {
  pointsInTransit: number; // samples the ~T14 dip covers at this cadence
  snrProxy: number; // order-of-magnitude BLS SNR estimate; PROXY only
  belowOurFloor: boolean; // true = our detector is expected to miss this shape at this cadence
  reason: string;
}

/**
 * Estimate whether OUR detector could see a dip of this shape at this sampling. Two effects dominate a
 * box-BLS: the depth-vs-noise ratio and how many samples actually land inside the transit. A ~1.5 h
 * dip at 30-min cadence covers only ~3 samples, so even a real planet can fall below an untuned box
 * statistic -- which is exactly the p15 situation. This is a documented PROXY to be honest about our
 * blind spot, calibrated against reality by scripts/p16-cadence-floor.ts, not a hard threshold.
 */
export function detectabilityFloor(depthPpm: number, t14Hours: number, cadenceMin: number, noisePpm = 200, nTransits = 3, snrThreshold = 7): Detectability {
  const pointsInTransit = cadenceMin > 0 ? (t14Hours * 60) / cadenceMin : NaN;
  const nSamples = Math.max(0, Math.floor(pointsInTransit));
  // depth*sqrt(total in-transit samples)/noise, clipped -- an order-of-magnitude proxy
  const snrProxy = nSamples > 0 ? (depthPpm / Math.max(1, noisePpm)) * Math.sqrt(nSamples * Math.max(1, nTransits)) : 0;
  const starvedOfSamples = nSamples < 2; // a dip the sampling cannot even resolve
  const belowOurFloor = starvedOfSamples || snrProxy < snrThreshold;
  const reason = starvedOfSamples
    ? `T14 ${t14Hours.toFixed(2)}h at ${cadenceMin.toFixed(0)}-min cadence covers <2 samples -> a box statistic cannot resolve this dip shape, independent of depth.`
    : belowOurFloor
      ? `proxy SNR ${snrProxy.toFixed(1)} < ${snrThreshold}: near/below our untuned detector floor at this cadence -- a non-detection here is OUR limit, not evidence against the signal.`
      : `proxy SNR ${snrProxy.toFixed(1)} >= ${snrThreshold}: not sample-starved at this cadence. This proxy does NOT model the multiple-trials penalty of a full blind search (~20k periods) or per-star red noise, so "not sample-starved" is NOT a promise of detection -- p16 measured exactly this: a ~200ppm/1.4h planet at ~3-min cadence clears this bar yet still loses to noise+trials in a blind grid.`;
  return { pointsInTransit, snrProxy, belowOurFloor, reason };
}

// ---------- A. novelty ----------

export interface NoveltyResult {
  inConfirmed: boolean;
  inToi: boolean;
  confirmedScanned: number;
  toiScanned: number;
}

export function noveltyFromSets(tic: number, confirmed: Set<number>, toi: Set<number>, confirmedScanned: number, toiScanned: number): NoveltyResult {
  return { inConfirmed: confirmed.has(tic), inToi: toi.has(tic), confirmedScanned, toiScanned };
}

/** Binds "which catalog data" to every number we report, so a re-run can be checked for drift (roadmap item 7). */
export interface CatalogStamp {
  confirmedScanned: number;
  toiScanned: number;
  confirmedSource: string;
  toiSource: string;
  asOfUtc: string;
}

export function makeCatalogStamp(p: { confirmedScanned: number; toiScanned: number; confirmedSource: string; toiSource: string; nowMs?: number }): CatalogStamp {
  return {
    confirmedScanned: p.confirmedScanned,
    toiScanned: p.toiScanned,
    confirmedSource: p.confirmedSource,
    toiSource: p.toiSource,
    asOfUtc: new Date(p.nowMs ?? Date.now()).toISOString(),
  };
}

// ---------- orchestration (dependency-injected, logic testable offline) ----------

export interface ReviewDeps {
  confirmedTics: () => Promise<{ tics: Set<number>; scanned: number; source: string }>;
  toiTics: () => Promise<{ tics: Set<number>; scanned: number; source: string }>;
  gaiaById: (sourceId: string) => Promise<GaiaSource | null>;
  gaiaNeighborhood: (ra: number, dec: number) => Promise<GaiaSource[]>;
  lightCurves: (tic: number, sectors: number[], label: string) => Promise<LightCurve[]>;
  runBls: (lc: LightCurve) => BLSResult;
  /**
   * Optional unified-significance channel (roadmap item 6). When provided, each audited path also reports an
   * empirical FAP calibrated against THIS target's own noise color, so our box-SNR is expressed on a
   * probability scale comparable across detectors -- not just a raw SNR that cannot be lined up with
   * someone else's SDE. Left undefined in offline tests; the p16 CLI wires src/detect/significance.
   */
  calibratedSignificance?: (lc: LightCurve, observedSnr: number, periodDays: number) => { fap: number; rho: number };
  nowMs?: number;
}

export interface HostInfo {
  ra: number;
  dec: number;
  gmag: number;
  ruwe: number;
  parallaxMas: number;
  distancePc: number;
  distanceLy: number;
  astrometryClean: boolean;
}

export interface DetectionPathAudit {
  tag: string;
  dataAvailable: boolean;
  nPoints: number;
  spanDays: number;
  cadenceMin: number;
  blsPeakPeriod: number;
  blsPeakSnr: number;
  blsPeakDepthPpm: number;
  rank: RankResult | null;
  fap?: number; // empirical false-alarm probability of the peak (when calibratedSignificance supplied)
  rho?: number; // measured lag-1 noise color the FAP was calibrated against
}

export interface ReviewReport {
  label: string;
  tic: number;
  claim: CandidateClaim;
  novelty: NoveltyResult;
  host: HostInfo | null;
  dilution: DilutionResult | null;
  blend: BlendRisk | null;
  detection: DetectionPathAudit[];
  corroborated: boolean;
  geometry: GeometryResult;
  detectability: Detectability;
  catalogStamp: CatalogStamp;
  notes: string[];
}

function medianCadenceMin(lc: LightCurve): number {
  const p = lc.points;
  const d: number[] = [];
  for (let i = 1; i < p.length; i++) d.push(p[i].time - p[i - 1].time);
  d.sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] * 1440 : NaN; // time is in days -> minutes
}

function toHost(g: GaiaSource): HostInfo {
  const distancePc = distancePcFromParallax(g.parallax);
  return {
    ra: g.ra,
    dec: g.dec,
    gmag: g.gmag,
    ruwe: g.ruwe,
    parallaxMas: g.parallax,
    distancePc,
    distanceLy: distancePc * 3.26156,
    astrometryClean: Number.isFinite(g.ruwe) && g.ruwe < 1.2,
  };
}

/**
 * Run the full independent audit for ONE claim. Every external channel is wrapped so a failure
 * degrades to `null` with a note rather than throwing -- an offline or rate-limited run still emits
 * the parts it could compute (geometry and detectability are always available; they need no network).
 */
export async function reviewExternalCandidate(claim: CandidateClaim, deps: ReviewDeps): Promise<ReviewReport> {
  const notes: string[] = [];

  const confirmed = await deps.confirmedTics().catch((e) => { notes.push(`confirmed-list unavailable: ${e instanceof Error ? e.message : e}`); return { tics: new Set<number>(), scanned: -1, source: "error" }; });
  const toi = await deps.toiTics().catch((e) => { notes.push(`TOI list unavailable: ${e instanceof Error ? e.message : e}`); return { tics: new Set<number>(), scanned: -1, source: "error" }; });
  const novelty = noveltyFromSets(claim.tic, confirmed.tics, toi.tics, confirmed.scanned, toi.scanned);

  let host: HostInfo | null = null;
  let dilution: DilutionResult | null = null;
  let blend: BlendRisk | null = null;
  try {
    const g = await deps.gaiaById(claim.gaiaSourceId);
    if (g) {
      host = toHost(g);
      try {
        const neigh = await deps.gaiaNeighborhood(g.ra, g.dec);
        // Exclude the host by EXACT id (now reliable after the varchar cast fix) AND positionally, so a
        // precision-loss or a real co-located duplicate can never pollute the sum.
        const others = neigh.filter((s) => s.sourceId !== claim.gaiaSourceId && angularSepArcsec(g.ra, g.dec, s.ra, s.dec) > 0.5);
        dilution = dilutionFromNeighbors(g.gmag, g.ra, g.dec, others, 21);
        blend = blendRiskTier(dilution);
      } catch (e) { notes.push(`neighbourhood/dilution unavailable: ${e instanceof Error ? e.message : e}`); }
    } else notes.push(`no Gaia row for source_id ${claim.gaiaSourceId}`);
  } catch (e) { notes.push(`Gaia host query failed: ${e instanceof Error ? e.message : e}`); }

  const detection: DetectionPathAudit[] = [];
  let corroborated = false;
  try {
    const lcs = await deps.lightCurves(claim.tic, claim.sectors, claim.label);
    if (lcs.length === 0) {
      notes.push("no light curve via our token-free channel -> blind re-detection skipped");
    } else {
      // Path 1: naive stitched multi-season. Path 2: the single longest sector. We rank the CLAIMED
      // period in our OWN full-grid power; his ephemeris never steers the search.
      const stitched = stitchLocal(lcs) ?? lcs[0];
      const one = lcs.reduce((a, x) => (x.points.length > a.points.length ? x : a));
      for (const [tag, lc] of [["stitched multi-season", stitched], ["longest single sector", one]] as [string, LightCurve][]) {
        if (!lc || lc.points.length < 50) continue;
        const b = deps.runBls(lc);
        const rank = periodPowerRank(b.periodGrid, claim.periodDays);
        const spanDays = lc.points.length ? lc.points[lc.points.length - 1].time - lc.points[0].time : 0;
        const audit: DetectionPathAudit = { tag, dataAvailable: true, nPoints: lc.points.length, spanDays, cadenceMin: medianCadenceMin(lc), blsPeakPeriod: b.periodDays, blsPeakSnr: b.snr, blsPeakDepthPpm: b.depth * 1e6, rank };
        if (deps.calibratedSignificance) {
          try {
            const sig = deps.calibratedSignificance(lc, b.snr, b.periodDays);
            audit.fap = sig.fap;
            audit.rho = sig.rho;
          } catch {
            /* significance is an enhancement; its failure must not void the whole audit */
          }
        }
        detection.push(audit);
        if (rank?.isGlobalPeak) corroborated = true;
      }
    }
  } catch (e) { notes.push(`blind re-detection failed: ${e instanceof Error ? e.message : e}`); }

  const geometry = impliedGeometry(claim);
  const cadenceMin = detection.length ? detection[0].cadenceMin : 30; // SPOC FFI default when no data fetched
  const detectability = detectabilityFloor(claim.depthPpm, claim.t14Hours, cadenceMin);

  return {
    label: claim.label,
    tic: claim.tic,
    claim,
    novelty,
    host,
    dilution,
    blend,
    detection,
    corroborated,
    geometry,
    detectability,
    catalogStamp: makeCatalogStamp({ confirmedScanned: confirmed.scanned, toiScanned: toi.scanned, confirmedSource: confirmed.source, toiSource: toi.source, nowMs: deps.nowMs }),
    notes,
  };
}

/**
 * Local multi-sector stitch (per-sector median normalise, sort by time, de-duplicate). Kept here so
 * the review library has no dependency on the S3 module's runtime; the identical algorithm is unit-
 * tested in tests/stitchSectors.test.ts against the production stitchLightCurves.
 */
function stitchLocal(lcs: LightCurve[]): LightCurve | null {
  const all: { time: number; flux: number }[] = [];
  for (const lc of lcs) {
    const pts = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
    if (pts.length < 20) continue;
    const sorted = [...pts.map((p) => p.flux)].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    for (const p of pts) all.push({ time: p.time, flux: p.flux / med });
  }
  if (all.length < 50) return null;
  all.sort((a, b) => a.time - b.time);
  const out: typeof all = [];
  for (const pt of all) if (!out.length || pt.time !== out[out.length - 1].time) out.push(pt);
  return { ...lcs[0], points: out.map((pt) => ({ time: pt.time, flux: pt.flux })) };
}
