// CANDIDATE PRIORITIZATION + OBSERVABILITY (discovery roadmap, Stage 3).
//
// WHAT THIS DOES. Once Stage 2's depth screen and the novelty gate have trimmed a blind search down to
// surviving CANDIDATES, a follow-up team still has to choose where to point scarce telescope time. This
// module ranks candidates by two honest axes: (1) how much evidence supports a real planet, and (2) how
// observable the NEXT transit is from a reference ground site -- computed with standard positional
// astronomy, not a guess. It never re-labels a candidate's Stage-2 tier and never adds a discovery claim;
// it only orders candidates by "worth pointing at, and pointable at".
//
// HONESTY. Any input that is not measured (NaN depth, no duration, no brightness) contributes NEUTRALLY and
// is named in `factors` -- an undetermined axis can neither boost nor silently sink a score. Weights are a
// documented, adjustable starting heuristic, not a physical constant. Observability is from ONE site; a
// global network covers targets that set below its horizon, so a low altitude flags a caveat, not a veto.
//
// PURE + DI + RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash / money
// path. Deterministic for a fixed (record, nowBjd, site).

import type { CandidateRecord } from "./candidateRecord.ts";

export interface ObserveSite {
  name: string;
  latitudeDeg: number;
  longitudeDegEast: number; // east positive
}

/** A real northern observatory; used only as a reference vantage point, clearly labelled in the card. */
export const DEFAULT_SITE: ObserveSite = { name: "Maunakea (reference site)", latitudeDeg: 19.8264, longitudeDegEast: -155.4743 };

const MIN_OBSERVABLE_ALT_DEG = 20; // below this the atmosphere/airmass makes follow-up hard from one site

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Barycentric Julian Date (BJD_TDB, ~2457000 scale) -> full Julian Date for UT-side astronomy. */
export function bjdToJd(bjd: number): number {
  return bjd + 2400000.5;
}

/** Greenwich Mean Sidereal Time in DEGREES from a (UT) Julian Date. Standard low-precision formula. */
export function gmstDeg(jdUt: number): number {
  const d = jdUt - 2451545.0;
  const g = 280.46061837 + 360.98564736629 * d;
  return ((g % 360) + 360) % 360;
}

/**
 * Altitude (degrees above the horizon) of a target at a given BJD from a site. Uses the hour-angle
 * formula sin(alt) = sin(lat)sin(dec) + cos(lat)cos(dec)cos(H). Verifiable limits: a target on the
 * observer's meridian at the same declination as the latitude is overhead (90 deg); the celestial
 * equator sits at altitude 0 as seen from a geographic pole.
 */
