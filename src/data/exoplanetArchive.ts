// data-fetch seat: NASA Exoplanet Archive TAP client.
// Pulls REAL confirmed-planet parameters (period, depth, duration, radius) used to
// (a) seed realistic injection-recovery trials and (b) serve as the ground-truth
// catalog mission-critic cross-matches candidates against.
// Falls back to a small bundled catalog if the network is unavailable, so the
// pipeline is provable offline (clearly labeled as fallback).

import type { ArchivePlanet } from "../core/types.ts";
import { PSOMPPARS_COLUMNS } from "./dataTier.ts";

const TAP_SYNC = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";

// Some WAFs intermittently 403 the default `node` user-agent; send a browser UA.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Well-known bright transiting planets (real catalog values) for offline fallback. */
const FALLBACK_CATALOG: ArchivePlanet[] = [
  { pl_name: "pi Men c", hostname: "pi Men", pl_orbper: 6.2679, pl_trandep: 1058, pl_trandur: 2.62, pl_rade: 2.04, st_rad: 0.96, st_mass: 0.99, sy_tmag: 5.65, discoverymethod: "Transit" },
  { pl_name: "HD 189733 b", hostname: "HD 189733", pl_orbper: 2.21857, pl_trandep: 2830, pl_trandur: 2.82, pl_rade: 12.64, st_rad: 0.79, st_mass: 0.8, sy_tmag: 7.44, discoverymethod: "Transit" },
  { pl_name: "WASP-121 b", hostname: "WASP-121", pl_orbper: 1.27492, pl_trandep: 9140, pl_trandur: 2.48, pl_rade: 19.2, st_rad: 1.46, st_mass: 1.35, sy_tmag: 10.29, discoverymethod: "Transit" },
  { pl_name: "HAT-P-11 b", hostname: "HAT-P-11", pl_orbper: 4.8878, pl_trandep: 388, pl_trandur: 1.72, pl_rade: 4.36, st_rad: 0.68, st_mass: 0.82, sy_tmag: 8.99, discoverymethod: "Transit" },
  { pl_name: "GJ 1214 b", hostname: "GJ 1214", pl_orbper: 1.5804, pl_trandep: 1450, pl_trandur: 0.95, pl_rade: 2.74, st_rad: 0.22, st_mass: 0.15, sy_tmag: 9.75, discoverymethod: "Transit" },
  { pl_name: "KELT-9 b", hostname: "KELT-9", pl_orbper: 1.4811, pl_trandep: 7000, pl_trandur: 3.32, pl_rade: 21.0, st_rad: 2.37, st_mass: 2.36, sy_tmag: 7.56, discoverymethod: "Transit" },
  { pl_name: "TOI-700 d", hostname: "TOI-700", pl_orbper: 37.42, pl_trandep: 760, pl_trandur: 1.7, pl_rade: 1.07, st_rad: 0.42, st_mass: 0.2, sy_tmag: 11.8, discoverymethod: "Transit" },
  { pl_name: "L 168-9 b", hostname: "L 168-9", pl_orbper: 1.4017, pl_trandep: 3900, pl_trandur: 1.2, pl_rade: 1.39, st_rad: 0.45, st_mass: 0.4, sy_tmag: 10.0, discoverymethod: "Transit" },
  { pl_name: "WASP-126 b", hostname: "WASP-126", pl_orbper: 3.28883, pl_trandep: 7005.7, pl_trandur: 3.43677, pl_tranmid: 2458827.4162, pl_rade: 10.5136, st_rad: 1.27, st_mass: 1.12, sy_tmag: 10.61, discoverymethod: "Transit" },
];

export interface ArchiveQueryOptions {
  maxTmag?: number; // TESS magnitude brightness cut (smaller = brighter)
  limit?: number; // max rows (uses ADQL TOP)
  minPeriodDays?: number;
  maxPeriodDays?: number;
  timeoutMs?: number;
  /**
   * Restrict the RESULT to rows that carry a TESS Input Catalog id (pscomppars
   * `tic_id`). Used by autonomous mode so every queued target is eligible for
   * the token-free TESS-SPOC public-S3 photometry tier. The filter runs
   * client-side (the WAF rejects an SQL `is not null` clause), so the default
   * query string and its deterministic ordering stay byte-for-byte unchanged.
   */
  requireTic?: boolean;
}

export interface ArchiveFetchResult {
  planets: ArchivePlanet[];
  source: "nasa-tap" | "fallback";
  query?: string;
  error?: string;
}

