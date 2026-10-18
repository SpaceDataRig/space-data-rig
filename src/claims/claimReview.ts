/**
 * CLAIM PROVENANCE REVIEW (p91) -- the pure decision layer.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT externalReview.ts. `src/review/externalReview.ts` audits a third party's
 * *exoplanet candidate*: it needs an ephemeris (period, epoch, depth, Rp/R*) and it re-runs our detector on the same
 * star. The claim that prompted this module is a different animal: a widely shared post announcing that
 * "NASA's James Webb Space Telescope detects a mysterious infrared light signal emanating from a seemingly empty
 * void in space", with no ephemeris, no target catalogue id, and a wavelength (1.6 micron) outside our instrument's
 * band. So there is nothing for BLS to fold. What CAN be audited objectively is the claim's own structure --
 * does the primary source it asserts exist, does the primary say what the post says it says, does the post's
 * timing wording survive comparison with the source's dates, is the post attributable to anything at all, and could
 * our instrument in principle corroborate the phenomenon. Those are checkable with public metadata and no opinion.
 *
 * HARD RULES BAKED IN (the same discipline the rest of the rig was audited into):
 *   - Every axis states its rule and its threshold, so a reader can disagree with the rule rather than the result.
 *   - Unknown is printed as unknown. A source that does not resolve is never promoted to "no source exists"; a
 *     transport failure is never a scientific verdict (the p8 live-probe NET/FAIL split, applied to claims).
 *   - Nothing here gates, anchors, or claims. `safeToGate` is false by construction: a provenance audit of
 *     somebody else's announcement tells us about the announcement, not about the sky.
 *   - No discovery wording is emitted. The output vocabulary is deliberately boring.
 *
 * Deterministic and network-free so CI can pin it; the fetching lives in scripts/p91-claim-provenance.ts.
 */

/** A band, in microns, as the claim states it. lo <= hi required for a usable range. */
export interface Band {
  loMicron: number;
  hiMicron: number;
}

export interface PublicClaim {
  id: string;
  /** The post text verbatim, as published. */
  text: string;
  /** Post timestamp in UTC, ISO. Taken from the platform's own rendered time, not from a scrape date. */
  postedUtc: string;
  /** What the post asserts produced the observation, in its own words (used only for subject matching). */
  asserted: {
    mission: string;
    instrument?: string;
    agency?: string;
    band?: Band;
    field?: string;
  };
  /** Persistent identifiers the post itself cites (DOI or arXiv id). Empty means the post cites nothing. */
  citedIds: string[];
  /**
   * Identifiers supplied by the operator after looking the announcement up. KEPT SEPARATE from citedIds on
   * purpose: a post that cites nothing stays unattributed however many sources we can find for it, and mixing the
   * two would let our own diligence be read as the poster's. Subject and recency are judged against cited +
   * located records; attribution is judged against cited records only.
   */
  locatedIds?: string[];
  /** Wavelength range from the primary record when the post never states one, tagged by where it came from. */
  bandFromPrimary?: Band;
}

/**
 * One resolved primary record: what an identifier actually points to, read out of the registering body
 * (Crossref for DOIs, arXiv's own API for arXiv ids) rather than from a search engine's summary.
 */
export interface PrimaryRecord {
  kind: "doi" | "arxiv";
  id: string;
  /** False when the resolver had no record for the id, or the request failed. */
  resolved: boolean;
  /** Why it did not resolve. "not-found" vs "transport" MUST be distinguished: one is evidence, the other is not. */
  reason?: "not-found" | "transport";
  title?: string;
  /** Abstract/summary when the registering body exposes one (arXiv does). Compared alongside the title, because a
   *  title alone routinely omits the words a popular post chose -- judging fidelity on the title only would
   *  manufacture disagreement out of a formatting difference. */
  abstract?: string;
  /** First public date the body records (arXiv v1 date, or Crossref's published date), ISO. */
  publishedUtc?: string;
  venue?: string;
  publisher?: string;
}

