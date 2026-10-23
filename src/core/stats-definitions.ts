/**
 * PUBLIC STAT DEFINITIONS -- the population each published counter actually counts.
 *
 * WHY. The rig has already been caught publishing a number whose label did not match its query: `bundlesAnchored`
 * was presented as "on-chain" while it counted only findings whose CURRENT bytes still matched a commitment, and the
 * ledger held 18 against a tile of 7 (audit-6). The same class of defect lives in the three ROTATION counters, and
 * in one case it is already measurable in production: the board's "blind candidates" counts every blind-toi row
 * including the ones the critic REJECTED, while the X digest deliberately counts only surviving ones -- so the two
 * public surfaces quote different populations of the same phrase, and neither says which.
 *
 * RULE. One predicate per population, defined here, imported by BOTH runtimes and by the digest; the DO's SQL is
 * declared beside it as data so tests/stats-definitions.test.ts can check the two agree on real rows (in SQLite
 * when the runner has it, on the literal shape when it does not -- never silently). The public sentence is here too:
 * a definition that lives only in a comment can drift, one that the surface renders cannot be forgotten.
 *
 * Nothing in this module gates, anchors or claims; it is arithmetic over rows that already exist.
 */

/** The minimum a row must expose for these counters. Both runtimes' finding rows satisfy it. */
export interface StatRow {
  targetId?: string;
  origin?: string;
  verdict?: string;
}

/** A blind row: an UNCONFIRMED TOI the detector recovered blind on real photometry (never shown the ephemeris). */
export function isBlindCandidate(f: StatRow): boolean {
  return f.origin === "blind-toi";
}

/**
 * A blind row still HELD for human follow-up. A critic-rejected blind row is noise the pipeline cleared, not a
 * lead -- the same distinction scripts/science-digest.ts has always drawn in its wording, now made the single
 * source of truth so the board and the feed cannot count one phrase two ways.
 * A row with no verdict yet is held (the JS `!== "rejected"` reading), and the SQL says the same with IS NULL.
 */
export function isHeldBlindCandidate(f: StatRow): boolean {
  return isBlindCandidate(f) && f.verdict !== "rejected";
}

/** The same two populations as SQL, for the Durable Object, built from these constants so neither can be edited alone. */
export const BLIND_CANDIDATE_SQL = `json_extract(data,'$.origin') = 'blind-toi'`;
export const BLIND_HELD_SQL = `${BLIND_CANDIDATE_SQL} AND (json_extract(data,'$.verdict') IS NULL OR json_extract(data,'$.verdict') != 'rejected')`;

/**
 * The definition sentence for each counter, in the words a reader sees. Long on purpose: each one names the
 * population AND the case that is excluded, which is the part a label of two words cannot carry.
 *
 * THIS OBJECT IS PUBLISHED, NOT DOCUMENTATION. It rides the state payload (`DashboardState.statDefinitions`) out of
 * both runtimes, and the browser writes the tooltip text from that payload. Copying these sentences into
 * web/index.html would create a second source that can disagree with the query it describes -- the exact failure
 * this module exists to prevent -- so the markup carries none of them and tests/stats-definitions.test.ts pins that.
 */
export const PUBLIC_STAT_DEFINITIONS = {
  surveyPass:
    "Rotating survey passes CLAIMED, not completed: the cursor advances when a run takes the slot (src/cf/run-mutex.ts), " +
    "so a pass that hangs after claiming still counts and is never counted twice -- that advance-at-claim rule is what " +
    "unfroze the 22-hour stall, and it means this number is not a promise that all those passes finished.",
  distinctHosts:
    "Distinct HOST STARS among RECORDED RESULTS (any verdict, accepted, watchlist or rejected), with each target's " +
    "planet designator / TOI candidate number stripped first (src/core/signal-identity.ts). Audit-16: this used to " +
    "count RAW LABELS, so one star recorded under several seat labels (HR 858 b/c/d, TOI-2016.01/.02) read as several " +
    "hosts -- live it inflated 90 stars to 103; the raw-label reading is now the separate distinctRecords counter. It " +
    "is still not the number of targets analysed (that is the 'targets' tile): it grows only when a look becomes a row.",
  distinctRecords:
    "Distinct recorded TARGET LABELS (raw targetId strings, planet designators and TOI candidate numbers included). " +
    "This is the count distinctHosts reported before audit-16 split host stars from labels; a star re-detected under " +
    "two seat labels counts twice here and once in distinctHosts, so the gap between the two is exactly the duplicate-" +
    "label rows the board still carries (measured live: 103 labels over 90 host stars).",
  blindCandidates:
    "Blind TOI rows assessed: every result the detector recovered BLIND on real photometry, including the ones the " +
    "critic later rejected as noise. Never anchored, never a claim.",
  blindHeld:
    "Blind rows still HELD for human follow-up -- blind candidates assessed minus those the critic rejected. This is " +
    "the number the X digest quotes for 'records N candidates', and the two are the same rule, not two rules.",
  bundlesAnchored:
    "Findings whose CURRENTLY PUBLISHED bundle bytes match a landed chain commitment. This is a coverage measure, " +
    "never a total: a bundle hash folds the run timestamp, so any re-derive swaps in a new hash the chain never saw, " +
    "and while science-hash dedup is ON (an identical-content repeat is deliberately not re-anchored, so no second " +
    "fee is spent) the newer bytes are never freshly committed -- this can therefore sit at 0 for weeks while real " +
    "commitments stand on mainnet. It is NOT the answer to 'how much has this rig put on chain'; that is " +
    "ledgerAnchored. (Audit-12 named this mutual exclusion: dedup and current-byte coverage cannot both be true of " +
    "the same science, and this project chose dedup, so this number is read as a floor, not as an achievement.)",
  ledgerAnchored:
    "Ledger rows recording commitments that landed (status anchored AND a signature present). A historical total: it " +
    "survives re-derivation and dedup and is never demoted by a later attempt that failed, because a transaction on " +
    "mainnet cannot be un-made by a newer local byte generation. It answers 'how many results has this rig put on " +
    "chain'; whether the bytes on the site right now are each covered by one of those commitments is the separate " +
    "(and routinely much smaller -- it can be zero while every commitment above stands) bundlesAnchored question -- " +
    "finding cards show their own verify state precisely because a landed total says nothing about current bytes.",
} as const;

/** The shape both runtimes publish, so a surface cannot add a counter without defining what it counts. */
export type PublicStatDefinitions = typeof PUBLIC_STAT_DEFINITIONS;

/** The rendered survey line, shared by both surfaces so the wording itself cannot fork. */
export function surveyStatsSentence(s: {
  surveyPass: number;
  distinctHosts: number;
  blindHeld: number;
  blindCandidates: number;
}): string {
  return (
    `survey pass ${s.surveyPass} claimed - ${s.distinctHosts} hosts with recorded results - ` +
    `${s.blindHeld}/${s.blindCandidates} blind candidates held/assessed (unconfirmed)`
  );
}