/**
 * Return the bundled offline catalog (real values for well-known bright
 * transiting planets), filtered to the requested period range. Used as the
 * network fallback and by the orchestrator's --offline mode.
 */
export function getFallbackCatalog(o: ArchiveQueryOptions = {}): ArchiveFetchResult {
  const limit = o.limit ?? 50;
  const planets = FALLBACK_CATALOG.filter(
    (p) =>
      (o.minPeriodDays == null || (p.pl_orbper ?? 0) >= o.minPeriodDays) &&
      (o.maxPeriodDays == null || (p.pl_orbper ?? 999) <= o.maxPeriodDays) &&
      (o.maxTmag == null || (p.sy_tmag ?? 99) < o.maxTmag),
  ).slice(0, limit);
  return { planets, source: "fallback" };
}

/** Parse a pscomppars `tic_id` string like "TIC 441462736" into a number. */
function parseTicId(value: unknown): number | undefined {
  if (value == null) return undefined;
  const digits = String(value).replace(/[^0-9]/g, "");
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}

/** Fetch confirmed transiting planets from the NASA Exoplanet Archive (pscomppars). */
export async function fetchConfirmedPlanets(o: ArchiveQueryOptions = {}): Promise<ArchiveFetchResult> {
  const maxTmag = o.maxTmag ?? 11;
  const limit = o.limit ?? 50;
  // The requested columns come from the single schema-contract constant (src/data/dataTier.ts) that
  // tests/schemaContract.test.ts pins, so a field we read can never drift from a field we request.
  const cols = PSOMPPARS_COLUMNS.join(",");
  // NOTE: NASA's Cloudflare WAF 403s queries with spaces around comparison
  // operators or `is not null`; keep the WHERE compact and filter nulls in JS.
  let where = `discoverymethod='Transit' and sy_tmag<${maxTmag}`;
  if (o.minPeriodDays != null) where += ` and pl_orbper>=${o.minPeriodDays}`;
  if (o.maxPeriodDays != null) where += ` and pl_orbper<=${o.maxPeriodDays}`;
  const query = `select ${cols} from pscomppars where ${where}`;
  const url = `${TAP_SYNC}?query=${encodeURIComponent(query)}&format=json`;

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 30000);
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (!r.ok) throw new Error(`TAP HTTP ${r.status}`);
      const all = (await r.json()) as ArchivePlanet[];
      if (!Array.isArray(all) || all.length === 0) throw new Error("empty result");
      const rows = all
        .filter((p) => p.pl_orbper != null && p.sy_tmag != null)
        // pscomppars reports pl_trandep in PERCENT of stellar brightness; the bundled
        // fallback catalog and every downstream consumer use PPM. Normalize once here
        // so both sources share one unit (0.7% -> 7000ppm). Also lift the string
        // `tic_id` ("TIC 441462736") into the numeric `tic` used by the S3 tier.
        .map((p) => {
          const row: ArchivePlanet & { tic_id?: string } = { ...p };
          if (row.pl_trandep != null) row.pl_trandep = row.pl_trandep * 1e4;
          const tic = parseTicId(row.tic_id);
          if (tic != null) row.tic = tic;
          return row;
        });
      // DETERMINISTIC ORDER (audit-6 follow-up). Sorting by sy_tmag alone leaves every planet of the SAME
      // host tied -- they share a stellar magnitude -- and Array#sort is stable, so tied rows kept whatever
      // order the TAP query happened to return. The SQL carries no ORDER BY (NASA's WAF rejects the clauses
      // we would need), so that order is not guaranteed. Two runs over an UNCHANGED catalog therefore
      // emitted the same rows in a different order. That is not cosmetic here: it churns the bytes of every
      // report that lists per-planet rows, and a byte-churned report invalidates the sha256 stamps that
      // downstream reports record for it, so the report-freshness gate flapped a report stale whose inputs
      // had not actually changed (observed on p60: HR 858 c/d and HD 25463 b/c swapping between runs).
      // Tie-breaking on pl_name then pl_orbper makes the order a pure function of the content.
      //
      // The comparison is plain code-unit, NOT localeCompare: locale-aware collation depends on the ICU
      // data of whichever machine ran it, which would trade one platform-dependent order for another.
      const byName = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
      rows.sort(
        (a, b) =>
          (a.sy_tmag ?? 99) - (b.sy_tmag ?? 99) ||
          byName(String(a.pl_name ?? ""), String(b.pl_name ?? "")) ||
          (a.pl_orbper ?? 0) - (b.pl_orbper ?? 0),
      );
      // Autonomous mode keeps only TIC-bearing rows (client-side: the WAF
      // rejects an SQL `is not null` clause). Nearly all TESS pscomppars rows
      // carry a tic_id, so a slightly deeper slice before filtering is enough.
      const kept = o.requireTic ? rows.filter((p) => Number.isFinite(p.tic)) : rows;
      return { planets: kept.slice(0, limit), source: "nasa-tap", query };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1))); // backoff
    } finally {
      clearTimeout(timer);
    }
  }
  const fb = getFallbackCatalog(o);
  return { planets: fb.planets, source: "fallback", query, error: lastErr };
}

