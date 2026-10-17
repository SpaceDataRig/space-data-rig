// GAIA INDEPENDENT CORROBORATION (discovery roadmap, M1 / p88 -- the first truly INDEPENDENT instrument).
//
// WHY. Everything the rig measures comes from ONE spacecraft (TESS). The standing bias that caps a
// catalog-unmatched candidate at needs-more-data (src/critic/review.ts) is documented to relax ONLY when an
// INDEPENDENT second observation source can safely corroborate a signal. Gaia is exactly that: a different
// satellite, a different instrument, a different physical measurement (radial velocity + astrometry, not
// photometric dips). If Gaia's own two-body orbit solution or RV time series shows a STELLAR-mass companion on
// the candidate's period, that is strong independent evidence the "transit" is an eclipsing binary (a false
// positive). If it shows a PLANET-mass (or no) companion, it corroborates -- not contradicts -- a planet.
//
// WHAT THIS IS NOT. Not a full spectral-binary / SFLIMBER pipeline. A defensible FIRST-order corroboration with
// every threshold explicit and conservative. Research-only: not imported by the worker, so no bundle hash /
// verdict / money path. discoveryClaim stays structurally false; an unmeasured host returns a HONEST null, never
// a favourable grade.
//
// COLUMN CONTRACT VERIFIED by an anonymous TAP probe (2026-10-17) against gea.esac.esa.int/tap-server/tap/sync:
//   gaiadr3.vari_epoch_radial_velocity : source_id(int64) transit_id rv_obs_time radial_velocity(m/s)
//                                        radial_velocity_error(m/s) rejected_by_variability(bool) solution_id
//   gaiadr3.nss_two_body_orbit         : source_id(int64) nss_solution_type period[yr] eccentricity
//                                        semi_amplitude_primary(m/s) semi_amplitude_secondary(m/s) mass_ratio
//                                        significance rv_n_obs_primary astrometric_n_obs_al
//   gaiadr3.gaia_source               : has_rvs(bool) non_single_star(int bitmask)   [has_epoch_astrometry_* 400s -> unused]
// int64 source_id is CAST to varchar so >2^53 ids survive JSON.parse (see gaiaDilution.ts); nulls -> NaN.

const GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync";
const UA = "Mozilla/5.0 (compatible; space-data-rig)";
const DAYS_PER_YEAR = 365.25;

export interface GaiaRvEpoch {
  rvObsTime: number; // TAP-reported epoch (seconds since J2010 TDB per Gaia spec; only finiteness matters here)
  rvMps: number;
  rvErrMps: number;
  rejected: boolean; // Gaia flagged this epoch as rejected by variability
}

export interface GaiaOrbit {
  sourceId: string;
  solutionType: string; // "SB1" | "SB2" | "astrometric-only" | ...
  periodDays: number; // nss_two_body_orbit.period is in YEARS -> converted to days here
  eccentricity: number;
  kPrimaryMps: number; // semi_amplitude_primary (m/s): the observed star's RV wobble
  kSecondaryMps: number;
  massRatio: number;
  significance: number;
  rvNObsPrimary: number;
  astrometricNObsAl: number;
}

export interface GaiaSourceFlags {
  hasRvs: boolean;
  nonSingleStarBits: number; // gaia_source.non_single_star bitmask; >0 = Gaia saw some companion/accel signature
}

/** Turn Gaia's columnar TAP-JSON ({metadata:[{name}],data:[[v...]}) into rows keyed by column name. Pure.
 *  TAP encodes "no value" as null; Number(null)===0 is a silent WRONG finite value, so nulls/"" become NaN. */
export function columnarToRows(obj: unknown): Record<string, unknown>[] {
  const o = obj as { metadata?: { name: string }[]; data?: unknown[][] };
  if (!o || !Array.isArray(o.metadata) || !Array.isArray(o.data)) return [];
  const names = o.metadata.map((m) => m.name);
  const rows: Record<string, unknown>[] = [];
  for (const row of o.data) {
    if (!Array.isArray(row)) continue;
    const rec: Record<string, unknown> = {};
    names.forEach((n, i) => { rec[n] = row[i]; });
    rows.push(rec);
  }
  return rows;
}

