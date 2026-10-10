// Anonymous MAST product *discovery* (runtime-agnostic: fetch only).
//
// This is the missing piece the curated registry in ./mastCurated.ts worked
// around: given a target's sky coordinates, ask MAST which real light-curve
// products exist, without a token. It talks to the MAST `invoke` service the
// same way the Portal does:
//
//   POST https://mast.stsci.edu/api/v0/invoke   body: request=<json>   (form-encoded)
//
// Two calls do the job:
//   1. Mast.Caom.Cone    { ra, dec, radius }  -> observations overlapping the target
//   2. Mast.Caom.Products { caom_uri }         -> product files for one observation
//
// IMPORTANT / HONEST LIMITATION (verified 2026-10-10 by direct probing):
//   the CAOM Portal query services return HTTP 200 with an *empty* body (`{}`)
//   for anonymous callers -- `Mast.Caom.Filtered` is the logged-in user's saved
//   collection, and `Mast.Caom.Cone` also comes back empty without a token.
//   The dependency-free Download service (`Download/file?uri=mast:...`), by
//   contrast, serves the FITS bytes anonymously. So on this rig discovery is
//   best-effort: it is tried first, and when it returns nothing (anonymous, or
//   no overlapping coverage) the pipeline falls back to the curated registry
//   and then to the synthetic stand-in. With a MAST token supplied via
//   `authHeader` the same code path resolves real products automatically.

import { fetchMastProductBytes, fitsToLightCurve } from "./mast.ts";
import type { LightCurve } from "../core/types.ts";

const MAST_INVOKE = "https://mast.stsci.edu/api/v0/invoke";

export interface DiscoverOptions {
  /** search radius in degrees (default 0.02 ~ 72 arcsec, TESS pixel scale). */
  radiusDeg?: number;
  /** "Authorization: Bearer <MAST token>" passed straight through, if provided. */
  authHeader?: string;
  /** per-request timeout (default 30s; discovery is cheap). */
  timeoutMs?: number;
  /** restrict to these missions (default TESS only). */
  missions?: string[];
}

/** One discovered product file. `dataUri` is ready for Download/file. */
export interface DiscoveredProduct {
  dataUri: string; // mast:TESS/product/<file>
  obsId: string; // e.g. 2018292075959-s0004 (sector-style id)
  description?: string;
}

interface InvokeEnvelope {
  status?: number;
  message?: string;
  data?: unknown[];
}

/** POST a single MAST invoke service call and return its `data` rows. */
async function invoke<T>(
  service: string,
  args: Record<string, unknown>,
  opts: DiscoverOptions,
): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const body = new URLSearchParams({ request: JSON.stringify({ service, args }) });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (opts.authHeader) headers.Authorization = opts.authHeader;
    const r = await fetch(MAST_INVOKE, { method: "POST", body, headers, signal: controller.signal });
    if (!r.ok) throw new Error(`MAST invoke HTTP ${r.status} for ${service}`);
    const text = await r.text();
    if (!text || text === "{}") return []; // anonymous-empty / no coverage
    let parsed: InvokeEnvelope;
    try {
      parsed = JSON.parse(text) as InvokeEnvelope;
    } catch {
      throw new Error(`MAST invoke returned non-JSON for ${service}: ${text.slice(0, 120)}`);
    }
    if (parsed.status && parsed.status >= 400) throw new Error(`MAST invoke ${service} status ${parsed.status}: ${parsed.message ?? ""}`);
    return (parsed.data ?? []) as T[];
  } finally {
    clearTimeout(timer);
  }
}

interface ConeRow {
  obs_id?: string;
  data_uri?: string; // mast:TESS/observation/<...>
  mission_name?: string;
  cal_level?: string;
}

interface ProductRow {
  product_type?: string;
  data_type?: string;
  description?: string;
  data_uri?: string; // mast:TESS/product/<file>
}

function isLightCurveUri(uri: string): boolean {
  return /_lc2?\.fits$/i.test(uri);
}

/**
 * Discover real light-curve products near a coordinate. Returns [] (never
 * throws for "empty") when there is no anonymous coverage; throws only on a
 * transport/HTTP error so callers can distinguish "nothing found" from "failed".
 */
export async function discoverMastProducts(ra: number, dec: number, opts: DiscoverOptions = {}): Promise<DiscoveredProduct[]> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw new Error(`discover: bad coordinates (${ra}, ${dec})`);
  const missions = (opts.missions ?? ["TESS"]).map((m) => m.toUpperCase());

  const cone = await invoke<ConeRow>("Mast.Caom.Cone", { ra, dec, radius: opts.radiusDeg ?? 0.02 }, opts);
  const out: DiscoveredProduct[] = [];
  const seen = new Set<string>();

  for (const row of cone) {
    const dataUri = row.data_uri ?? "";
    const mission = (row.mission_name ?? "").toUpperCase();
    if (missions.length && mission && !missions.includes(mission)) continue;
    if (!dataUri) continue;

    let products: ProductRow[];
    try {
      products = await invoke<ProductRow>("Mast.Caom.Products", { caom_uri: dataUri }, opts);
    } catch {
      continue; // one observation's product listing failed; try the next
    }
    for (const p of products) {
      const uri = p.data_uri ?? "";
      if (!isLightCurveUri(uri) || seen.has(uri)) continue;
      seen.add(uri);
      out.push({ dataUri: uri, obsId: row.obs_id ?? uri.split("/").pop() ?? "", description: p.description });
    }
  }
  // Prefer full-frame/spacecraft-style _lc over _lc2 (2-minute) when both exist, then by obs id.
  out.sort((a, b) => Number(isLightCurveUri2(b.dataUri)) - Number(isLightCurveUri2(a.dataUri)) || a.obsId.localeCompare(b.obsId));
  return out;
}

function isLightCurveUri2(uri: string): boolean {
  return /_lc2\.fits$/i.test(uri);
}

/**
 * Try to fetch a REAL light curve for a coordinate end-to-end: discover the
 * best product, download it anonymously and parse it. Returns null on any
 * miss (no coverage / anonymous-empty / parse failure) so the caller can fall
 * back -- `source` is left for the caller to annotate with provenance.
 */
export async function discoverAndFetchLightCurve(
  ra: number,
  dec: number,
  targetId: string,
  opts: DiscoverOptions = {},
): Promise<LightCurve | null> {
  try {
    const found = await discoverMastProducts(ra, dec, opts);
    if (found.length === 0) return null;
    const pick = found[0];
    const bytes = await fetchMastProductBytes(pick.dataUri);
    const lc = fitsToLightCurve(bytes, targetId);
    lc.source = `${lc.source}; discovered via anonymous MAST CAOM query for (${ra.toFixed(3)}, ${dec.toFixed(3)})`;
    return lc;
  } catch {
    return null;
  }
}
