// SCIENCE DIGEST: compose ONE honest, English-only long-form post about the most important science the rig
// produced in a time window, for the half-hourly X (Twitter) digest. The author is a Premium ("blue") account,
// so a post may run well past the classic 280 chars (X allows up to 25,000 weighted chars): each digest is a
// compact multi-sentence summary -- the result, the key numbers, and the link -- rather than one clipped
// sentence. The channel LEADS WITH SCIENCE (a result sealed on-chain, a newly flagged candidate, or a research
// milestone). When a window has NO new science it no longer stays silent by default: it may fall back to a BUILD
// NOTE over the commits since the last post (the development-progress tier), and only when there is neither new
// science nor a buildable commit does it drop to the silence heartbeat -- so the feed reports either a real result
// or the work keeping the rig running, and never an empty tweet (see .github/workflows/x-post.yml).
//
// Red lines (enforced here AND in scripts/post-x-text.ts, which refuses any non-ASCII byte):
//  - English-only ASCII; no time-implying words (this week / recently / overnight / today ...).
//  - NEVER claims a new planet. A blind candidate is always "UNCONFIRMED ... for human follow-up".
//  - Honesty is carried by PLAIN WORDING + numbers-with-basis, NOT by stamping "discoveryClaim=false" on every
//    post -- the maintainer asked to stop repeating that disclaimer, so the literal stamp no longer appears.
//  - Numbers carry their basis (purity is a LOWER bound). No wallet / key / cost is ever mentioned.
//  - Photon-tier honesty: only blind-TOI findings are contractually "recovered on real photometry"
//    (src/core/types.ts Finding.origin), so only those may say "real TESS photometry"; a known-planet
//    re-validation may run on seeded stand-ins, so its line never claims the pixels were real.
//  - composeDigest is PURE (no clock, no network, no git): it takes the window + already-fetched data and
//    returns text, so it is fully unit-testable (tests/science-digest.test.ts). All I/O lives in main().
//
// Usage (the workflow calls this; a human rarely needs to):
//   npm run science:digest -- --since 2026-10-16T10:00:00Z --out out/digest.txt [--research-updated 1]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderPeriodDays } from "../src/core/periodFormat.ts";
import { isHeldBlindCandidate } from "../src/core/stats-definitions.ts";

const SITE = "spacedatarig.app";
// Proof-link targets. Every one is a real, committed artifact served from the production site (Cloudflare
// static assets) and was verified reachable AND corresponding to the numbers the digest cites:
//   research.json       -- the authoritative bundle behind every cited number (stars/completeness/purity/recall).
//   results-figure.svg  -- P37: Panel A completeness-vs-depth (the TypeScript box-fit BLS series IS
//                          survey.completeness), Panel B blind purity as raw TP/FP (the survey.purity LOWER
//                          bound). Linked ONLY when a completeness/purity number is cited, so it always corresponds.
//   p49-blind-test.html -- the sealed-key blind test; its recall/precision match research.blindTest exactly.
//                          Linked ONLY when the blind-test numbers are cited.
// DELIBERATELY EXCLUDED: P47 (completeness-grid) is a DIFFERENT experiment (960 injections into 20 curves) and
// does not match survey.completeness, and milestone-figure.svg depicts P62-P65 (joint-fold/soft-score/telemetry/
// audit), not these numbers. A proof link must correspond to the exact number it is offered for, never merely
// sound related -- so neither is linked here.
const URL_LIVE = `https://${SITE}`; // bare domain, no trailing slash: the post ends on it (see tests)
const URL_RESEARCH = `https://${SITE}/research.json`;
const URL_RESULTS_FIG = `https://${SITE}/results-figure.svg`;
const URL_P49 = `https://${SITE}/reports/p49-blind-test.html`;
const URL_REPO = "https://github.com/SpaceDataRig/space-data-rig"; // build-note proof: the code + history itself

export interface DigestLedgerEntry {
  findingId?: string;
  status?: string;
  signature?: string;
  explorerUrl?: string;
  anchoredAt?: string;
}
export interface DigestFinding {
  id?: string;
  targetId?: string;
  verdict?: string;
  origin?: string;
  createdAt?: string;
  candidate?: {
    periodDays?: number;
    /** Grid-limited period uncertainty the detector recorded. Absent on records predating it. */
    periodResolutionDays?: number;
    /** The adopted peak is the long-period edge of the trial grid: a limit, not a measurement. */
    atSearchBoundary?: boolean;
    searchMaxPeriodDays?: number;
  };
  crossmatch?: { matchedKnownPlanet?: boolean; knownPlanetName?: string };
  /** Targeted re-injection trials: the rig's own conditional trust measure for this signal. */
  recoveryTrials?: { nTrials?: number; nRecovered?: number };
  /** Mission-critic composite ranking score, 0..100. A ranking aid, not a verdict. */
  score?: number;
}
export interface DigestCompletenessPoint {
  depthPpm?: number;
  rate?: number;
}
export interface DigestResearch {
  survey?: { stars?: number; purity?: number; completeness?: DigestCompletenessPoint[] };
  blindTest?: { recall?: number; precision?: number };
}
export interface DigestInput {
  windowStart: string; // ISO 8601
  windowEnd: string; // ISO 8601
  ledger: DigestLedgerEntry[];
  findings: DigestFinding[];
  research: DigestResearch | null;
  /** Did web/research.json land in this window? The workflow decides (via git) and passes it in. */
  researchUpdated: boolean;
  /** Minutes since the channel last posted a tweet (from the workflow's X read). Unknown -> heartbeat disabled. */
  silentMinutes?: number;
  /** A heartbeat fires only when silentMinutes >= this. 0/absent disables it, so the science path is unchanged. */
  heartbeatAfterMinutes?: number;
  /** Notable commit subjects since the last post (from the workflow's git read). When a window has no science, a
   *  non-empty list lets composeDigest emit a BUILD NOTE (development-progress tier) instead of staying silent. */
  devCommits?: string[];
  /** Bullet texts the feed has ALREADY announced (x-last-post.reportedSubjects). The dev window overlaps its own
   *  cursor by a few minutes so a commit landing mid-run is never skipped forever; this set is what makes that
   *  overlap safe -- an already-announced subject is dropped instead of being posted twice. */
  alreadyReported?: string[];
  /** Restrict composition to one tier: "ledger" | "blind" | "milestone" | "science" (those three) | "build-note"
   *  | "heartbeat". Absent/"" keeps the historical behavior -- the FIRST tier with something to report wins and
   *  exactly one post comes back. The workflow now asks tier by tier so ONE window can yield SEVERAL posts: the
   *  one-post-per-window cap was a rationing decision, not an honesty one, and it silently dropped reportable work. */
  only?: string;
}

