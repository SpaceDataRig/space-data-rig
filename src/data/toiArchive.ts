// data-fetch seat (discovery tier): NASA Exoplanet Archive TOI client.
//
// The TOI (TESS Objects of Interest) table holds CANDIDATE transits that are NOT yet confirmed
// planets -- exactly the population a blind/discovery mode should target. This is deliberately a
// SEPARATE source from fetchConfirmedPlanets (pscomppars = known planets, used for the archive
// re-validation runs); here the ephemeris in the table is treated only as a REFERENCE to
// cross-match against AFTER our detector has run blind on real photometry. We never inject the
// TOI period into detection -- independent recovery is the whole point.
//
// Verified live schema (read-only probe against exoplanetarchive TAP, table `toi`):
//   tid          -> the host TESS Input Catalog id (== TIC; confirmed via ctoi_alias "<tid>.<cn>")
//   toidisplay   -> "TOI-1234.01" label;  st_tmag -> TESS magnitude
//   ra, dec      -> degrees
//   pl_orbper    -> days;  pl_tranmid -> BJD;  pl_trandurh -> HOURS (note the 'h')
//   pl_trandep   -> PARTS PER MILLION in this table (pscomppars uses percent -> do NOT rescale)
//   pl_rade      -> planet radius (R_earth);  st_rad -> star radius (R_sun)
//   sectors      -> is NULL in `toi`; the covering sector is resolved from ra/dec via sectorsForCoord
// The Cloudflare WAF in front of the Archive 403s `is not null` and spaces around operators, so the
// WHERE stays compact (only a numeric st_tmag comparison) and all null/edge filtering happens here.

import type { ArchivePlanet } from "../core/types.ts";
import { fetchConfirmedPlanets } from "./exoplanetArchive.ts";

const TAP_SYNC = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface TocCandidate {
  toidisplay: string;
  tic: number;
  ra: number;
  dec: number;
  tmag: number;
  /** Reference orbital period from the TOI pipeline (used ONLY to cross-match a blind detection). */
  periodDays: number;
  /** Reference mid-transit epoch (BJD). */
  epochBjd: number;
  /** Reported transit duration in HOURS. */
  durationHours: number;
  /** Reported depth in PPM (already ppm in the `toi` table). */
  depthPpm: number;
  planetRadiusEarth: number;
  starRadiusSun: number;
}

export interface TocQueryOptions {
  maxTmag?: number;
  limit?: number;
  /** Drop hosts already present in the confirmed (pscomppars) catalog -> a truly unconfirmed pool. */
  excludeConfirmedHosts?: boolean;
  timeoutMs?: number;
}

export interface TocFetchResult {
  candidates: TocCandidate[];
  source: "nasa-tap" | "fallback";
  query?: string;
  error?: string;
}