const num = (v: unknown): number => (v == null || v === "" ? NaN : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/** Map vari_epoch_radial_velocity rows. Skips rows with a non-finite RV (no measurement). */
export function mapRvEpochRows(obj: unknown): GaiaRvEpoch[] {
  const out: GaiaRvEpoch[] = [];
  for (const r of columnarToRows(obj)) {
    const rvMps = num(r.radial_velocity);
    if (!Number.isFinite(rvMps)) continue;
    out.push({
      rvObsTime: num(r.rv_obs_time),
      rvMps,
      rvErrMps: num(r.radial_velocity_error),
      rejected: bool(r.rejected_by_variability),
    });
  }
  return out;
}

/** Map nss_two_body_orbit rows (period years -> days; solution_type may be absent -> ""). */
export function mapOrbitRows(obj: unknown): GaiaOrbit[] {
  const out: GaiaOrbit[] = [];
  for (const r of columnarToRows(obj)) {
    const periodYr = num(r.period);
    out.push({
      sourceId: str(r.source_id),
      solutionType: str(r.nss_solution_type),
      periodDays: Number.isFinite(periodYr) ? periodYr * DAYS_PER_YEAR : NaN,
      eccentricity: num(r.eccentricity),
      kPrimaryMps: num(r.semi_amplitude_primary),
      kSecondaryMps: num(r.semi_amplitude_secondary),
      massRatio: num(r.mass_ratio),
      significance: num(r.significance),
      rvNObsPrimary: num(r.rv_n_obs_primary),
      astrometricNObsAl: num(r.astrometric_n_obs_al),
    });
  }
  return out;
}

/** Map a single gaia_source flags row (has_rvs + non_single_star bitmask). */
export function mapFlagsRow(obj: unknown): GaiaSourceFlags | null {
  const rows = columnarToRows(obj);
  if (!rows.length) return null;
  const r = rows[0];
  return { hasRvs: bool(r.has_rvs), nonSingleStarBits: Number.isFinite(num(r.non_single_star)) ? num(r.non_single_star) : 0 };
}

export interface CorroborationInput {
  candidatePeriodDays: number;
  orbit: GaiaOrbit | null; // the host's two-body solution, if any
  epochs: GaiaRvEpoch[]; // the host's epoch RVs, if any
  flags: GaiaSourceFlags | null; // gaia_source summary flags for the host
  /** Relative period-match window: candidate and orbit agree if within this fraction (or a 2x alias). */
  toleranceRelFrac?: number;
  /** Primary RV semi-amplitude at/above which Gaia implies a STELLAR-mass companion (m/s). Default 30000 (~30 km/s). */
  stellarMpsThreshold?: number;
  /** Primary RV semi-amplitude below which a companion would be planet/sub-stellar mass (m/s). Default 1500. */
  planetMpsThreshold?: number;
}

export type EbExclusion = "excluded" | "supported" | "unknown";

export interface CorroborationVerdict {
  /**
   * "supported" = Gaia independently SUPPORTS an eclipsing-binary / stellar-companion explanation for the
   * candidate (a strong FALSE-POSITIVE signal). "excluded" = Gaia has RV/orbit data and DISFAVORS a stellar
   * companion at the candidate period (independent corroboration of planetary nature). "unknown" = Gaia has no
   * RV/orbit evidence bearing on this candidate -- the honest default that must NOT be read as favourable.
   */
  ebExclusion: EbExclusion;
  /** true only when ebExclusion==="supported" -- the veto (fire-on-blend) decision for the 2x2 scorer. */
  blendCorroborated: boolean;
  periodMatched: boolean;
  note: string;
}

/** Does the orbit period agree with the candidate transit period (within tol, allowing the 2x/0.5x alias)? */
function periodAgrees(candidateDays: number, orbitDays: number, tol: number): boolean {
  if (!Number.isFinite(candidateDays) || !Number.isFinite(orbitDays) || candidateDays <= 0 || orbitDays <= 0) return false;
  for (const alias of [1, 2, 0.5]) {
    const ref = candidateDays * alias;
    if (Math.abs(orbitDays - ref) / ref <= tol) return true;
  }
  return false;
}

/**
 * The independent-instrument corroboration verdict. Conservative by construction: it only ever returns
 * "supported" (blend corroborated) on POSITIVE Gaia evidence -- a two-body orbit whose period matches the
 * candidate AND whose primary RV semi-amplitude implies a stellar-mass companion. It returns "excluded"
 * (planet-favouring) only when Gaia has real RV/orbit data that DISFAVORS a stellar companion at the period.
 * Everything else -- host absent from the RV survey, no orbit fit, data present but not on the candidate
 * period -- is the honest "unknown", never a silent upgrade.
 */
export function rvAstrometryVsCandidate(i: CorroborationInput): CorroborationVerdict {
  const tol = Number.isFinite(i.toleranceRelFrac) && (i.toleranceRelFrac as number) > 0 ? (i.toleranceRelFrac as number) : 0.3;
  const stellar = Number.isFinite(i.stellarMpsThreshold) ? (i.stellarMpsThreshold as number) : 30000;
  const planet = Number.isFinite(i.planetMpsThreshold) ? (i.planetMpsThreshold as number) : 1500;

  const hasData = Boolean(i.orbit) || i.epochs.length > 0 || (i.flags != null && (i.flags.hasRvs || i.flags.nonSingleStarBits > 0));
  if (!hasData) {
    return { ebExclusion: "unknown", blendCorroborated: false, periodMatched: false, note: "no Gaia RV/orbit data for this host -- no independent evidence" };
  }

  const orb = i.orbit;
  if (orb && Number.isFinite(orb.periodDays)) {
    const matched = periodAgrees(i.candidatePeriodDays, orb.periodDays, tol);
    const k = Number.isFinite(orb.kPrimaryMps) ? orb.kPrimaryMps : NaN;
    if (matched && Number.isFinite(k) && k >= stellar) {
      return {
        ebExclusion: "supported", blendCorroborated: true, periodMatched: true,
        note: `Gaia two-body orbit (${orb.solutionType || "SB"}) at P=${orb.periodDays.toFixed(1)}d matches the candidate and has a stellar-mass RV semi-amplitude ${Math.round(k)} m/s -> independently corroborates an eclipsing binary / stellar companion`,
      };
    }
    if (matched && Number.isFinite(k) && k <= planet) {
      return {
        ebExclusion: "excluded", blendCorroborated: false, periodMatched: true,
        note: `Gaia orbit at the candidate period has only a planetary/sub-stellar RV semi-amplitude ${Math.round(k)} m/s -> a stellar-mass EB is disfavoured (independent corroboration of planetary nature)`,
      };
    }
    if (matched) {
      return { ebExclusion: "unknown", blendCorroborated: false, periodMatched: true, note: `Gaia orbit period (${orb.periodDays.toFixed(1)}d) matches the candidate but the RV semi-amplitude is unmeasured -- cannot grade the companion mass` };
    }
    // orbit exists but on a different period: it says nothing about THIS candidate.
    return { ebExclusion: "unknown", blendCorroborated: false, periodMatched: false, note: `Gaia reports an orbit at P=${orb.periodDays.toFixed(1)}d, NOT matching the candidate period -- independent but off-period, no bearing` };
  }

  // No orbit solution, but the host is flagged non-single / has RVs: evidence of SOME companion, uncharacterised.
  const flagged = i.flags != null && (i.flags.hasRvs || i.flags.nonSingleStarBits > 0);
  if (flagged) {
    return { ebExclusion: "unknown", blendCorroborated: false, periodMatched: false, note: `Gaia flags the host as non-single/RV-variable but provides no orbital solution on the candidate period -- cannot corroborate or exclude an EB` };
  }
  return { ebExclusion: "unknown", blendCorroborated: false, periodMatched: false, note: "Gaia RV data present but no orbit bearing on the candidate period -- no independent evidence" };
}

// ---- I/O (ADQL + network). Kept out of the pure verdict above; entry scripts import these directly. --------

function assertSourceId(id: string): void {
  if (!/^[0-9]{1,20}$/.test(id)) throw new Error(`invalid Gaia source_id: ${id}`);
}

/** ADQL for the host's two-body orbit solution (source_id CAST to varchar; period left in years, mapped here). */
export function orbitBySourceAdql(sourceId: string): string {
  assertSourceId(sourceId);
  return (
    `select cast(source_id as varchar) as source_id, nss_solution_type, period, eccentricity, ` +
    `semi_amplitude_primary, semi_amplitude_secondary, mass_ratio, significance, rv_n_obs_primary, astrometric_n_obs_al ` +
    `from gaiadr3.nss_two_body_orbit where source_id=${sourceId}`
  );
}

/** ADQL for the host's epoch radial velocities (per-epoch series). */
export function epochsBySourceAdql(sourceId: string): string {
  assertSourceId(sourceId);
  return (
    `select rv_obs_time, radial_velocity, radial_velocity_error, rejected_by_variability ` +
    `from gaiadr3.vari_epoch_radial_velocity where source_id=${sourceId}`
  );
}

/** ADQL for the host's gaia_source companion summary flags. */
export function flagsBySourceAdql(sourceId: string): string {
  assertSourceId(sourceId);
  return `select has_rvs, non_single_star from gaiadr3.gaia_source where source_id=${sourceId}`;
}

async function runGaiaRaw(adql: string, timeoutMs = 45000): Promise<unknown> {
  const url = `${GAIA_TAP}?REQUEST=doQuery&LANG=ADQL&FORMAT=json&PHASE=RUN&QUERY=${encodeURIComponent(adql)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Gaia TAP HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface GaiaCorroborationData {
  orbit: GaiaOrbit | null;
  epochs: GaiaRvEpoch[];
  flags: GaiaSourceFlags | null;
}

/** Fetch all three independent Gaia products for one host source_id (orbit, epoch RVs, summary flags). */
export async function fetchGaiaCorroboration(sourceId: string, opts: { timeoutMs?: number } = {}): Promise<GaiaCorroborationData> {
  const to = opts.timeoutMs ?? 45000;
  const [orbitRaw, epochRaw, flagsRaw] = await Promise.all([
    runGaiaRaw(orbitBySourceAdql(sourceId), to).catch(() => null),
    runGaiaRaw(epochsBySourceAdql(sourceId), to).catch(() => null),
    runGaiaRaw(flagsBySourceAdql(sourceId), to).catch(() => null),
  ]);
  const orbits = orbitRaw ? mapOrbitRows(orbitRaw) : [];
  return {
    orbit: orbits.length ? orbits[0] : null,
    epochs: epochRaw ? mapRvEpochRows(epochRaw) : [],
    flags: flagsRaw ? mapFlagsRow(flagsRaw) : null,
  };
}