/**
 * Cross-match a candidate period against known planets (optionally of one host).
 * Returns the closest known planet within tolerance, or null.
 */
export function crossmatchPeriod(
  candidatePeriodDays: number,
  catalog: ArchivePlanet[],
  hostName?: string,
  tolPct = 2,
): ArchivePlanet | null {
  const pool = hostName ? catalog.filter((p) => p.hostname === hostName) : catalog;
  let best: ArchivePlanet | null = null;
  let bestErr = Infinity;
  for (const p of pool) {
    if (p.pl_orbper == null) continue;
    // allow harmonic matches (candidate may be P/2, P/3, P/4 etc.). 4 and 1/4 added after an audit: a live
    // finding (F-TOI-1860-b) sat at x4 of a catalogued planet and was mis-read as "no catalog match". This can
    // only ever RECLASSIFY a candidate as a probable alias (needs-more-data); acceptance still requires harmonic
    // ===1 in review.ts, so the accepted / money-path set can never grow from a wider harmonic net.
    for (const f of [1, 2, 0.5, 3, 1 / 3, 4, 1 / 4]) {
      const err = Math.abs(candidatePeriodDays * f - p.pl_orbper) / p.pl_orbper;
      if (err < bestErr) {
        bestErr = err;
        best = p;
      }
    }
  }
  return best != null && bestErr <= tolPct / 100 ? best : null;
}

/**
 * Targeted per-host cross-match lookup (audit #5: the crossmatch tri-state).
 *
 * WHY. The bulk slice from fetchConfirmedPlanets is magnitude-limited, so a candidate can miss a planet that IS
 * announced for its own host simply because that host fell outside the slice -- and the old `cat?.planets ?? []`
 * path made a FAILED fetch indistinguishable from a genuinely-empty catalog, so a network error read as "novel".
 * This resolves the two states the slice cannot:
 *   []               -> the lookup COMPLETED and the archive announces NO confirmed planet for this host (a real
 *                       "novel in the authoritative per-host view", not a silent miss);
 *   ArchivePlanet[]  -> confirmed planets announced for this host (so a match OUTSIDE the bulk slice is caught);
 *   null             -> the lookup FAILED (HTTP / timeout / transport): "no match" MUST NOT be read as novel.
 *
 * Returns normalized rows (pl_trandep in ppm, numeric `tic`) exactly like the bulk fetch, so a downstream
 * crossmatchPeriod sees one unit. Never throws; failure is the `null` signal.
 */
export async function fetchPlanetsByHost(
  hostname: string,
  o: { timeoutMs?: number } = {},
): Promise<ArchivePlanet[] | null> {
  if (!hostname) return null;
  const cols = PSOMPPARS_COLUMNS.join(",");
  const safeHost = hostname.replace(/'/g, "''"); // SQL single-quote escape
  const query = `select ${cols} from pscomppars where hostname='${safeHost}'`;
  const url = `${TAP_SYNC}?query=${encodeURIComponent(query)}&format=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 20000);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) throw new Error(`TAP HTTP ${r.status}`);
      const all = (await r.json()) as ArchivePlanet[];
      if (!Array.isArray(all)) return []; // completed, no rows -> nothing announced
      return all.map((p) => {
        const row: ArchivePlanet & { tic_id?: string } = { ...p };
        if (row.pl_trandep != null) row.pl_trandep = row.pl_trandep * 1e4;
        const tic = parseTicId(row.tic_id);
        if (tic != null) row.tic = tic;
        return row;
      });
    } catch (e) {
      if (attempt === 2) return null; // transport/HTTP failed -> the "lookup-failed" state
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
