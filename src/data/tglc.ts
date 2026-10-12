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
//   time (D, BJD_TDB), psf_flux (E), aperture_flux (E), cal_psf_flux (E), cal_aper_flux (E),
//   background (E), cadence_num (J), TESS_flags (I), TGLC_flags (I).
// We fold on the calibrated column (normalized + detrended -- best for short-period transits) with a
// documented fallback chain, and drop cadences that are NaN or carry a nonzero TESS quality flag.
//
// Honest limits: the calibrated columns are detrended with a ~1-day window, which can suppress
// variability on longer timescales -- fine for the short-period transit search this feeds, and we
// record the exact column used in the provenance string. This parser is pure over bytes it is given;
// it does no network I/O and is NOT imported by the worker, so it cannot touch a bundle hash.

import { readFitsTable, readColumn } from "./fits.ts";
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

  const raw: LightCurvePoint[] = [];
  for (let i = 0; i < table.rows; i++) {
    const t = time[i];
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
      `TGLC FFI photometry column '${fluxName}' (${sector}, REAL photometry); ` +
      `decontaminated PSF/aperture full-frame light curve; CC BY 4.0, cite Han et al. 2023`,
  };
}
