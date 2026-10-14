// Token-free real TESS photometry from the AWS Registry of Open Data S3 bucket
// (runtime-agnostic: global fetch + the FITS reader in ./fits.ts only).
//
// Why this path exists (verified 2026-10-11 from a clean Cloudflare edge):
//   The TESS-SPOC pipeline publishes calibrated PDCSAP light curves for a large
//   set of short-period planets as FITS products in the public `stpubdata` S3
//   bucket. That bucket is anonymous-readable (no MAST token, no AWS account):
//   ListObjectsV2 and direct object GET both succeed without signing. The keys
//   are sharded by 4-digit sector and then by the 16-digit zero-padded TIC split
//   into four 4-digit groups, so a light-curve key is DETERMINISTIC given
//   (TIC, sector) -- no enumeration required. Confirmed by an anonymous download
//   that returned 200 + `SIMPLE` FITS bytes.
//
//   This is a genuinely independent alternative to the auth-gated CAOM Cone
//   service (see ./mastDiscover.ts, which is empty for anonymous callers) and to
//   the hand-curated product registry (./mastCurated.ts). It lets the pipeline
//   fetch REAL photometry for any SPOC target autonomously.
//
// Attribution: TESS-SPOC data are released under CC BY 4.0; please cite
//   Caldwell et al. 2020 (the TESS-SPOC program) when a curve originates here.
//
// Determinism red line: nothing in this module is invoked unless a caller opts
//   in (MAST_S3), and a missing/failed object resolves to null so the run falls
//   through to the existing stand-in -- the default synthetic hash is unchanged.

import { fitsToLightCurve } from "./mast.ts";
import type { LightCurve, LightCurvePoint } from "../core/types.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const SPOC_PREFIX = "mast/hlsp/tess-spoc";
const TESSCUT_SECTOR = "https://mast.stsci.edu/tesscut/api/v0.1/sector";

export interface SpocFetchOptions {
  /** per-request timeout in ms (edge downloads of a ~150 KB curve are fast). */
  timeoutMs?: number;
  /** injectable fetch for offline tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** 16-digit zero-padded TIC string, e.g. 1024880 -> "0000000001024880". */
export function formatTic16(tic: number): string {
  if (!Number.isFinite(tic) || tic < 0) throw new Error(`bad TIC: ${tic}`);
  return Math.trunc(tic).toString().padStart(16, "0");
}

/** Zero-padded 4-digit sector token, e.g. 4 -> "0004". */
function formatSector4(sector: number): string {
  if (!Number.isFinite(sector) || sector < 0) throw new Error(`bad sector: ${sector}`);
  return Math.trunc(sector).toString().padStart(4, "0");
}

/** The TIC-sharded directory under a sector's target/ tree, e.g. 0000/0000/0102/4880. */
export function spocTargetDir(tic: number): string {
  const t = formatTic16(tic);
  return `${t.slice(0, 4)}/${t.slice(4, 8)}/${t.slice(8, 12)}/${t.slice(12, 16)}`;
}

/**
 * Build the deterministic S3 object key for one SPOC product.
 * kind = "lc" (PDCSAP light curve, the default) or "tp" (target pixel file).
 * key = mast/hlsp/tess-spoc/s<SECT>/target/<4x4 groups>/hlsp_tess-spoc_tess_phot_<TIC16>-s<SECT>_tess_v1_<kind>.fits
 */
export function resolveSpocKey(tic: number, sector: number, kind: "lc" | "tp" = "lc"): string {
  const sect = formatSector4(sector);
  const t = formatTic16(tic);
  return `${SPOC_PREFIX}/s${sect}/target/${spocTargetDir(tic)}/hlsp_tess-spoc_tess_phot_${t}-s${sect}_tess_v1_${kind}.fits`;
}

/** Absolute (unsigned) HTTPS URL for an SPOC object key. */
export function spocObjectUrl(key: string): string {
  return `${S3_BASE}/${key}`;
}

/**
 * Which TESS sectors cover a sky position. Uses the token-free TESScut sector
 * service. Sector values are extracted defensively (any key named "sector") so
 * the parser survives response-shape changes. Returns [] on any failure so the
 * caller can fall through.
 */
export async function sectorsForCoord(ra: number, dec: number, opts: SpocFetchOptions = {}): Promise<number[]> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw new Error(`bad coordinates: ${ra},${dec}`);
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  const url = `${TESSCUT_SECTOR}?ra=${encodeURIComponent(ra.toFixed(6))}&dec=${encodeURIComponent(dec.toFixed(6))}`;
  try {
    const r = await doFetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    const json: unknown = await r.json();
    const found: number[] = [];
    collectSectors(json, found);
    return [...new Set(found)].sort((a, b) => a - b);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Recursively gather numeric values stored under any object key named "sector". */
function collectSectors(node: unknown, out: number[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectSectors(v, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.toLowerCase() === "sector") {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n) && n > 0) out.push(Math.trunc(n));
      } else {
        collectSectors(v, out);
      }
    }
  }
}