export type SubjectTier = "MATCH" | "PARTIAL" | "MISMATCH" | "UNRESOLVED";
export type RecencyTier = "NO-TIMING-CLAIM" | "CONSISTENT" | "INFLATED" | "UNVERIFIABLE";
export type AttributionTier = "CITES-PRIMARY" | "CITES-SECONDARY-ONLY" | "NO-CITATION" | "CITATION-DOES-NOT-RESOLVE";
export type BandTier = "OVERLAPS-US" | "ADJACENT" | "DISJOINT" | "UNSTATED";
export type CorroborationTier = "NOT-IN-OUR-BAND" | "COVERAGE-NOT-CHECKED" | "COVERED-BUT-INCONCLUSIVE";

export interface Axis<T extends string> {
  tier: T;
  /** The rule and the numbers that produced the tier, in one sentence a reader can check. */
  basis: string;
}

export interface ClaimReview {
  id: string;
  subject: Axis<SubjectTier>;
  recency: Axis<RecencyTier>;
  attribution: Axis<AttributionTier>;
  band: Axis<BandTier>;
  /** Lag between the earliest resolvable primary date and the post, in whole days. null if not computable. */
  lagDays: number | null;
  /** Days the timing wording implied freshness, against the actual lag. */
  timingWords: string[];
  /**
   * Whether THIS rig's photometry could in principle bear on the phenomenon. Not a judgement of the claim --
   * a statement about instrument reach, computed from the band overlap plus whatever coverage evidence the caller
   * supplies (see coverageEvidence below).
   */
  corroboration: Axis<CorroborationTier>;
  /** Always false, by construction. */
  safeToGate: false;
  summary: string;
}

/* ------------------------------------------------------------------ thresholds, stated up front ------- */

/** Lag beyond which a freshness-implying post is INFLATED. Generous on purpose: news cycles are not instant. */
export const RECENCY_INFLATION_DAYS = 7;
/** Terms that assert freshness. Matched case-insensitively as whole words. */
export const TIMING_TERMS = ["just in", "breaking", "today", "yesterday", "newly", "this week", "live now", "exclusive"];

/** Our instrument's band, in microns: TESS covers roughly 600-1000 nm. */
export const TESS_BAND: Band = { loMicron: 0.6, hiMicron: 1.0 };

const NORM = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Subject terms the rig treats as load-bearing for a claim about an observation. */
const SUBJECT_TERMS = [
  "jwst", "webb", "nirspec", "nirs", "miri", "hubble", "hst", "nasa", "esa", "csa",
  "emission", "line", "spectro", "infrared", "coronagraph", "slitless", "ultra deep", "hudf",
];

/** Which load-bearing subject terms appear in a text. Pure, order-preserving, deduplicated. */
export function presentSubjectTerms(text: string): string[] {
  const n = NORM(text);
  const hits: string[] = [];
  for (const t of SUBJECT_TERMS) if (n.includes(t) && !hits.includes(t)) hits.push(t);
  return hits;
}

/**
 * Synonym CLASSES, not words. "emission line", "emitter" and "light signal" describe one phenomenon in the
 * register of a paper and of a post; matching raw tokens across those registers would score a real agreement as a
 * mismatch. Each class is small and its meaning is obvious from its members, so a reader can contest the class
 * definition rather than the outcome.
 */
export const PHENOMENON_CLASSES: string[][] = [
  ["line", "emission", "emitter", "spectra", "spectral"],
  ["single", "unidentified", "unknown", "mysterious", "puzzled", "unexplained"],
  ["empty", "void", "nothing", "blank", "no counterpart", "no source"],
  ["spectro", "slitless", "coronagraph"],
  ["deep field", "hudf"],
  ["flare", "outburst", "transient", "variable"],
];

/** Mission/platform synonyms: the same telescope written as a name, an acronym, or an agency phrase. */
const MISSION_ALIASES: Record<string, string[]> = {
  jwst: ["jwst", "webb"],
  webb: ["jwst", "webb"],
  jameswebbspace: ["jwst", "webb"],
  jameswebb: ["jwst", "webb"],
  hubble: ["hubble", "hst"],
  hst: ["hubble", "hst"],
};

/**
 * Search terms that stand for one asserted platform. Matched by CONTAINMENT rather than equality so
 * "James Webb Space Telescope", "JWST" and "the Webb observatory" all resolve to the same pair, while the literal
 * token is still tried -- an unmapped instrument name must not silently match nothing.
 */
export function platformTerms(token: string): string[] {
  const out = new Set<string>([token]);
  for (const [key, values] of Object.entries(MISSION_ALIASES)) {
    if (token.includes(key) || values.some((v) => token.includes(v))) for (const v of values) out.add(v);
  }
  return [...out];
}

