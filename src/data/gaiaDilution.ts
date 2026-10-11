// Gaia DR3 dilution / blend diagnostics (complementary to the pixel centroid test).
//
// WHY. The in-transit photocenter shift (src/data/mastS3Pixels.ts) rejects a signal whose light
// comes from a neighbouring star. A separate, ALSO phase-independent concern is DILUTION: an
// unresolved faint companion sitting inside the TESS aperture adds constant flux, so the observed
// transit depth UNDERSTATES the true depth of the host star. If the companion is itself an
// eclipsing binary, that EB -- diluted by the target's light -- can masquerade as a shallow
// planetary transit. Gaia gives us the neighbour magnitudes and positions to quantify this.
//
// HONEST SCOPE. Dilution is a CORRECTION and a diagnostic, NOT a rejection gate: a real planet can
// legitimately sit in front of a diluted host, so a high dilution factor is never by itself evidence
// of a false positive (unlike an off-target centroid). We therefore report the corrected depth and a
// blend flag, and deliberately do NOT wire it into the critic's reject path -- and do NOT add a
// rate-limited third external service to every production run for a quantity that cannot gate.
//
// The Gaia ADQL column contract below was VERIFIED by a read-only probe against the anonymous
// endpoint (gea.esac.esa.int/tap-server/tap/sync): FORMAT=json returns a COLUMNAR object
// { metadata: [{name,...}], data: [[v,...],...] }. `distance` is a reserved ADQL word (400s) and is
// NOT used. Cone queries with CONTAINS(POINT,CIRCLE)=1 work. Magnitudes are Gaia G/BP/RP; TESS's
// red-optical band differs, so the G-band flux ratio is a documented proxy, not an exact TESS flux.

const GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync";
const UA = "Mozilla/5.0 (compatible; space-data-rig)";

export interface GaiaSource {
  sourceId: string;
  ra: number;
  dec: number;
  gmag: number;
  bpmag: number;
  rpmag: number;
  ruwe: number;
}

export interface DilutionResult {
  /** flux(host) / (flux(host)+flux(neighbours)): 1 = clean, 0.5 = half the light is a blend. */
  dilutionFactor: number;
  /** total contaminating flux of aperture neighbours, in percent of the host's flux. */
  contaminationPct: number;
  nInAperture: number;
  /** brightest neighbour's G-band contrast (dmag = host - neighbour; larger = fainter neighbour). */
  brightestContrastMag: number;
  brightestSepArcsec: number;
  /** the host's own G magnitude (NaN if not matched). */
  hostGmag: number;
  determined: boolean;
}

const LOG10FLUX = -0.4;

/** Great-circle angular separation in arcseconds between two ICRS points (deg). */
export function angularSepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const s1 = Math.sin(dec1 * d2r);
  const c1 = Math.cos(dec1 * d2r);
  const s2 = Math.sin(dec2 * d2r);
  const c2 = Math.cos(dec2 * d2r);
  const cosD = Math.min(1, Math.max(-1, s1 * s2 + c1 * c2 * Math.cos((ra1 - ra2) * d2r)));
  return Math.acos(cosD) * (180 / Math.PI) * 3600;
}

/** Convert Gaia's COLUMNAR TAP-JSON ({metadata,data}) into typed rows. Pure + unit-testable. */
export function parseColumnarGaia(obj: unknown): GaiaSource[] {
  const o = obj as { metadata?: { name: string }[]; data?: unknown[][] };
  if (!o || !Array.isArray(o.metadata) || !Array.isArray(o.data)) return [];
  const idx: Record<string, number> = {};
  o.metadata.forEach((m, i) => {
    idx[m.name] = i;
  });
  const get = (row: unknown[], key: string): unknown => {
    const j = idx[key];
    return j == null ? undefined : row[j];
  };
  // TAP JSON encodes "no value" as null; Number(null) is 0 (a finite, WRONG coordinate/magnitude),
  // so nulls must become NaN or malformed rows silently pass as valid detections.
  const toNum = (row: unknown[], key: string): number => {
    const v = get(row, key);
    if (v == null || v === "") return NaN;
    return Number(v);
  };
  const out: GaiaSource[] = [];
  for (const row of o.data) {
    if (!Array.isArray(row)) continue;
    const src: GaiaSource = {
      sourceId: String(get(row, "source_id")),
      ra: toNum(row, "ra"),
      dec: toNum(row, "dec"),
      gmag: toNum(row, "phot_g_mean_mag"),
      bpmag: toNum(row, "phot_bp_mean_mag"),
      rpmag: toNum(row, "phot_rp_mean_mag"),
      ruwe: toNum(row, "ruwe"),
    };
    if (Number.isFinite(src.ra) && Number.isFinite(src.dec) && Number.isFinite(src.gmag)) out.push(src);
  }
  return out;
}

