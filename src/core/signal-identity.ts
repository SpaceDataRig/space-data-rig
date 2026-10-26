/**
 * SIGNAL IDENTITY (audit-16 D1/D2/D3 foundation; audit-17 defect 1/2 hardening) -- a runtime-agnostic pure module
 * that answers, from a finding's OWN fields, three questions the data model currently conflates:
 *   1. hostKeyOf      -- the HOST STAR, with the trailing planet designator removed ("HR 858 d" and "TOI-2016.01"
 *                        both reduce to their star) but a stellar COMPONENT letter kept ("HD 202772 A b" -> "hd
 *                        202772 a"), so the two components of a binary never collapse to one host. distinctHosts
 *                        must count THIS, not the raw label.
 *   2. signalKeyOf    -- a canonical (host, period, depth-ppm, snr) fingerprint of the recovered signal. Two finding
 *                        rows with the SAME signalKey are, to the measurement's precision, one physical candidate
 *                        re-detected under two seat labels -- the very duplication the fifteenth/sixteenth audit
 *                        measured live (103 rows -> 91 signals / 90 hosts; ledger 20 -> 17).
 *   3. labelConflict  -- whether the designator baked into the LABEL (requested planet, from the TOI/pscomppars seat)
 *                        DISAGREES with the designator in the finding's OWN crossmatch.knownPlanetName (detected
 *                        planet). This is D1's self-contradiction, e.g. card titled "HR 858 d" whose body says
 *                        cross-matched "HR 858 b". audit-17: a trailing TOI candidate NUMBER (".01") is a claim too
 *                        and is decoded (ExoFOP convention .01 -> b), so a label like "TOI-6054.02" whose own
 *                        crossmatch says "TOI-6054.01" is no longer invisible to the predicate.
 *
 * WHY PURE AND SHARED. The correct merge already exists (src/candidate/dedup.ts::collapseCoincident) but is offline-only
 * (scripts/p19, p22; zero production callers -- audit-16 D3). This module is the read-side, dependency-free kernel the
 * projection, the stats counters, and (later, after calibration) the mint-time suppression guard can ALL share, so the
 * "is this the same signal / does the label lie" decision cannot fork between surfaces -- the same single-source rule as
 * stats-definitions.ts. It reads nothing and mutates nothing: a finding's stored row, its bundle manifest and both hashes
 * are UNCHANGED by anything here (grep: no importer under src/bundle, src/solana or src/seats). The mint guard is
 * deliberately NOT wired in here -- suppressing a record changes which findings exist and therefore which get anchored
 * (the money path), so per this project's rule it must be gated only after measuring false-merge on real data; see
 * HANDOFF next-step.
 */

/** A trailing single-letter planet designator (" b", "\tc"), case-insensitive, only when preceded by a separator. */
const PLANET_SUFFIX = /\s+([a-z])$/i;
/** A trailing TOI/ExoFOP candidate number (".01"): the ctoi_alias index naming WHICH candidate of the host. */
const CANDIDATE_NUMBER = /\.(\d+)$/;

/** How a label states its planet claim. audit-17 Legacy 4: `requestedDesignator === null` used to mean BOTH "no claim
 * at all" and "a candidate number we refused to decode" -- ambiguous over the 62 served rows with no trailing letter.
 * This separates the two so a reader knows whether a null is a true absence or an undecodable index. */
export type DesignatorKind = "planet-letter" | "candidate-number" | "none";

/** ExoFOP/TIS convention: candidate `.01` is the host's first catalogued planet (`b`), `.02` the second (`c`), and so
 * on. A candidate index IS a claim about which planet of the host, so it decodes to a letter instead of reading as
 * "no claim" (audit-17 defect 1: refusing to decode hid two live self-contradictions -- TOI-6054.02 whose own
 * crossmatch says TOI-6054.01, and TOI-4443 c whose crossmatch says TOI-4443.01). Returns null past `.25` because no
 * single-letter planet designator exists beyond `z`, so an out-of-range index is honestly "undecodable", never a
 * silently wrong letter. */
export function candidateNumberToLetter(nn: string): string | null {
  const n = parseInt(nn, 10);
  return Number.isInteger(n) && n >= 1 && n <= 25 ? String.fromCharCode(97 + n) : null; // .01 -> b ... .25 -> z
}

/** Reduce a target id to its HOST STAR. audit-17 defect 2: strip only ONE trailing planet letter, so a stellar
 * COMPONENT letter (the "A" in "HD 202772 A b") is KEPT -- the components of a binary are different stars and must
 * never share a host key (the old loop stripped both, so hostKeyOf("HD 202772 A b") === hostKeyOf("HD 202772 B b"),
 * a latent false-merge source for distinctHosts and for signalKeyOf). Trailing candidate numbers (".01") are still
 * stripped, so a compound label ("TOI-2016.01 b") reduces fully to the star. A bare component with no planet letter
 * ("HD 202772 A") still loses its letter, but a finding always carries a planet designator or a candidate number, so
 * that case does not arise in the served catalog (measured: the component-preserving key leaves distinctHosts at 90
 * with zero cross-star merges). */
export function hostKeyOf(targetId: string): string {
  let key = targetId.trim().toLowerCase().replace(/\s+/g, " ");
  key = key.replace(PLANET_SUFFIX, "").trim(); // exactly one planet designator letter; a preceding component survives
  for (;;) {
    const next = key.replace(/\.\d+$/, "").replace(/\s+/g, " ").trim();
    if (next === key) return key;
    key = next;
  }
}