/** Which phenomenon classes a text expresses. */
export function presentPhenomenonClasses(text: string): number[] {
  const n = NORM(text);
  const hits: number[] = [];
  PHENOMENON_CLASSES.forEach((cls, i) => {
    if (cls.some((w) => n.includes(w))) hits.push(i);
  });
  return hits;
}

/**
 * Tier the agreement between the post's asserted subject and the primary record.
 *
 * Rule, stated so it can be contested: MATCH requires every platform token the post asserts to appear in the
 * primary's title-or-abstract, AND at least one phenomenon CLASS in common between the post and the primary.
 * PARTIAL = platform agrees, no phenomenon class in common (the post paraphrases past the source's own terms).
 * MISMATCH = a platform the post asserts is absent from the primary record. UNRESOLVED = nothing resolvable to
 * compare. Comparing against title OR abstract is deliberate: titles omit words that posts use.
 */
export function subjectTier(claim: PublicClaim, primaries: PrimaryRecord[]): Axis<SubjectTier> {
  const live = primaries.filter((p) => p.resolved && (p.title || p.abstract));
  if (!live.length) {
    return { tier: "UNRESOLVED", basis: "no primary record resolved, so there is nothing to compare the post's asserted subject against" };
  }
  const corpus = NORM(live.map((p) => [p.title, p.abstract].filter(Boolean).join(" ; ")).join(" ; "));
  const asserted = [claim.asserted.mission, claim.asserted.instrument ?? ""]
    .map((s) => NORM(s).replace(/\s+/g, ""))
    .filter(Boolean);
  const missing = asserted.filter((a) => !platformTerms(a).some((tok) => corpus.includes(tok)));

  const postClasses = presentPhenomenonClasses(claim.text);
  const sourceClasses = presentPhenomenonClasses(corpus);
  const shared = postClasses.filter((i) => sourceClasses.includes(i));
  const sharedNames = shared.map((i) => PHENOMENON_CLASSES[i][0]);
  const className = (i: number) => PHENOMENON_CLASSES[i][0];

  if (!missing.length && shared.length) {
    return { tier: "MATCH", basis: `every asserted platform [${asserted.join(", ")}] appears in the primary record, and ${shared.length} phenomenon class(es) agree (${sharedNames.join(", ")})` };
  }
  if (!missing.length) {
    return {
      tier: "PARTIAL",
      basis: `the asserted platform appears in the primary record, but no phenomenon class is shared -- the post speaks of ${postClasses.map(className).join(", ") || "nothing classifiable"} while the source states ${sourceClasses.map(className).join(", ") || "nothing classifiable"}`,
    };
  }
  return { tier: "MISMATCH", basis: `the post asserts platform(s) absent from the primary record: ${missing.join(", ")}` };
}

/**
 * Tier the post's timing wording against the primary record's own date.
 *
 * No timing term -> NO-TIMING-CLAIM (nothing was asserted, so nothing can be wrong). Timing term plus a resolvable
 * date -> CONSISTENT when lag <= RECENCY_INFLATION_DAYS, INFLATED beyond it. Timing term with no resolvable date ->
 * UNVERIFIABLE, which is NOT the same as "wrong".
 */
export function recencyTier(claim: PublicClaim, primaries: PrimaryRecord[]): Axis<RecencyTier> & { lagDays: number | null } {
  const text = NORM(claim.text);
  const timingWords = TIMING_TERMS.filter((t) => text.includes(t));
  if (!timingWords.length) return { tier: "NO-TIMING-CLAIM", basis: "the post makes no freshness claim, so there is no timing statement to test", lagDays: null };

  const dated = primaries.filter((p) => p.resolved && p.publishedUtc && !Number.isNaN(Date.parse(p.publishedUtc)));
  if (!dated.length) {
    return { tier: "UNVERIFIABLE", basis: `the post says "${timingWords.join(", ")}" but no primary record with a date could be resolved, so the lag is unknown`, lagDays: null };
  }
  const earliest = dated.map((p) => Date.parse(String(p.publishedUtc))).sort((a, b) => a - b)[0];
  const posted = Date.parse(claim.postedUtc);
  if (Number.isNaN(posted)) {
    return { tier: "UNVERIFIABLE", basis: `the post's own timestamp could not be parsed (${claim.postedUtc})`, lagDays: null };
  }
  const lagDays = Math.round((posted - earliest) / 86400000);
  if (lagDays <= RECENCY_INFLATION_DAYS) {
    return { tier: "CONSISTENT", basis: `"${timingWords.join(", ")}" against a lag of ${lagDays} day(s), within the ${RECENCY_INFLATION_DAYS}-day allowance`, lagDays };
  }
  return { tier: "INFLATED", basis: `"${timingWords.join(", ")}" against a lag of ${lagDays} day(s) past the ${RECENCY_INFLATION_DAYS}-day allowance`, lagDays };
}