/**
 * Dilution from an aperture's neighbour list, relative to a host of magnitude hostGmag. Only
 * neighbours within apertureArcsec count. Fluxes use the G band as a documented TESS proxy.
 */
export function dilutionFromNeighbors(hostGmag: number, hostRa: number, hostDec: number, neighbors: GaiaSource[], apertureArcsec: number, hostSourceId?: string): DilutionResult {
  let fluxRatio = 0;
  let n = 0;
  let brightestContrast = Infinity;
  let brightestSep = NaN;
  for (const g of neighbors) {
    if (hostSourceId != null && g.sourceId === hostSourceId) continue; // the host itself (exact id, never a magnitude guess)
    const sep = angularSepArcsec(hostRa, hostDec, g.ra, g.dec);
    if (!(sep <= apertureArcsec)) continue;
    const rel = Math.pow(10, LOG10FLUX * (g.gmag - hostGmag)); // neighbour flux / host flux
    fluxRatio += rel;
    n++;
    const contrast = g.gmag - hostGmag;
    if (contrast < brightestContrast) {
      brightestContrast = contrast;
      brightestSep = sep;
    }
  }
  const contaminationPct = fluxRatio * 100;
  const determined = Number.isFinite(hostGmag) && n >= 1;
  return {
    dilutionFactor: 1 / (1 + fluxRatio),
    contaminationPct,
    nInAperture: n,
    brightestContrastMag: n ? brightestContrast : NaN,
    brightestSepArcsec: brightestSep,
    hostGmag,
    determined,
  };
}

export interface GaiaQueryOptions {
  radiusDeg?: number; // cone radius (deg); default ~0.0028 deg (~10 arcsec)
  timeoutMs?: number;
}

/** Fetch Gaia sources within radiusDeg of (ra,dec) from the anonymous TAP sync endpoint. */
export async function fetchGaiaNeighborhood(ra: number, dec: number, opts: GaiaQueryOptions = {}): Promise<GaiaSource[]> {
  const radius = opts.radiusDeg ?? 0.0028;
  // NOTE: `distance` is reserved in Gaia ADQL (causes a 400 parse error) and is intentionally absent.
  // Null-magnitude filtering is done client-side (parseColumnarGaia) rather than with a SQL
  // `is not null`, matching the discipline used for the exoplanet-archive WAF and keeping the ADQL simple.
  const adql =
    `select TOP 50 source_id, ra, dec, phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag, ruwe ` +
    `from gaiadr3.gaia_source ` +
    `where CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius}))=1`;
  const url = `${GAIA_TAP}?REQUEST=doQuery&LANG=ADQL&FORMAT=json&PHASE=RUN&QUERY=${encodeURIComponent(adql)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Gaia TAP HTTP ${r.status}`);
    return parseColumnarGaia(await r.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: neighborhood + dilution relative to the target's own G magnitude. */
export async function measureDilution(hostRa: number, hostDec: number, hostGmag: number, opts: GaiaQueryOptions & { apertureArcsec?: number } = {}): Promise<DilutionResult> {
  const sources = await fetchGaiaNeighborhood(hostRa, hostDec, opts);
  const aperture = opts.apertureArcsec ?? (opts.radiusDeg ?? 0.0028) * 3600;
  return dilutionFromNeighbors(hostGmag, hostRa, hostDec, sources, aperture);
}