/** The designator letter the LABEL claims: a literal trailing planet letter as-is, a trailing candidate number decoded
 * by the ExoFOP convention (".01" -> "b"), else null. Pair with designatorKindOf to know which of the three it was. */
export function labelDesignatorOf(targetId: string): string | null {
  const t = targetId.trim();
  const letter = t.match(PLANET_SUFFIX);
  if (letter) return letter[1].toLowerCase();
  const num = t.match(CANDIDATE_NUMBER);
  return num ? candidateNumberToLetter(num[1]) : null;
}

/** The designator letter of a crossmatched known-planet name, decoded exactly as the label is ("HR 858 b" -> "b";
 * "TOI-4443.01" -> "b"), so the two sides of a conflict are comparable on one rule. */
export function knownDesignatorOf(knownPlanetName: string): string | null {
  return labelDesignatorOf(knownPlanetName);
}

/** Whether a label states its claim as a planet letter, a candidate number, or neither (audit-17 Legacy 4). */
export function designatorKindOf(targetId: string): DesignatorKind {
  const t = targetId.trim();
  if (PLANET_SUFFIX.test(t)) return "planet-letter";
  if (CANDIDATE_NUMBER.test(t)) return "candidate-number";
  return "none";
}

/**
 * A canonical fingerprint of the recovered signal, at the precision the sixth-round audit merged on: host star, period
 * rounded to 1e-9 days, depth in whole ppm, SNR rounded to 1e-6. Equal keys == one physical candidate.
 */
export function signalKeyOf(targetId: string, periodDays: number, depthFrac: number, snr: number): string {
  const ppm = Math.round(depthFrac * 1e6);
  const per = Number.isFinite(periodDays) ? Math.round(periodDays * 1e9) : "nan";
  const sn = Number.isFinite(snr) ? Math.round(snr * 1e6) : "nan";
  return `${hostKeyOf(targetId)}|${per}|${ppm}|${sn}`;
}

interface CrossmatchLike {
  matchedKnownPlanet?: boolean;
  knownPlanetName?: string;
}

/**
 * Does the label's requested planet disagree with the finding's OWN detected-planet crossmatch? Only meaningful when a
 * same-host known-planet name is present; a mismatch (different designator on the same star) is the D1 conflict. Both
 * designators are decoded the same way (a candidate number counts as a claim), and same-host is decided by the
 * component-preserving hostKeyOf, so two different stars of a binary are never called a self-contradiction. The
 * requested/detected KIND is returned alongside so the disclosure can say whether a designator was a literal letter or
 * a decoded candidate number.
 *
 * COST of that benefit (round-18 audit; pinned by tests/signal-identity.test.ts, not left as prose): same-host is a
 * string equality of the two component-preserving keys, so a label that carries a stellar component the crossmatched
 * name lacks ("HD 202772 A c" vs known "HD 202772 b") yields DIFFERENT host keys ("hd 202772 a" vs "hd 202772") and a
 * genuine designator disagreement (c vs b) is SUPPRESSED -- conflict false -- and signalKeyOf, keyed on the same host,
 * will not merge the pair either. That is the deliberate price of never falsely merging a binary's two stars. It is
 * LATENT, not live: the served catalog holds 0 bare-component labels and 0 asymmetric-component rows (measured on the
 * live catalog before pinning), so no served count changes today. It is documented and tested rather than "fixed"
 * because the change would be a no-op on live data and the false-merge it prevents is the worse failure -- but any
 * future mint guard that dedups on signalKeyOf must confront this asymmetry deliberately, or it becomes a duplicate.
 */
export function labelConflict(
  targetId: string,
  crossmatch?: CrossmatchLike,
): { conflict: boolean; status: "conflict" | "clear" | "unverifiable"; requested: string | null; detected: string | null; requestedKind: DesignatorKind; detectedKind: DesignatorKind } {
  const req = labelDesignatorOf(targetId);
  const known = crossmatch?.knownPlanetName;
  const det = known ? knownDesignatorOf(known) : null;
  const sameHost = !!known && hostKeyOf(known) === hostKeyOf(targetId);
  const conflict = sameHost && req != null && det != null && req !== det;
  return {
    conflict,
    // Round-21 audit defect 5: the predicate can only judge when BOTH sides carry a planet letter. When
    // either side is null (a bare star label, or a label letter with no cross-matched name) `conflict`
    // is false NOT because the letters agree but because there is nothing to compare -- five anchored
    // identifiers assert a letter this predicate structurally never checks. Say so explicitly instead of
    // silently returning false, so the limitation is first-class data a reader (and the anchor-health
    // aggregate) can act on.
    status: req == null || det == null ? "unverifiable" : conflict ? "conflict" : "clear",
    requested: req,
    detected: det,
    requestedKind: designatorKindOf(targetId),
    detectedKind: known ? designatorKindOf(known) : "none",
  };
}

/** Group findings by signalKey; groups with >1 member are the duplicate-label rows (D1/D2/D3 evidence). */
export function groupBySignal<T extends { targetId: string; candidate: { periodDays: number; depthFrac: number; snr: number } }>(
  findings: T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const f of findings) {
    const k = signalKeyOf(f.targetId, f.candidate.periodDays, f.candidate.depthFrac, f.candidate.snr);
    const arr = out.get(k);
    if (arr) arr.push(f);
    else out.set(k, [f]);
  }
  return out;
}