function within(iso: string | undefined, start: number, end: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= start && t <= end;
}

/** X's long-post ceiling for a Premium author, in weighted chars (CJK/emoji count 2, any URL counts 23). Our
 *  text is pure ASCII; even with several proof-link URLs the weighted count stays far below this cap (a composed
 *  digest is ~1,200 chars). This is a hard safety net (never a target), mirroring the clamp in post-x-text.ts so
 *  composeDigest can never overflow.
 *
 *  clip() PRESERVES the intentional line structure of the long-form post -- X renders newlines (it has no rich
 *  text, so layout is newlines + ASCII only). It normalizes CRLF->LF, collapses runs of spaces/tabs WITHIN each
 *  line, trims each line, and squeezes 3+ newlines to one blank line, but never joins lines. post-x-text.ts
 *  applies the identical normalization, so what is composed here is byte-for-byte what is sent. */
const MAX_LEN = 25000;
function normalizeLines(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((ln) => ln.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function clip(s: string): string {
  const t = normalizeLines(s);
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 3).trimEnd()}...` : t;
}

/** Join non-empty blocks with a blank line between them (X renders the newline; there is no rich text). */
function blocks(...parts: string[]): string {
  return parts.filter((p) => p && p.trim().length > 0).join("\n\n");
}

function periodDays(f: DigestFinding | undefined): number | null {
  const p = f?.candidate?.periodDays;
  return p != null && Number.isFinite(p) ? p : null;
}

/**
 * A period phrase fit for the public feed. Two separate honesty problems are fixed here:
 *
 * 1. The recovered period is a discrete BLS grid node, and the node spacing grows as P^2 -- about 0.02 d at
 *    P=2 d but about 1 d at P=16 d on a single-sector baseline. The old `P=${pd.toFixed(2)}d` therefore claimed
 *    hundredths of a day on a long period that the search could not resolve, and it did so on X.
 * 2. A peak sitting on the longest period the grid tried is not a measurement at all. Measured on the live rig:
 *    3 of 90 findings had periodDays exactly 16.000000, the k=0 node of a 16-day maximum, and one of them was
 *    announced as "P=16.00d". That is now stated as a limit.
 *
 * Returns "" when there is no usable period, so callers can omit the clause rather than print a placeholder.
 */
function periodPhrase(f: DigestFinding | undefined): string {
  const p = periodDays(f);
  if (p === null) return "";
  if (f?.candidate?.atSearchBoundary) {
    const lim = renderPeriodDays(p, undefined, false).value;
    return `P at the ${lim}-day search limit (a longer period cannot be ruled out)`;
  }
  const r = renderPeriodDays(p, f?.candidate?.periodResolutionDays, true);
  return r.uncertainty ? `P=${r.value} +/- ${r.uncertainty} d` : `P=${r.value} d`;
}

/** The rig's own conditional trust measure, quoted with its denominator so a small trial count cannot read as
 *  a confident percentage. "" when the record carries no trials. */
function recoveryPhrase(f: DigestFinding | undefined): string {
  const t = f?.recoveryTrials;
  if (!t || t.nTrials == null || t.nTrials <= 0 || t.nRecovered == null) return "";
  return `re-injection recovered it in ${t.nRecovered}/${t.nTrials} trials`;
}

/** Rank for choosing which candidate to NAME on the feed: best-supported first. Recovery fraction dominates,
 *  the critic score breaks ties. Ordering by createdAt instead (the old behaviour) made the exemplar an
 *  arbitrary recent row rather than the strongest one in the batch. */
function exemplarRank(f: DigestFinding): number {
  const t = f.recoveryTrials;
  const frac = t && t.nTrials && t.nTrials > 0 ? (t.nRecovered ?? 0) / t.nTrials : -1;
  return frac * 1000 + (f.score ?? 0);
}

/** A ledger explorerUrl is only safe to print when it is a plain-ASCII https URL with no whitespace: a malformed
 *  or non-ASCII value would either break the red lines or make post-x-text.ts refuse the WHOLE post. Anything
 *  else is dropped, so the digest omits the on-chain link rather than risk printing a bad one. */
function safeTxUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const t = u.trim();
  if (!/^https:\/\/\S+$/.test(t)) return null;
  if (/[^\x00-\x7F]/.test(t)) return null;
  return t;
}

/** The most recent valid on-chain transaction URL among the anchored rows (newest anchoredAt first), or null. */
function newestTxUrl(entries: DigestLedgerEntry[]): string | null {
  const sorted = entries
    .filter((e) => e && safeTxUrl(e.explorerUrl))
    .sort((a, b) => String(b.anchoredAt || "").localeCompare(String(a.anchoredAt || "")));
  return sorted.length ? safeTxUrl(sorted[0].explorerUrl) : null;
}

/** What the characterization block cited, so the Proof block links ONLY the artifacts that correspond to a
 *  number actually shown (results-figure.svg for completeness/purity; the P49 report for recall/precision). */
interface Characterization {
  block: string; // multi-line: a lead line, then "- " bullets; "" when there is no survey to cite
  citesFigure: boolean; // a completeness or purity number was cited -> results-figure.svg corresponds
  citesBlindTest: boolean; // recall/precision cited -> the P49 blind-test report corresponds
}

/**
 * Build the standing-characterization block from web/research.json as a lead line + ASCII bullets, or an empty
 * block when there is no survey to cite. Every number is read from the data (never hardcoded); purity is
 * labelled the LOWER bound it is, and the blind test is labelled an independent cross-check. `lead` lets a
 * caller phrase it as "separately characterized" (context inside an event post) or "is characterized" (the
 * research-milestone post itself), which keeps a known-planet re-validation honestly separate from the
 * detector's real-photometry survey.
 */
function characterization(research: DigestResearch | null | undefined, lead: string): Characterization {
  const empty: Characterization = { block: "", citesFigure: false, citesBlindTest: false };
  const survey = research?.survey;
  if (!survey || survey.stars == null || !Number.isFinite(survey.stars)) return empty;

  const bullets: string[] = [];
  let citesFigure = false;

  const rawComp: DigestCompletenessPoint[] = Array.isArray(survey.completeness) ? survey.completeness : [];
  const comp = rawComp
    .filter((c) => Boolean(c) && Number.isFinite(c.depthPpm) && Number.isFinite(c.rate))
    .map((c) => ({ depthPpm: c.depthPpm as number, rate: c.rate as number }))
    .sort((a, b) => a.depthPpm - b.depthPpm);
  if (comp.length >= 2) {
    const lo = comp[0];
    const hi = comp[comp.length - 1];
    bullets.push(`Injection-recovery completeness rises from ${Math.round(lo.rate * 100)}% at ${lo.depthPpm} ppm to ${Math.round(hi.rate * 100)}% at ${hi.depthPpm} ppm.`);
    citesFigure = true;
  } else if (comp.length === 1) {
    bullets.push(`Injection-recovery completeness is ${Math.round(comp[0].rate * 100)}% at ${comp[0].depthPpm} ppm.`);
    citesFigure = true;
  }

  if (survey.purity != null && Number.isFinite(survey.purity)) {
    bullets.push(`The purity LOWER bound is ${Math.round(survey.purity * 100)}% -- a genuine but uncatalogued planet is counted against it, so the true value can only be higher.`);
    citesFigure = true;
  }

  const bt = research?.blindTest;
  let citesBlindTest = false;
  if (bt && Number.isFinite(bt.recall) && Number.isFinite(bt.precision)) {
    citesBlindTest = true;
    bullets.push(`An independent sealed-key blind test measured ${Math.round((bt.recall as number) * 100)}% recall at ${Math.round((bt.precision as number) * 100)}% precision.`);
  }

  const head = `${lead} ${survey.stars} real public TESS-SPOC stars${bullets.length ? ":" : "."}`;
  const block = bullets.length ? `${head}\n${bullets.map((b) => `- ${b}`).join("\n")}` : head;
  return { block, citesFigure, citesBlindTest };
}

/**
 * The Proof block: verifiable links, each offered ONLY for content the post actually states. On-chain tx (when
 * this window anchored one), research.json (when any number is cited), the results figure (when completeness or
 * purity is cited), the P49 blind-test report (when recall/precision is cited), and always the live rig root.
 */
function proofBlock(char: Characterization, txUrl: string | null): string {
  const lines: string[] = [];
  if (txUrl) lines.push(`- On-chain transaction: ${txUrl}`);
  if (char.block) lines.push(`- Numbers + data (research.json): ${URL_RESEARCH}`);
  if (char.citesFigure) lines.push(`- Completeness & purity figure: ${URL_RESULTS_FIG}`);
  if (char.citesBlindTest) lines.push(`- Blind test (recall/precision): ${URL_P49}`);
  lines.push(`- Live rig + full methods: ${URL_LIVE}`);
  return `Proof:\n${lines.join("\n")}`;
}

/**
 * The silence heartbeat -- the documented FALLBACK, reached only when the science tiers above had nothing new to
 * report AND the workflow reports the channel has been quiet past its threshold. It states the honest situation
 * (the survey is still running; nothing is newly sealed on-chain or newly flagged) so a quiet stretch is not
 * mistaken for downtime. Every figure is a current catalog fact already in the inputs (total blind candidates held
 * for follow-up, results sealed so far, the standing star characterization) -- it never claims a discovery and
 * never mentions spend. It links only the live rig and (when a number is cited) research.json; no transaction,
 * since nothing was newly sealed. Disabled unless a threshold is supplied, so the default science path is byte-for-byte unchanged.
 */
/**
 * The heartbeat's opening line, kept here (the single place that composes it) for the same reason as
 * BUILD_NOTE_HEADLINES: scripts/x-last-post.ts must recognise a status post on the feed so the SCIENCE cursor can
 * skip it. A heartbeat fires only when the science tier found nothing, so letting it advance the science window
 * would drop anything created during that run.
 */
export const HEARTBEAT_HEADLINE = "Space Data Rig status.";

/**
 * Hard ceiling on bullets in ONE build note -- a safety net, NOT a ration. The workflow batches the commit backlog
 * into chunks smaller than this (DEV_BATCH) and posts one note per chunk, so nothing is dropped by the slice; if a
 * caller hands over an unbatched list, this keeps the post inside X's long-form ceiling instead of letting clip()
 * truncate mid-sentence (which would silently drop the tail). tests/science-digest.test.ts reads the workflow's
 * DEV_BATCH default and asserts it stays under this number, so the two cannot drift apart.
 */
export const DEV_BULLETS_MAX = 40;

function heartbeat(input: DigestInput): string {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const survey = input.research?.survey;
  const stars = survey && survey.stars != null && Number.isFinite(survey.stars) ? survey.stars : null;

  const body: string[] = [
    "The survey is running on its own against public NASA TESS light curves, and there is nothing newly sealed on-chain or newly flagged to report at this check.",
  ];
  if (stars != null) body.push(`The detector keeps operating against its characterization on ${stars} real public TESS-SPOC stars.`);
  // Surviving blind candidates only -- a rejected blind row is noise the critic cleared, not something held for
  // follow-up, so it must not inflate the "records N candidates" count (mirrors the science tier above). This is
  // now the SAME predicate the dashboard's blindHeld counter uses (src/core/stats-definitions.ts), not a parallel
  // copy: the board and this feed must not count one phrase "blind candidate" two different populations.
  const blindTotal = findings.filter((f) => f && isHeldBlindCandidate(f)).length;
  body.push(
    blindTotal > 0
      ? `The catalog currently records ${blindTotal} UNCONFIRMED blind candidate${blindTotal === 1 ? "" : "s"}, held for human follow-up rather than any claim.`
      : "The catalog currently holds no UNCONFIRMED blind candidate awaiting follow-up.",
  );
  const sealed = ledger.filter((e) => e && e.signature && e.anchoredAt);
  body.push(
    sealed.length > 0
      ? `${sealed.length} analysis result${sealed.length === 1 ? " has" : "s have"} been sealed on-chain so far.`
      : "No analysis has been sealed on-chain yet.",
  );
  body.push("The next update posts here on its own once there is a new result or candidate to report.");

  const proof: string[] = [];
  if (stars != null) proof.push(`- Numbers + data (research.json): ${URL_RESEARCH}`);
  proof.push(`- Live rig + full methods: ${URL_LIVE}`);

  return clip(
    blocks(
      HEARTBEAT_HEADLINE,
      body.join("\n"),
      `Proof:\n${proof.join("\n")}`,
    ),
  );
}

/** An empty characterization -- used by the routine result/candidate posts, which deliberately carry NO standing
 *  methodology block so consecutive posts do not read as copy-paste. proofBlock(EMPTY_CHAR, tx) then emits only
 *  the transaction (when the window sealed one) plus the live rig. */
const EMPTY_CHAR: Characterization = { block: "", citesFigure: false, citesBlindTest: false };

/** Deterministic variant picker: FNV-1a hash a stable seed and choose among honest rephrasings, so posts over
 *  DIFFERENT windows read differently while composeDigest stays pure (no clock/random) and reproducible in tests. */
function pick(list: string[], seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[Math.abs(h) % list.length];
}

/**
 * The exact headlines the BUILD NOTE tier can open with. `pick()` rotates between them deterministically so
 * consecutive notes do not read identically, which means a note is identified by MEMBERSHIP in this list, not by
 * one fixed string.
 *
 * WHY THIS IS EXPORTED (audit-6 follow-up): scripts/x-last-post.ts has to recognise a build note among the
 * account's recent tweets in order to give the dev tier its OWN cursor. Before that, both tiers shared one cursor
 * anchored to the newest tweet of any kind, so every science post silently consumed the commit backlog: the run
 * that reported 3 new UNCONFIRMED candidates advanced the cursor past two fix commits, and the build-note tier --
 * reached only when a window has NO science -- never saw them. They were dropped permanently. Keeping the
 * headlines here (the single place that composes them) and importing them there means a future wording change
 * cannot quietly break the matcher; tests/x-last-post.test.ts asserts every entry is still recognised.
 */
export const BUILD_NOTE_HEADLINES: readonly string[] = [
  "Under the hood, what changed in how Space Data Rig runs:",
  "Not a science result -- a build note on the pipeline itself:",
  "Changes to the machinery behind Space Data Rig:",
];

/** One dev commit subject -> `{ text, reason }`. `text` is the safe bullet line ("" when the subject must be
 *  dropped); `reason` says WHY, so a dropped commit is never silent -- main() logs every rejection.
 *
 *  Collapses whitespace, strips non-ASCII, caps length, and DROPS anything that would break a red line (mentions
 *  spend/wallet/key, or a time word) so a build note can never leak a banned term. The raw text still hits
 *  post-x-text.ts's own non-ASCII refusal as a second guard.
 *
 *  The over-claim check exists because of a stall specific to the UN-RATIONED posting path. post-x-text.ts runs
 *  overclaimViolations over the FINAL text of every post and refuses on a hit, exiting non-zero; the workflow's
 *  posting loop then BREAKS so the build-note cursor does not advance past an unsent item. Those two correct
 *  decisions combine badly: one subject reading `feat(p17): first-light FFI feasibility` would poison its whole
 *  batch permanently -- every window re-composes the same note, is refused, and the backlog never clears. Dropping
 *  the offending subject and SAYING so is the only option that keeps the feed moving; the commit itself is still in
 *  the history. Note `\bfirst\b` also matches inside a hyphenated "oldest-first", so this is not exotic vocabulary.
 */
function classifySubject(raw: string): { text: string; reason: string } {
  const s = String(raw || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim();
  if (!s) return { text: "", reason: "empty" };
  if (/wallet|private key|secret key|seed phrase|\bcost\b|\busd\b|\bsol\b|\$\d/i.test(s)) return { text: "", reason: "spend/key wording" };
  if (/\b(this week|last week|next week|recently|overnight|today|tonight|yesterday)\b/i.test(s)) return { text: "", reason: "time-implying wording" };
  const capped = s.length > 140 ? `${s.slice(0, 137).trimEnd()}...` : s;
  const over = overclaimViolations(capped);
  if (over.length > 0) return { text: "", reason: `over-claim wording (${over[0].split(" :: ")[0]})` };
  return { text: capped, reason: "" };
}

/** The bullet text for one commit subject, or "" to drop it. Kept as the one place composeDigest maps subjects. */
function sanitizeSubject(raw: string): string {
  return classifySubject(raw).text;
}

/**
 * The subjects from `raw` that would be DROPPED, each with its reason. main() logs these so the feed's silence
 * about a commit is explainable from a job log rather than invisible -- the whole defect class the un-rationing
 * change was about was reportable work disappearing without a trace.
 */
export function rejectedDevSubjects(raw: string[]): Array<{ subject: string; reason: string }> {
  const out: Array<{ subject: string; reason: string }> = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const c = classifySubject(r);
    if (!c.text && c.reason !== "empty") out.push({ subject: String(r ?? "").trim(), reason: c.reason });
  }
  return out;
}

/**
 * Return the most important honest post for the window -- a LONG-FORM Premium summary -- or "" when the selected
 * tier has nothing new to report (the workflow then posts NOTHING for that tier). Priority: (1) results sealed
 * on-chain, (2) newly flagged UNCONFIRMED blind candidates, (3) a research milestone (research.json landed this
 * window), (4) a BUILD NOTE over notable commits since the last build note, (5) the silence heartbeat fallback.
 *
 * With the default `only: ""` the FIRST tier that has something wins, so exactly one post comes back. The workflow
 * instead calls once per tier and posts every non-empty result: a window that both sealed results and landed five
 * commits yields two posts, not one. There is deliberately NO cap on how many posts a window may produce -- the old
 * one-line-per-window rule rationed the feed and dropped reportable work; the only remaining limits are a runaway
 * guard in the workflow and per-item de-duplication, both of which protect the feed rather than ration it.
 *
 * Tone (the maintainer's standing rules): honesty is carried by PLAIN WORDING and numbers-with-basis, NOT by a
 * per-post "discoveryClaim=false" stamp (removed). The standing characterization block + its research/figure/blind-
 * test links are attached ONLY to the research milestone (where they ARE the content); routine result/candidate
 * posts stay lean (headline + one honest line + the proof that corresponds: an on-chain tx when sealed, always the
 * live rig) so consecutive posts read differently.
 */
export function composeDigest(input: DigestInput): string {
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";

  // Tier selector (see DigestInput.only). "" reproduces the historical first-match-wins behavior exactly, so every
  // existing caller and test is unchanged; a named tier makes the OTHERS compose nothing, which is how one window
  // now yields several posts instead of one.
  const only = String(input.only ?? "").trim().toLowerCase();
  const want = (tier: "ledger" | "blind" | "milestone" | "build-note" | "heartbeat"): boolean => {
    if (only === "") return true;
    if (only === "science") return tier === "ledger" || tier === "blind" || tier === "milestone";
    return only === tier;
  };

  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const byId = new Map<string, DigestFinding>();
  for (const f of findings) if (f && typeof f.id === "string") byId.set(f.id, f);

  // (1) Results sealed on-chain in this window. Name it ONLY when the row resolves to a KNOWN-planet
  //     re-validation; otherwise state the honest, origin-neutral count. LEAN by design: no standing
  //     characterization here, and a known-planet re-validation never borrows the real-photometry survey's
  //     provenance (its photons may be seeded stand-ins) -- the Proof block carries just the sealing tx + live rig.
  const anchored = want("ledger") ? ledger.filter((e) => e && e.signature && within(e.anchoredAt, start, end)) : [];
  if (anchored.length) {
    const n = anchored.length;
    const plural = n === 1 ? "" : "s";
    const resolved = anchored
      .map((e) => byId.get(String(e.findingId || "")))
      .filter((f): f is DigestFinding => Boolean(f));
    const known = resolved.find(
      (f) => f.origin !== "blind-toi" && f.crossmatch?.matchedKnownPlanet && typeof f.crossmatch?.knownPlanetName === "string",
    );
    if (known && known.crossmatch?.knownPlanetName) {
      const period = periodPhrase(known);
      const periodClause = period ? ` (${period})` : "";
      const name = known.crossmatch.knownPlanetName;
      const sealed = n > 1 ? `and sealed ${n} reproducible results on-chain in total` : "and sealed the analysis on-chain";
      const match = anchored.find((e) => String(e.findingId || "") === String(known.id || ""));
      const txUrl = safeTxUrl(match?.explorerUrl) ?? newestTxUrl(anchored);
      const head = pick(
        [
          `Space Data Rig re-verified the known exoplanet ${name}${periodClause} ${sealed}.`,
          `A new pass by Space Data Rig reproduced the known exoplanet ${name}${periodClause}; the analysis is sealed on-chain.`,
          `Space Data Rig recovered the known exoplanet ${name}${periodClause} once more ${sealed}.`,
        ],
        `known:${input.windowStart}:${name}`,
      );
      const note = pick(
        [
          "Re-covering a planet already in the catalogue is a recovery check -- it shows the pipeline reproduces a known signal, not a new find.",
          "This is a recovery check against a planet astronomers already know, not a claimed discovery.",
          "A recovery check, not a new find: the pipeline hits a known signal again on its own.",
        ],
        `knownnote:${input.windowStart}:${name}`,
      );
      return clip(blocks(head, note, proofBlock(EMPTY_CHAR, txUrl)));
    }
    const txUrl = newestTxUrl(anchored);
    const head = pick(
      [
        `Space Data Rig anchored ${n} reproducible analysis result${plural} on-chain from its autonomous exoplanet survey.`,
        `${n} reproducible analysis result${plural} from Space Data Rig's autonomous survey are now sealed on-chain.`,
        `From its autonomous exoplanet survey Space Data Rig sealed ${n} reproducible result${plural} on-chain.`,
      ],
      `anchored:${input.windowStart}:${n}`,
    );
    const note = pick(
      [
        "Each anchoring timestamps a result and its exact inputs, so anyone can re-run the analysis and get the identical answer.",
        "The inputs are fixed and public, so the whole analysis can be checked and reproduced by anyone.",
      ],
      `anchorednote:${input.windowStart}:${n}`,
    );
    return clip(blocks(head, note, proofBlock(EMPTY_CHAR, txUrl)));
  }

  // (2) Newly flagged UNCONFIRMED blind candidates. These are contractually recovered blind on real photometry,
  //     so "real TESS photometry" is accurate HERE (and only here) -- src/cf/workflow.ts refuses to build a
  //     blind-TOI finding on a synthetic stand-in at all. Only SURVIVING candidates count: a critic-rejected
  //     blind row is noise, not a lead awaiting follow-up, so it must not inflate the count. LEAN: no
  //     characterization, no tx (this path anchors nothing), live rig only.
  const blind = (want("blind") ? findings : [])
    .filter((f) => f && isHeldBlindCandidate(f) && within(f.createdAt, start, end))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (blind.length) {
    const n = blind.length;
    // The exemplar is chosen by strength of evidence, not by recency. "e.g." reads as "one of these", and the
    // reader may well go and look at the named one, so naming the best-supported candidate is the responsible
    // choice; naming blind[0] just named whichever row happened to be newest.
    const eg = blind.slice().sort((a, b) => exemplarRank(b) - exemplarRank(a))[0];
    const pph = periodPhrase(eg);
    const rec = recoveryPhrase(eg);
    // targetId already carries its own prefix ("TIC 261136679" / "KIC 10666592"), so use it verbatim -- prepending
    // "TIC" would print "TIC TIC 261136679".
    const example = eg.targetId
      ? ` (e.g. ${eg.targetId}${pph ? `, ${pph}` : ""}${rec ? `; ${rec}` : ""})`
      : "";
    const plural = n === 1 ? "" : "s";
    const head = pick(
      [
        `Space Data Rig flagged ${n} new UNCONFIRMED transit candidate${plural} in its blind survey of real TESS photometry${example}.`,
        `Its blind sweep of real TESS photometry turned up ${n} new UNCONFIRMED transit candidate${plural}${example}.`,
        `Space Data Rig surfaced ${n} new periodic-dip candidate${plural} in real TESS photometry -- all still UNCONFIRMED${example}.`,
      ],
      `blind:${input.windowStart}:${n}:${eg.targetId || ""}`,
    );
    const note = pick(
      [
        "A candidate is a periodic dip the detector flagged without being told where to look; each stays UNCONFIRMED and is posted for human follow-up.",
        "These are leads for people to check, found on the detector's own -- each stays UNCONFIRMED, for human follow-up rather than a confirmed planet.",
      ],
      `blindnote:${input.windowStart}:${n}`,
    );
    return clip(blocks(head, note, proofBlock(EMPTY_CHAR, null)));
  }

  // (3) A research milestone, only when web/research.json actually landed in this window. This is the ONE tier
  //     that carries the standing characterization (completeness span, purity LOWER bound, independent blind test)
  //     and its corresponding proof links -- there the numbers ARE the update. Framed as the operating point it is.
  const survey = want("milestone") && input.researchUpdated ? input.research?.survey : undefined;
  if (survey && survey.stars != null && Number.isFinite(survey.stars)) {
    const char = characterization(input.research, "Our autonomous TESS transit pipeline is characterized on");
    const head = pick(
      [
        "Space Data Rig research update.",
        "A research milestone for the pipeline:",
        "Space Data Rig has a research milestone to report.",
      ],
      `milestone:${input.windowStart}:${survey.stars}`,
    );
    const note = "These figures describe how the pipeline behaves and are independent cross-checks, not discoveries.";
    return clip(blocks(head, note, char.block, proofBlock(char, null)));
  }

  // (4) BUILD NOTE (development-progress tier): the workflow passed notable commit subjects. Plain-English bullets
  //     of the work keeping the rig running -- honest, no discovery framing, no spend/wallet (sanitizeSubject
  //     enforces), linked to the repository + live rig. Composed on request (`--only build-note`) ALONGSIDE the
  //     science tiers rather than only when they are empty: suppressing it behind the science tier is what starved
  //     it in the first place. The workflow collects those subjects against a DEV-TIER cursor (the newest build note
  //     on the feed, see BUILD_NOTE_HEADLINES), NOT the science cursor.
  const reported = new Set(
    (Array.isArray(input.alreadyReported) ? input.alreadyReported : [])
      .map((s) => String(s ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  const devLines = (want("build-note") && Array.isArray(input.devCommits) ? input.devCommits : [])
    .map(sanitizeSubject)
    .filter((x) => x.length > 0)
    // Drop what the feed already announced. Exact string match is sound here: a bullet IS sanitizeSubject(subject)
    // verbatim, and x-last-post.reportedSubjects() lifts that same string back off the posted note.
    .filter((x) => !reported.has(x))
    .slice(0, DEV_BULLETS_MAX);
  if (devLines.length) {
    const head = pick([...BUILD_NOTE_HEADLINES], `dev:${input.windowStart}:${devLines[0]}`);
    const bullets = devLines.map((x) => `- ${x}`).join("\n");
    const note = "The science feed still posts only real results; this is a note on the work keeping it running.";
    const proof = `- Repository (code + history): ${URL_REPO}\n- Live rig + full methods: ${URL_LIVE}`;
    return clip(blocks(head, `${bullets}\n\n${note}`, `Proof:\n${proof}`));
  }

  // (5) Silence heartbeat (documented FALLBACK, only when nothing above was reportable). Fires only when the
  //     workflow supplies BOTH a silence gap and a threshold, so the default science-only path is unchanged.
  const hb = Number(input.heartbeatAfterMinutes);
  const silent = Number(input.silentMinutes);
  if (want("heartbeat") && Number.isFinite(hb) && hb > 0 && Number.isFinite(silent) && silent >= hb) {
    return heartbeat(input);
  }
  return ""; // nothing new and honest to report this window -> the workflow posts nothing
}

// ---- Output-level over-claim net (audit-6 #2) --------------------------------
// Because the per-post "discoveryClaim=false" stamp was REMOVED, over-claim protection now rests entirely on the
// wording library. This scans the FINAL composed string and returns any AFFIRMATIVE over-claim, independent of
// whether the templates were "supposed" to be correct. It is deliberately HEDGE-AWARE: the composer legitimately
// uses negated forms ("not a claimed discovery", "UNCONFIRMED", "rather than a confirmed planet", "not
// discoveries") which are honest, so a forbidden stem only counts as a violation when its SENTENCE carries no
// negation / hedge marker. A bare "first", "novel", "landmark", "discover", or standalone "confirm(ed)" in an
// un-hedged sentence is exactly what an accidental template edit would produce -- the test pins that it trips.
const OVERCLAIM_STEM = /\b(discover\w*|confirm\w*|first|novel|unprecedented|landmark|historic)\b/gi;
const OVERCLAIM_HEDGE = /\bnot\b|\bno\b|\bnone\b|\bstill\b|unconfirmed|rather than|never|without|non-|lower.?bound|under.?powered|recovery.?check|\bcheck\b|cross.?check|follow.?up|already know|astronomers|independent\b/i;

/** Sentences that affirmatively over-claim (a forbidden stem with no hedge in the same sentence). */
export function overclaimViolations(text: string): string[] {
  const hits: string[] = [];
  for (const rawLine of String(text ?? "").split(/\n+/)) {
    for (const sent of rawLine.split(/(?<=[.!?])\s+/)) {
      if (!/\S/.test(sent)) continue;
      if (OVERCLAIM_HEDGE.test(sent)) continue; // a hedged/negated sentence is honest, not a claim
      OVERCLAIM_STEM.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OVERCLAIM_STEM.exec(sent))) hits.push(`${m[0]} :: ${sent.trim()}`);
    }
  }
  return hits;
}