/**
 * Download one SPOC object anonymously. Best-effort: returns null for any
 * non-2xx (a target not in the SPOC program is a 404) or a non-FITS body, so a
 * miss never throws the pipeline out of its determinism guarantee.
 */
export async function fetchSpocBytes(key: string, opts: SpocFetchOptions = {}): Promise<Uint8Array | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
  try {
    const r = await doFetch(spocObjectUrl(key), {
      signal: controller.signal,
      headers: { Accept: "application/fits, application/octet-stream" },
    });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 2880) return null;
    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]);
    if (magic !== "SIMPLE") return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try (TIC, sector) combinations in order and return the first real PDCSAP light
 * curve that downloads and parses. Returns null if none resolve, letting the
 * caller fall through to the next tier. The `source` string carries the
 * uppercase marker the critic/truthSource discriminator looks for.
 */
export async function fetchSpocLightCurve(
  tic: number,
  sectors: number[],
  targetId: string,
  opts: SpocFetchOptions = {},
): Promise<LightCurve | null> {
  for (const sector of sectors) {
    const key = resolveSpocKey(tic, sector, "lc");
    const bytes = await fetchSpocBytes(key, opts);
    if (!bytes) continue;
    let lc: LightCurve;
    try {
      lc = fitsToLightCurve(bytes, targetId);
    } catch {
      continue;
    }
    lc.source =
      `TESS-SPOC PDCSAP product ${key.split("/").pop()} from public S3 (REAL photometry); ` +
      `CC BY 4.0, cite Caldwell et al. 2020`;
    return lc;
  }
  return null;
}

export interface SpocSectorFetcherOptions extends SpocFetchOptions {
  /** max concurrent sector downloads (default 4). */
  concurrency?: number;
}

/** The exact REAL-photometry label the critic truthSource discriminator looks for. */
function spocRealLabel(key: string): string {
  return `TESS-SPOC PDCSAP product ${key.split("/").pop()} from public S3 (REAL photometry); ` +
    `CC BY 4.0, cite Caldwell et al. 2020`;
}

/**
 * A first-class MULTI-SECTOR fetch helper for the multi-sector studies (p29/p41/p60/...), so pulling
 * every sector of a host is a single concurrent call rather than a hand-rolled sequential loop -- the
 * roadmap's "make multi-sector fetching a first-class citizen" item. It is purely ADDITIVE: a factory
 * returning a fetcher that holds its OWN per-key byte cache, so re-fetching a sector within one run is
 * free. Nothing in the production / edge path imports it, so the default run behaviour and bundle hash
 * are unchanged; callers opt in explicitly.
 */
