// MAST TESS light-curve client (runtime-agnostic: fetch + Web Crypto only).
//
// Anonymous download of public TESS products via the MAST Download service,
// parsed through the minimal FITS reader in ./fits.ts. Turns a real SAP/PDC
// light curve into the shared LightCurve shape consumed by the detector.

import { readFitsTable, readColumn } from "./fits.ts";
import type { LightCurve } from "../core/types.ts";

const MAST_DOWNLOAD = "https://mast.stsci.edu/api/v0.1/Download/file?uri=";

/** Absolute URL for a `mast:TESS/product/<file>` style product URI. */
export function mastProductUrl(uri: string): string {
  return MAST_DOWNLOAD + encodeURIComponent(uri);
}

/** Download a MAST product anonymously; rejects on non-2xx or timeout. */
export async function fetchMastProductBytes(uri: string, timeoutMs = 120000): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(mastProductUrl(uri), {
      signal: controller.signal,
      headers: { Accept: "application/fits, application/octet-stream" },
    });
    if (!r.ok) throw new Error(`MAST download HTTP ${r.status} for ${uri.split("/").pop()}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 2880 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]) !== "SIMPLE") {
      throw new Error(`MAST response is not FITS (login wall or error page?) for ${uri.split("/").pop()}`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert a TESS light-curve FITS product to the shared LightCurve shape.
 * Uses PDCSAP_FLUX when present (the mission's best systematics-corrected
 * flux) and falls back to SAP_FLUX. Rows with NaN flux or a nonzero QUALITY
 * flag are dropped (that flag encodes desaturation, ROI drift etc.).
 */
export function fitsToLightCurve(bytes: Uint8Array, targetId: string): LightCurve {
  const table = readFitsTable(bytes);
  const fluxCol = table.columns.some((c) => c.name === "PDCSAP_FLUX") ? "PDCSAP_FLUX" : "SAP_FLUX";
  const time = readColumn(table, bytes, "TIME");
  const flux = readColumn(table, bytes, fluxCol);
  const quality = table.columns.some((c) => c.name === "QUALITY") ? readColumn(table, bytes, "QUALITY") : null;

  const pts: { time: number; flux: number }[] = [];
  for (let i = 0; i < table.rows; i++) {
    if (!Number.isFinite(time[i]) || !Number.isFinite(flux[i])) continue;
    if (quality && Number.isFinite(quality[i]) && quality[i] !== 0) continue;
    // GL/SPOC TIME is BJD_TDB - 2457000 (TBJD); normalize to full BJD.
    const bjd = time[i] < 1e6 ? time[i] + 2457000 : time[i];
    pts.push({ time: bjd, flux: flux[i] });
  }
  if (pts.length < 50) throw new Error(`too few usable points after masking: ${pts.length}`);

  // Median-normalize (robust against outliers); PDC flux is e-/s.
  const sorted = pts.map((p) => p.flux).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const points = pts.map((p) => ({ time: p.time, flux: p.flux / med }));

  // Median cadence from consecutive samples.
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].time - points[i - 1].time);
  gaps.sort((a, b) => a - b);
  const cadenceDays = gaps[Math.floor(gaps.length / 2)];
  const cadenceSec = Math.round(cadenceDays * 86400);

  return {
    targetId,
    mission: "TESS",
    cadenceSec,
    points,
    source: `MAST TESS ${fluxCol} (real photometry, median-normalized)`,
  };
}