export function altitudeAtDeg(raDeg: number, decDeg: number, bjd: number, site: ObserveSite): number {
  const lstDeg = (gmstDeg(bjdToJd(bjd)) + site.longitudeDegEast + 360) % 360;
  const hourAngleDeg = ((lstDeg - raDeg + 540) % 360) - 180; // wrap to [-180,180)
  const lat = (site.latitudeDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const ha = (hourAngleDeg * Math.PI) / 180;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const altRad = Math.asin(Math.min(1, Math.max(-1, sinAlt)));
  return (altRad * 180) / Math.PI;
}

/** Smallest t0 + k*period that is >= nowBjd (k an integer); NaN if inputs are unusable. */
export function nextTransitBjdAfter(epochBjd: number, periodDays: number, nowBjd: number): number {
  if (!Number.isFinite(epochBjd) || !Number.isFinite(periodDays) || periodDays <= 0 || !Number.isFinite(nowBjd)) return NaN;
  const k = Math.ceil((nowBjd - epochBjd) / periodDays - 1e-9);
  return epochBjd + k * periodDays;
}

export interface PriorityResult {
  tier: CandidateRecord["tier"];
  nextTransitBjd: number;
  daysUntilNext: number;
  altitudeAtMidTransitDeg: number | null;
  observableFromSite: boolean;
  priorityScore: number; // 0..1
  priorityBand: "high" | "medium" | "low" | "not-rankable";
  factors: string[]; // every input that moved (or could not move) the score, named honestly
}

export interface Weights {
  evidence: number;
  imminence: number;
  observability: number;
}

/** Documented starting weights (evidence matters most; a soon, up-in-the-sky transit makes follow-up real). */
export const DEFAULT_WEIGHTS: Weights = { evidence: 0.5, imminence: 0.3, observability: 0.2 };

function evidenceFactor(r: CandidateRecord, factors: string[]): number {
  // SNR and brightness are the two follow-up-relevant measures we usually have. Missing ones stay neutral.
  let sum = 0;
  let used = 0;
  const snr = r.detection.snr;
  if (Number.isFinite(snr)) {
    sum += clamp01((snr - 7) / 23); // 7 (the detection gate) -> 0, 30+ -> full marks
    used++;
  } else factors.push("SNR not measured -> evidence contribution neutral.");
  const mag = r.host.tmag;
  if (Number.isFinite(mag)) {
    sum += clamp01((13 - mag) / 6); // bright (<=7) -> 1, faint (>=13) -> 0; brighter is easier to follow up
    used++;
  } else factors.push("TESS magnitude missing -> evidence contribution neutral.");
  if (r.tier === "moderate") {
    sum += 0.5;
    used++;
  } else if (r.tier === "high") {
    sum += 1;
    used++;
  } else {
    factors.push(`tier '${r.tier}' carries no positive evidence credit in the follow-up score.`);
  }
  return used ? sum / used : 0.5;
}

/**
 * Rank one surviving candidate for follow-up. Returns "not-rankable" (score 0) for a signal the pipeline
 * rejected as not planetary or not novel -- there is nothing to point at. Every other case gets a score in
 * [0,1] built only from measured inputs, with undetermined axes named in `factors`.
 */
export function prioritize(r: CandidateRecord, nowBjd: number, site: ObserveSite = DEFAULT_SITE, w: Weights = DEFAULT_WEIGHTS): PriorityResult {
  const factors: string[] = [];

  if (r.tier === "not-planetary" || r.tier === "not-novel") {
    return {
      tier: r.tier, nextTransitBjd: NaN, daysUntilNext: NaN, altitudeAtMidTransitDeg: null, observableFromSite: false,
      priorityScore: 0, priorityBand: "not-rankable",
      factors: [`excluded from follow-up ranking: tier '${r.tier}' (${r.tier === "not-planetary" ? "too deep to be a planet" : "already known"}).`],
    };
  }

  const next = nextTransitBjdAfter(r.detection.epochBjd, r.detection.periodDays, nowBjd);
  const days = Number.isFinite(next) ? next - nowBjd : NaN;
  if (!Number.isFinite(next)) factors.push("epoch/period unusable -> cannot predict a next transit; imminence and observability neutral.");

  let alt: number | null = null;
  let observable = false;
  if (Number.isFinite(r.host.ra) && Number.isFinite(r.host.dec) && Number.isFinite(next)) {
    alt = altitudeAtDeg(r.host.ra, r.host.dec, next, site);
    observable = alt >= MIN_OBSERVABLE_ALT_DEG;
    factors.push(`mid-transit altitude ${alt.toFixed(1)} deg at ${site.name}${observable ? " (well placed)" : ` (below ${MIN_OBSERVABLE_ALT_DEG} deg -- a different site or network is needed).`}`);
  } else {
    factors.push("no usable position/ephemeris -> observability neutral.");
  }

  const evidence = evidenceFactor(r, factors);
  const imminence = Number.isFinite(days) ? clamp01(1 - days / 180) : 0.5; // within ~6 months is actionable
  const observability = alt == null ? 0.5 : clamp01((alt - MIN_OBSERVABLE_ALT_DEG) / 60);

  const score = clamp01((w.evidence * evidence + w.imminence * imminence + w.observability * observability) / (w.evidence + w.imminence + w.observability));
  const band = score >= 0.66 ? "high" : score >= 0.33 ? "medium" : "low";

  return {
    tier: r.tier,
    nextTransitBjd: next,
    daysUntilNext: days,
    altitudeAtMidTransitDeg: alt == null ? null : alt,
    observableFromSite: observable,
    priorityScore: Math.round(score * 100) / 100,
    priorityBand: band,
    factors,
  };
}

/** Render a Stage-3 follow-up card: the Stage-0 card plus the ranked observability verdict. */
export function formatPriorityCard(r: CandidateRecord, p: PriorityResult): string {
  const lines: string[] = [];
  lines.push(`Follow-up priority: ${p.priorityBand} (score ${p.priorityScore.toFixed(2)})   [candidate, not a discovery claim]`);
  if (Number.isFinite(p.nextTransitBjd)) lines.push(`Next transit: ${p.nextTransitBjd.toFixed(4)} BJD (in ${p.daysUntilNext.toFixed(2)} d)`);
  if (p.altitudeAtMidTransitDeg != null) lines.push(`Placement at mid-transit: ${p.altitudeAtMidTransitDeg.toFixed(1)} deg altitude from ${DEFAULT_SITE.name}`);
  lines.push("Ranking factors:");
  for (const f of p.factors) lines.push(`  - ${f}`);
  return lines.join("\n");
}
