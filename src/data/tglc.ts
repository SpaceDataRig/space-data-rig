// TGLC full-frame-image light-curve parser (discovery roadmap, Stage 1).
//
// TGLC (Han et al. 2023) publishes PSF-fit + aperture FFI light curves for essentially every star
// brighter than TESS magnitude 16, decontaminated against Gaia DR3, as FITS products in the public
// token-free `stpubdata` S3 bucket. That is the data path to stars nobody specifically targeted --
// the population where a novel candidate can live. The p17 probe confirmed these are anonymously
// downloadable; this module turns the bytes into the pipeline's LightCurve so the EXISTING blind
// detection chain (bls / vetting / significance / candidate contract) can run on them unchanged.
//
// Verified TGLC schema (BINTABLE EXTNAME='LIGHTCURVE', measured from a real s0001 product):
//   time (D, BJD_TDB reduced by BJDREFI+BJDREFR), psf_flux (E), aperture_flux (E), cal_psf_flux (E),
//   cal_aper_flux (E), background (E), cadence_num (J), TESS_flags (I), TGLC_flags (I).
// The time column is a REDUCED BJD (Sector 1 measured: 1325-1353, header BJDREFI=2457000, TIMESYS=TDB,
// MJD_BEG=58324.8 = 2018-07-25). We convert to ABSOLUTE BJD_TDB using the product's OWN BJDREFI+BJDREFR so
// downstream ephemeris / observability (Stage 3) works on true dates, never a guessed epoch offset.
// We fold on the calibrated column (normalized + detrended -- best for short-period transits) with a
// documented fallback chain, and drop cadences that are NaN or carry a nonzero TESS quality flag.
//
// Honest limits: the calibrated columns are detrended with a ~1-day window, which can suppress
// variability on longer timescales -- fine for the short-period transit search this feeds, and we
// record the exact column used in the provenance string. This parser is pure over bytes it is given;
// it does no network I/O and is NOT imported by the worker, so it cannot touch a bundle hash.

import { readFitsTable, readColumn, readFitsPrimaryHeader } from "./fits.ts";
import type { LightCurve, LightCurvePoint } from "../core/types.ts";

const FLUX_CANDIDATES = ["cal_psf_flux", "cal_aper_flux", "psf_flux", "aperture_flux"] as const;

function medianOf(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface TglcParseOptions {
  /** Preferred flux column; defaults to the first available in the calibrated->raw chain. */
  fluxColumn?: string;
  /** Drop cadences with a nonzero TESS_flags (default true). */
  maskBadFlags?: boolean;
}

/** Parse TGLC FITS bytes into a normalized LightCurve, or null if no usable cadences survive. */
export function tglcBytesToLightCurve(bytes: Uint8Array, targetId: string, opts: TglcParseOptions = {}): LightCurve | null {
  const table = readFitsTable(bytes); // first BINTABLE = the LIGHTCURVE extension
  const time = readColumn(table, bytes, "time");
  const has = (n: string) => table.columns.some((c) => c.name === n);
  // Pick the first candidate flux column that actually carries data. A star's PSF fit may not converge
  // (psf_flux / cal_psf_flux all-NaN) while its aperture columns are full, so "column exists" is not
  // enough -- we require a usable fraction of finite values and fall through otherwise.
  const minFinite = Math.max(20, Math.floor(table.rows * 0.3));
  let fluxName: string | undefined;
  let flux: Float64Array | undefined;
  let best: { name: string; arr: Float64Array; finite: number } | null = null;
  for (const name of opts.fluxColumn ? [opts.fluxColumn] : FLUX_CANDIDATES) {
    if (!has(name)) continue;
    const arr = readColumn(table, bytes, name);
    let finite = 0;
    for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) finite++;
    if (!best || finite > best.finite) best = { name, arr, finite };
    if (finite >= minFinite) { fluxName = name; flux = arr; break; }
  }
  if (!fluxName || !flux) {
    if (best && best.finite >= 20) { fluxName = best.name; flux = best.arr; }
    else throw new Error(`no TGLC flux column with usable data (looked for: ${FLUX_CANDIDATES.join(", ")})`);
  }
  const flags = has("TESS_flags") ? readColumn(table, bytes, "TESS_flags") : null;
  const maskBad = opts.maskBadFlags !== false;

  // Absolute-time reference: the product reduces BJD by BJDREFI + BJDREFR (default TESS epoch 2457000.0).
  // We trust the header's OWN value; if it is absent or non-absolute we leave the column untouched rather
  // than assume, so an already-absolute source is never double-shifted.
  const bjdRefI = Number(table.header.BJDREFI);
  const bjdRefR = Number(table.header.BJDREFR);
  const timeRef = (Number.isFinite(bjdRefI) ? bjdRefI : 0) + (Number.isFinite(bjdRefR) ? bjdRefR : 0);
  const toAbsBjd = timeRef > 1e6 ? (t: number) => t + timeRef : (t: number) => t;

  const raw: LightCurvePoint[] = [];
  for (let i = 0; i < table.rows; i++) {
    const t = toAbsBjd(time[i]);
    const f = flux[i];
    if (!Number.isFinite(t) || !Number.isFinite(f)) continue;
    if (maskBad && flags && flags[i] !== 0) continue;
    raw.push({ time: t, flux: f });
  }
  if (raw.length < 20) return null;

  raw.sort((a, b) => a.time - b.time);
  const med = medianOf(raw.map((p) => p.flux));
  if (!Number.isFinite(med) || med <= 0) return null;
  const points = raw.map((p) => ({ time: p.time, flux: p.flux / med }));

  const sector = table.header.SECTOR != null ? `s${String(table.header.SECTOR).padStart(4, "0")}` : "s????";
  return {
    targetId,
    mission: "TESS",
    points,
    source:
      `TGLC FFI photometry column '${fluxName}' (${sector}, REAL photometry; time = absolute BJD_TDB via BJDREF${timeRef > 1e6 ? `I=${timeRef.toFixed(0)} applied` : " (product already absolute)"}); ` +
      `decontaminated PSF/aperture full-frame light curve; CC BY 4.0, cite Han et al. 2023`,
  };
}

export interface TglcHeaderMeta {
  /** Host TESS Input Catalog id (the key used for novelty de-duplication), or null if absent. */
  tic: number | null;
  ra: number | null;
  dec: number | null;
  tmag: number | null;
  sector: number | null;
}

function numOrNull(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract host metadata from the PRIMARY header for the novelty gate and follow-up card.
 * TICID is stored as a quoted string (~1e8, safe as a JS number) and is what the confirmed/TOI
 * catalogs key on. We deliberately do NOT use GAIADR3 as an identifier: it is an int64 beyond
 * 2^53 and would silently lose precision. Pure over bytes; no network; not imported by the worker.
 */
export function tglcHeaderMeta(bytes: Uint8Array): TglcHeaderMeta {
  const h = readFitsPrimaryHeader(bytes);
  return {
    tic: numOrNull(h.TICID as string | number | undefined),
    ra: numOrNull(h.RA_OBJ as string | number | undefined),
    dec: numOrNull(h.DEC_OBJ as string | number | undefined),
    tmag: numOrNull(h.TESSMAG as string | number | undefined),
    sector: numOrNull(h.SECTOR as string | number | undefined),
  };
}
