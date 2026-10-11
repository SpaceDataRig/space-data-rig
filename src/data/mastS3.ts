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
import type { LightCurve } from "../core/types.ts";

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