/** Attribution: did the post point at a primary at all, and does what it pointed at resolve? */
export function attributionTier(claim: PublicClaim, primaries: PrimaryRecord[]): Axis<AttributionTier> {
  const resolvedPrimary = primaries.some((p) => p.resolved);
  const unresolved = primaries.some((p) => !p.resolved && p.reason === "not-found");
  if (!claim.citedIds.length) return { tier: "NO-CITATION", basis: "the post carries no persistent identifier for the observation it announces" };
  if (resolvedPrimary) return { tier: "CITES-PRIMARY", basis: `at least one cited id resolves to a primary record (${primaries.filter((p) => p.resolved).map((p) => p.id).join(", ")})` };
  if (unresolved) return { tier: "CITATION-DOES-NOT-RESOLVE", basis: `the cited id(s) do not exist at the registering body (${claim.citedIds.join(", ")})` };
  return { tier: "CITES-SECONDARY-ONLY", basis: `cited identifier(s) [${claim.citedIds.join(", ")}] are not DOI/arXiv primaries` };
}

/** Band overlap, computed as intervals. ADJACENT means touching within 0.2 micron -- no real overlap. */
export function bandTier(claimed?: Band, source: "post" | "primary-record" | "none" = "post"): Axis<BandTier> {
  const where = source === "primary-record" ? "stated by the primary record (the post gave no number)" : "stated in the post itself";
  if (!claimed || !(claimed.hiMicron > 0) || !(claimed.hiMicron >= claimed.loMicron)) {
    return { tier: "UNSTATED", basis: "no wavelength range is available from the post or the located record, so whether our band could see it is unknown" };
  }
  const eps = 0.2;
  const overlaps = claimed.loMicron <= TESS_BAND.hiMicron && claimed.hiMicron >= TESS_BAND.loMicron;
  if (overlaps) return { tier: "OVERLAPS-US", basis: `claimed ${claimed.loMicron}-${claimed.hiMicron} micron (${where}) overlaps TESS 0.6-1.0 micron` };
  if (claimed.loMicron - TESS_BAND.hiMicron <= eps) return { tier: "ADJACENT", basis: `claimed ${claimed.loMicron}-${claimed.hiMicron} micron (${where}) abuts but does not overlap TESS 0.6-1.0 micron` };
  return { tier: "DISJOINT", basis: `claimed ${claimed.loMicron}-${claimed.hiMicron} micron (${where}) lies entirely outside TESS 0.6-1.0 micron` };
}

/**
 * What our rig could do, given the band and whatever sky-coverage evidence the caller brings (sector numbers from
 * the TESScut service). Coverage of the POSITION says nothing about the WAVELENGTH: both are reported, never merged
 * into one optimistic sentence.
 */
export function corroborationTier(band: Axis<BandTier>, sectors: number[] | null): Axis<CorroborationTier> {
  if (band.tier === "DISJOINT" || band.tier === "ADJACENT") {
    return {
      tier: "NOT-IN-OUR-BAND",
      basis:
        `the phenomenon is stated at ${band.basis}; a broadband optical photometer cannot detect or refute a line outside its band, ` +
        `even where the sky position is in our survey footprint (sectors: ${sectors ? sectors.join(",") : "not checked"})`,
    };
  }
  if (band.tier === "UNSTATED" || sectors === null) {
    return { tier: "COVERAGE-NOT-CHECKED", basis: "wavelength reach and survey coverage were not both established, so no statement is made" };
  }
  return sectors.length
    ? { tier: "COVERED-BUT-INCONCLUSIVE", basis: `our instrument covers the position (sectors ${sectors.join(",")}) and the band, but a photometric null here would not test the claim` }
    : { tier: "COVERAGE-NOT-CHECKED", basis: "our survey does not cover the position" };
}