// ---- Feed red lines shared by the send guard and the archive guard (devlog/README.md) --------------
// The public feed has no dated context and never talks money, so a relative time word ("today", "this week",
// ...) reads as a claim about a window nobody can see, and any wallet / key / spend wording is out of scope.
// These two regexes are the SINGLE SOURCE OF TRUTH for that rule: scripts/post-x-text.ts refuses to SEND text
// that trips them, and tests/devlog-archive.test.ts refuses to ARCHIVE text that trips them. Defining them here
// rather than in both places is what makes the two guards the same predicate by construction -- the asymmetry
// that once let a time-worded post go out that the archive would then have rejected can no longer arise.
export const FEED_TIME_WORDS = /\b(this week|last week|next week|recently|overnight|today|tonight|yesterday)\b/i;
export const FEED_SPEND_WORDS = /wallet|private key|secret key|seed phrase|\bcost\b|\busd\b|\bsol\b|\$\d/i;

/** Human-readable feed red-line violations: relative time windows and wallet / key / spend wording. */
export function feedRedlineViolations(text: string): string[] {
  const s = String(text ?? "");
  const hits: string[] = [];
  const tw = s.match(new RegExp(FEED_TIME_WORDS.source, "gi"));
  if (tw && tw.length) hits.push(`time-implying word(s): ${[...new Set(tw.map((w) => w.toLowerCase()))].join(", ")}`);
  const sw = s.match(new RegExp(FEED_SPEND_WORDS.source, "gi"));
  if (sw && sw.length) hits.push(`wallet/spend wording: ${[...new Set(sw.map((w) => w.toLowerCase()))].join(", ")}`);
  return hits;
}