export function createSpocSectorFetcher(opts: SpocSectorFetcherOptions = {}) {
  const byteCache = new Map<string, Promise<Uint8Array | null>>();
  // Lightweight telemetry so the roadmap can decide, on MEASURED evidence, whether the concurrent+cached
  // multi-sector helper is worth promoting toward production: cache-hit rate + estimated download time saved.
  let byteRequests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let missMsTotal = 0;
  const getBytes = async (key: string): Promise<Uint8Array | null> => {
    byteRequests++;
    const cached = byteCache.get(key);
    if (cached) { cacheHits++; return cached; }
    const t0 = Date.now();
    const p = fetchSpocBytes(key, opts);
    cacheMisses++;
    byteCache.set(key, p);
    try {
      const r = await p;
      missMsTotal += Date.now() - t0;
      return r;
    } catch (e) {
      missMsTotal += Date.now() - t0;
      throw e;
    }
  };
  /** Cumulative byte-fetch telemetry for this fetcher instance (per-key cache). */
  function fetchStats() {
    const meanMissMs = cacheMisses > 0 ? missMsTotal / cacheMisses : 0;
    return {
      byteRequests,
      cacheHits,
      cacheMisses,
      cacheHitRate: byteRequests > 0 ? cacheHits / byteRequests : 0,
      downloadMs: Math.round(missMsTotal),
      meanMissMs: Math.round(meanMissMs),
      // the download time a cache hit avoids; an ESTIMATE using the measured mean miss latency (not a claim of a
      // wall-clock saving on a single run, since concurrent fetches overlap).
      estSavedMs: Math.round(cacheHits * meanMissMs),
    };
  }

  /** Fetch + parse ONE (TIC, sector) SPOC curve; null on miss/parse failure. Byte-cached by key. */
  async function fetchOneCurve(tic: number, sector: number, targetId: string): Promise<LightCurve | null> {
    const key = resolveSpocKey(tic, sector, "lc");
    const bytes = await getBytes(key);
    if (!bytes) return null;
    try {
      const lc = fitsToLightCurve(bytes, targetId);
      lc.source = spocRealLabel(key);
      return lc;
    } catch {
      return null;
    }
  }

  /**
   * Fetch ALL the host's sectors concurrently (bounded), returning the curves that resolved IN SECTOR
   * ORDER. A 404 / non-FITS sector is simply omitted (best-effort, never throws), so callers can count
   * how many real sectors came back.
   */
  async function fetchSectors(tic: number, sectors: number[], targetId: string): Promise<LightCurve[]> {
    const out: (LightCurve | null)[] = new Array(sectors.length).fill(null);
    const width = Math.max(1, Math.min(opts.concurrency ?? 4, sectors.length));
    let next = 0;
    await Promise.all(
      Array.from({ length: width }, async () => {
        for (let idx = next++; idx < sectors.length; idx = next++) {
          out[idx] = await fetchOneCurve(tic, sectors[idx], targetId);
        }
      }),
    );
    return out.filter((x): x is LightCurve => x !== null);
  }

  return { fetchOneCurve, fetchSectors, fetchStats };
}

function medianOf(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Pure, deterministic merge of several same-target light curves into ONE longer-baseline curve.
 * Each input is re-normalized to its own median (so per-sector brightness offsets do not inject
 * steps at the joins), points are sorted by absolute time (BJD_TDB is common across sectors, so
 * folding over the stitched span stays coherent), and exact-duplicate timestamps are dropped. Used
 * by the multi-sector study (scripts/p12-multisector.ts) to attack the single-sector long-period
 * limit. Additive: it does not touch fetchSpocLightCurve, so the production/stand-in path is
 * unchanged and no bundle hash moves. Returns null if too few points survive.
 */
export function stitchLightCurves(lcs: LightCurve[]): LightCurve | null {
  const valid = lcs.filter((l) => l && Array.isArray(l.points) && l.points.length > 0);
  if (!valid.length) return null;
  const all: LightCurvePoint[] = [];
  for (const l of valid) {
    const finite = l.points.filter((p) => Number.isFinite(p.flux) && Number.isFinite(p.time));
    if (finite.length < 20) continue; // skip a sector too sparse to be trustworthy
    const med = medianOf(finite.map((p) => p.flux));
    if (!Number.isFinite(med) || med <= 0) continue;
    for (const p of finite) all.push({ time: p.time, flux: p.flux / med });
  }
  if (all.length < 50) return null;
  all.sort((a, b) => a.time - b.time);
  const dedup: LightCurvePoint[] = [];
  let lastT = Number.NEGATIVE_INFINITY;
  for (const p of all) {
    if (p.time !== lastT) { dedup.push(p); lastT = p.time; }
  }
  const spanDays = dedup.length ? dedup[dedup.length - 1].time - dedup[0].time : 0;
  return {
    targetId: valid[0].targetId,
    mission: valid[0].mission,
    cadenceSec: valid[0].cadenceSec,
    points: dedup,
    source: `stitched ${valid.length} TESS-SPOC sector(s), span ${spanDays.toFixed(1)} d (REAL photometry)`,
  };
}

/**
 * Download every available SPOC sector for a target (up to maxSectors) and stitch them into one
 * longer-baseline curve. Returns null if none download or too few points survive. Best-effort and
 * offline-degrading, exactly like fetchSpocLightCurve.
 */
export async function fetchSpocStitchedLightCurve(
  tic: number,
  sectors: number[],
  targetId: string,
  opts: SpocFetchOptions = {},
  maxSectors = 6,
): Promise<LightCurve | null> {
  const lcs: LightCurve[] = [];
  for (const sector of sectors.slice(0, maxSectors)) {
    const key = resolveSpocKey(tic, sector, "lc");
    const bytes = await fetchSpocBytes(key, opts);
    if (!bytes) continue;
    try {
      lcs.push(fitsToLightCurve(bytes, targetId));
    } catch {
      /* a sector that fails to parse is skipped */
    }
  }
  return stitchLightCurves(lcs);
}