const shortOf = (p: PrimaryRecord): string =>
  p.resolved
    ? `${p.id} (${p.venue ?? p.publisher ?? "venue unknown"}, ${String(p.publishedUtc).slice(0, 10)})`
    : `${p.id} [did not resolve: ${p.reason ?? "transport"}]`;

/** Compose every axis. Order is fixed so two runs of the same input print the same report. */
export function reviewClaim(claim: PublicClaim, primaries: PrimaryRecord[], sectors: number[] | null): ClaimReview {
  const subject = subjectTier(claim, primaries);
  const rec = recencyTier(claim, primaries);
  const attribution = attributionTier(claim, primaries.filter((p) => claim.citedIds.includes(p.id)));
  const band = bandTier(claim.asserted.band ?? claim.bandFromPrimary, claim.asserted.band ? "post" : claim.bandFromPrimary ? "primary-record" : "none");
  const corroboration = corroborationTier(band, sectors);
  const text = NORM(claim.text);
  const timingWords = TIMING_TERMS.filter((t) => text.includes(t));

  const summary = [
    `subject ${subject.tier}`,
    `attribution ${attribution.tier}`,
    `timing ${rec.tier}${rec.lagDays != null ? ` (lag ${rec.lagDays} d)` : ""}`,
    `band ${band.tier}`,
    `our reach ${corroboration.tier}`,
  ].join(" | ");

  return {
    id: claim.id,
    subject,
    recency: { tier: rec.tier, basis: rec.basis },
    attribution,
    band,
    lagDays: rec.lagDays,
    timingWords,
    corroboration,
    safeToGate: false,
    summary,
  };
}

/** The primaries' readable list, for the report body. Deterministic. */
export function primaryLines(primaries: PrimaryRecord[]): string[] {
  return primaries.map((p) => `- [${p.kind}] ${shortOf(p)}${p.title ? ` -- ${p.title}` : ""}`);
}

/**
 * Read a wavelength out of prose.
 *
 * Rule, stated so it is not a magic number: take the first micron-unit mention and the number immediately
 * before it -- units only (micron/micrometer/u-mu variants/um/mu, spelled through escapes because arXiv
 * abstracts arrive as LaTeX where 1.60 micrometers is written `1.60 $\rm \u00b5m$`, the unit split from the number
 * by macro noise). Treat it as a feature CENTRED on n, and widen by MICRON_HALF_WINDOW because a rounded popular
 * figure does not pin an interval. The pattern is anchored on the UNIT, not on any bare number: matching loose
 * "<n> m" would invent a band out of a year or a distance, and the discipline this module exists for is that a
 * band comes from citable text or not at all. No such phrase -> null, which the band axis reports as UNSTATED
 * instead of guessing.
 */
export const MICRON_HALF_WINDOW = 0.2;

/** Greek mu (U+03BC) and micro-sign (U+00B5), written as escapes so this source stays pure ASCII. */
const MU = "\u03bc\u00b5";

export function extractMicronBand(text: string): Band | null {
  const unit = `(?:microns?|micrometers?|[${MU}]m|um|mu)(?![a-z])`;
  const latex = `(?:\\s*\\$?\\s*(?:\\\\rm\\s*|\\\\mathregular\\s*)?[${MU}])`;
  // A number may be the mantissa of a scientific notation flux (2.5 x 10^-18 in cgs, where the minus can arrive as
  // an ASCII hyphen or a typographic U+2212); the guard stops such a digit from being read as a wavelength centre,
  // which is the false band this module must never print.
  const number = `(?!\\d+(?:\\.\\d+)?\\s*[\u00d7x*]\\s*10\\s*\\^?\\{?\\s*[-\u2212])?(\\d+(?:\\.\\d+)?)`;
  const m = new RegExp(`${number}\\s*(?:${unit}|${latex}\\s*m\\$?)`, "i").exec(text);
  if (!m) return null;
  const centre = Number(m[1]);
  if (!Number.isFinite(centre) || centre <= 0) return null;
  const round = (x: number) => Math.round(x * 100) / 100;
  return { loMicron: round(centre - MICRON_HALF_WINDOW), hiMicron: round(centre + MICRON_HALF_WINDOW) };
}