function num(v: unknown): number {
  // null/empty in TAP JSON means "no value" -- treat as NaN, NOT the JS Number(null)===0 coercion,
  // which would silently admit TOI rows with a missing period/epoch as if they were valid.
  if (v == null || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Pure row -> candidate mapper. Rows missing a usable blind-detection target (no TIC, coords, or
 * reference period/epoch) are dropped. Depth is taken AS-IS in ppm. Exported and unit-tested with a
 * captured real schema so the parser is provable offline (CI has no network).
 */
export function mapTocRows(rows: Record<string, unknown>[]): TocCandidate[] {
  const out: TocCandidate[] = [];
  for (const r of rows) {
    const tic = num(r.tid);
    const ra = num(r.ra);
    const dec = num(r.dec);
    const periodDays = num(r.pl_orbper);
    const epochBjd = num(r.pl_tranmid);
    if (!Number.isFinite(tic) || !Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(periodDays) || !Number.isFinite(epochBjd)) {
      continue;
    }
    out.push({
      toidisplay: String(r.toidisplay ?? r.toi ?? `TOI-${tic}`),
      tic,
      ra,
      dec,
      tmag: num(r.st_tmag),
      periodDays,
      epochBjd,
      durationHours: num(r.pl_trandurh),
      depthPpm: num(r.pl_trandep),
      planetRadiusEarth: num(r.pl_rade),
      starRadiusSun: num(r.st_rad),
    });
  }
  return out;
}

/** Small real (probe-captured) fallback so --offline and CI have a labeled, non-network path. */
const FALLBACK_TOI: TocCandidate[] = [
  { toidisplay: "TOI-1011.01", tic: 114018671, ra: 113.984761, dec: -32.841999, tmag: 8.2388, periodDays: 2.4705036, epochBjd: 2460715.898893, durationHours: 2.3513472, depthPpm: 273.0272045, planetRadiusEarth: 1.44656, starRadiusSun: 0.94 },
  { toidisplay: "TOI-1008.01", tic: 440801822, ra: 109.382839, dec: 13.395219, tmag: 8.9362, periodDays: 2.0483755, epochBjd: 2460258.236122, durationHours: 2.767, depthPpm: 483, planetRadiusEarth: 3.19621, starRadiusSun: 1.57 },
  { toidisplay: "TOI-1007.01", tic: 65212867, ra: 112.752393, dec: -4.463359, tmag: 8.87759, periodDays: 6.9989206, epochBjd: 2459247.930695, durationHours: 3.953, depthPpm: 2840, planetRadiusEarth: 14.7752, starRadiusSun: 2.7 },
];

export function getFallbackToc(o: TocQueryOptions = {}): TocFetchResult {
  const limit = o.limit ?? 8;
  return { candidates: FALLBACK_TOI.filter((c) => o.maxTmag == null || c.tmag < o.maxTmag).slice(0, limit), source: "fallback" };
}

/** Fetch UNCONFIRMED candidate-transit targets from the Archive `toi` table. */
export async function fetchTocCandidates(o: TocQueryOptions = {}): Promise<TocFetchResult> {
  const maxTmag = o.maxTmag ?? 10.5;
  const limit = o.limit ?? 12;
  const cols =
    "tid,toipfx,toidisplay,st_tmag,ra,dec,pl_orbper,pl_tranmid,pl_trandurh,pl_trandep,pl_rade,st_rad";
  const query = `select ${cols} from toi where st_tmag<${maxTmag}`;
  const url = `${TAP_SYNC}?query=${encodeURIComponent(query)}&format=json`;

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 30000);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) throw new Error(`TOI TAP HTTP ${r.status}`);
      const raw = (await r.json()) as Record<string, unknown>[];
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty result");
      let cands = mapTocRows(raw);
      cands.sort((a, b) => (a.tmag ?? 99) - (b.tmag ?? 99));
      if (o.excludeConfirmedHosts) {
        // Remove hosts we already KNOW to transit (pscomppars carries a numeric tic via fetchConfirmedPlanets).
        // A TOI whose host also appears as a confirmed planet is not an unconfirmed target.
        const confirmed = await fetchConfirmedHostTics(o.timeoutMs);
        cands = cands.filter((c) => !confirmed.has(c.tic));
      }
      if (cands.length === 0) throw new Error("no usable TOI rows after mapping");
      return { candidates: cands.slice(0, limit), source: "nasa-tap", query };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  const fb = getFallbackToc(o);
  return { candidates: fb.candidates, source: "fallback", query, error: lastErr };
}

/** Numeric set of host TICs that already have a confirmed planet (for the unconfirmed filter). */
async function fetchConfirmedHostTics(timeoutMs?: number): Promise<Set<number>> {
  const set = new Set<number>();
  try {
    const res = await fetchConfirmedPlanetsTicList(timeoutMs);
    for (const t of res) set.add(t);
  } catch {
    /* best-effort: if the confirmed list is unavailable, keep the full TOI pool */
  }
  return set;
}

async function fetchConfirmedPlanetsTicList(timeoutMs?: number): Promise<number[]> {
  const { planets } = await fetchConfirmedPlanets({ maxTmag: 13, limit: 5000, requireTic: true, timeoutMs });
  const out: number[] = [];
  for (const p of planets as ArchivePlanet[]) if (Number.isFinite(p.tic)) out.push(p.tic!);
  return out;
}
