// The single canonical definition of "is this light curve REAL photometry or a stand-in?" and the
// external-column contract the pipeline depends on. Audit finding #7 (brittle external data deps, no
// schema-contract tests) is really about SILENT degradation: an upstream column rename or a change to
// a source-label string makes the honesty tags quietly wrong. Centralising the discriminators here lets
// `tests/schemaContract.test.ts` pin them, so a drift turns into a red test instead of a mislabelled card.
//
// Pure + offline; used by the reporter narration and the bundle/manifest path labels. It changes no
// verdict and no bundle hash -- it only makes an already-existing rule testable in one place.

/**
 * The ONLY discriminator between real and stand-in photometry: the source string must contain the
 * phrase "real photometry" (case-insensitive). Both producers honour it -- the token-free S3 tier
 * labels stitched/curated curves "...(REAL photometry)" and the fallback labels "synthetic stand-in..."
 * -- and both consumers (reporter narration + the web provenance panel) match on it. Keep them in sync.
 */
export function isRealPhotometry(source: string | undefined): boolean {
  return /real photometry/i.test(source ?? "");
}

/** The two served tier values (round-21 audit defect 3: the tier must be DATA, not prose). */
export const DATA_TIER_REAL = "real-photometry";
export const DATA_TIER_STANDIN = "stand-in-synthetic";

/** The tier of a light curve, from its source string via the single canonical discriminator. */
export function dataTierOfSource(source: string | undefined): string {
  return isRealPhotometry(source) ? DATA_TIER_REAL : DATA_TIER_STANDIN;
}

/**
 * Decode the tier back out of a narrated headline. narrateFinding prefixes EVERY headline with exactly
 * one of the two tags, chosen by isRealPhotometry(source), so reading the tag off a STORED headline is a
 * lossless tier read for rows that predate any stored tier field -- which is every row already served.
 * A headline with neither tag (should not happen) reads as stand-in: the conservative, honest default.
 */
export function dataTierOfHeadline(headline: string | undefined): string {
  const h = headline ?? "";
  if (/real TESS photometry/i.test(h)) return DATA_TIER_REAL;
  return DATA_TIER_STANDIN;
}

/** NASA Exoplanet Archive `pscomppars` columns the fetch actually requests. Every field the row
 *  mapping/filter reads must appear here, or the value silently comes back undefined. */
export const PSOMPPARS_COLUMNS = [
  "pl_name", "hostname", "pl_orbper", "pl_trandep", "pl_trandur", "pl_tranmid",
  "pl_rade", "st_rad", "st_mass", "ra", "dec", "tic_id", "sy_tmag", "discoverymethod",
] as const;

/**
 * Fields that downstream code READS off a pscomppars row (unit-normalised `pl_trandep`, numeric
 * `tic_id`, the filter keys `pl_orbper`/`sy_tmag`, the query pin `discoverymethod`). The schema
 * contract asserts this set is a subset of PSOMPPARS_COLUMNS -- i.e. we never read a column we did
 * not ask the archive for.
 */
export const PSOMPPARS_READ_FIELDS = [
  "pl_orbper", "pl_trandep", "pl_trandur", "pl_tranmid", "tic_id", "ra", "dec", "sy_tmag", "discoverymethod",
] as const;

/**
 * The exact ExoFOP-TESS public TOI-table header names parseToiTable looks up, by the ToiRecord field
 * they populate. The contract test feeds a header built from these and asserts a rename of any
 * REQUIRED one (tic id / toi / ra / dec / period) makes the parser fail closed to [] rather than
 * emit garbage rows -- so an upstream column change is loud, not silent.
 */
export const EXOFOP_REQUIRED_HEADERS = ["TIC ID", "TOI", "RA", "Dec", "Period (days)"] as const;