// ---- I/O (kept out of the pure composer above) --------------------------------

function arg(name: string, dflt = ""): string {
  const argv = process.argv;
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function fetchJson(url: string, timeoutMs = 20000): Promise<unknown> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const sinceArg = arg("since", "");
  const untilArg = arg("until", "");
  const stateUrl = arg("state-url", `https://${SITE}/api/state`);
  const ledgerUrl = arg("ledger-url", `https://${SITE}/api/ledger`);
  const researchPath = arg("research", "web/research.json");
  const outPath = arg("out", "");
  const ru = arg("research-updated", "");
  const researchUpdated = ru === "1" || ru.toLowerCase() === "true";
  const silentRaw = arg("silent-min", "");
  const silentMinutes = silentRaw === "" ? Number.NaN : Number(silentRaw);
  const hbRaw = arg("heartbeat-after-min", "");
  const heartbeatAfterMinutes = hbRaw === "" ? 0 : Number(hbRaw);
  // Build-note tier input: a file of commit subjects (one per line) gathered by the workflow from the window since
  // the last post. Absent/empty -> composeDigest skips the dev tier exactly as before (science/heartbeat unchanged).
  const devFile = arg("dev-commits-file", "");
  let devCommits: string[] | undefined;
  if (devFile) {
    try {
      devCommits = readFileSync(devFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      devCommits = undefined;
    }
    // Say out loud which subjects will NOT reach the feed and why. composeDigest drops them (see classifySubject);
    // without this line a dropped commit is invisible, which is the exact failure mode this whole path was rebuilt
    // to stop. On stderr, like every other diagnostic here, so it never contaminates --out.
    for (const r of rejectedDevSubjects(devCommits ?? [])) {
      console.error(`science-digest: dropping commit subject (${r.reason}): ${r.subject}`);
    }
  }
  // Subjects the feed has already announced (written by x-last-post --reported-out). Lets the workflow OVERLAP the
  // dev window past its cursor -- so a commit landing mid-run is picked up rather than skipped forever -- without
  // re-posting a bullet that is already on the timeline. Absent/unreadable -> no de-duplication, exactly as before.
  const reportedFile = arg("already-reported-file", "");
  let alreadyReported: string[] | undefined;
  if (reportedFile) {
    try {
      alreadyReported = readFileSync(reportedFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      alreadyReported = undefined;
    }
  }
  // One tier per invocation so a window can yield several posts; "" keeps the historical first-match-wins behavior.
  const only = arg("only", "");

  const FALLBACK_MS = 40 * 60 * 1000; // ~40m (cadence is 30m), so a slightly-late tick cannot leave a gap
  const endParsed = untilArg ? new Date(untilArg) : new Date();
  const windowEnd = Number.isNaN(endParsed.getTime()) ? new Date() : endParsed;
  let startParsed = sinceArg ? new Date(sinceArg) : new Date(windowEnd.getTime() - FALLBACK_MS);
  if (Number.isNaN(startParsed.getTime())) startParsed = new Date(windowEnd.getTime() - FALLBACK_MS);

  // --skip-fetch 1 composes from LOCAL inputs only (git subjects + web/research.json). The build-note tier needs no
  // survey state, so this keeps it working when the live rig is unreachable and saves a network round trip per batch
  // when a backlog is split across several notes.
  const skipRaw = arg("skip-fetch", "").toLowerCase();
  const skipFetch = skipRaw === "1" || skipRaw === "true";

  let findings: DigestFinding[] = [];
  let ledger: DigestLedgerEntry[] = [];
  if (skipFetch) {
    console.error("science-digest: --skip-fetch set; composing from local inputs only (no state/ledger read).");
  } else {
    try {
      const s = (await fetchJson(stateUrl)) as { findings?: DigestFinding[] } | null;
      if (s && Array.isArray(s.findings)) findings = s.findings;
    } catch (e) {
      console.error(`science-digest: state fetch failed (${msg(e)}); treating as no findings.`);
    }
    try {
      const l = (await fetchJson(ledgerUrl)) as { ledger?: DigestLedgerEntry[] } | null;
      if (l && Array.isArray(l.ledger)) ledger = l.ledger;
    } catch (e) {
      console.error(`science-digest: ledger fetch failed (${msg(e)}); treating as no ledger.`);
    }
  }

  let research: DigestResearch | null = null;
  try {
    research = JSON.parse(readFileSync(researchPath, "utf8")) as DigestResearch;
  } catch {
    research = null;
  }

  const text = composeDigest({
    windowStart: startParsed.toISOString(),
    windowEnd: windowEnd.toISOString(),
    ledger,
    findings,
    research,
    researchUpdated,
    silentMinutes,
    heartbeatAfterMinutes,
    devCommits,
    alreadyReported,
    only,
  });

  console.error(
    `science-digest: window ${startParsed.toISOString()} .. ${windowEnd.toISOString()}; ` +
      `findings=${findings.length} ledger=${ledger.length} researchUpdated=${researchUpdated} only=${only || "(all tiers)"}`,
  );
  if (outPath) {
    const d = dirname(outPath);
    if (d && d !== ".") mkdirSync(d, { recursive: true });
  }
  if (text) {
    console.error(`science-digest: composed (${text.length}/${MAX_LEN}): ${text}`);
    if (outPath) writeFileSync(outPath, text, "utf8");
    else console.log(text);
  } else {
    console.error("science-digest: nothing new and honest to report this window; composing no tweet.");
    if (outPath) writeFileSync(outPath, "", "utf8");
  }
}

// Side-effect guard: run main() ONLY when this file is executed directly (npm run science:digest). Importing
// the module for its pure composeDigest (tests/science-digest.test.ts) must never trigger network/file I/O --
// the same contract scripts/p8-live-probe.ts upholds so the offline `npm test` gate never leaves the machine.
const invokedDirectly = /science-digest(\.ts)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`science-digest: fatal: ${msg(e)}`);
    process.exitCode = 1;
  });
}
