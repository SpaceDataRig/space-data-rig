// SCIENCE DIGEST: compose ONE honest, English-only long-form post about the most important science the rig
// produced in a time window, for the half-hourly X (Twitter) digest. The author is a Premium ("blue") account,
// so a post may run well past the classic 280 chars (X allows up to 25,000 weighted chars): each digest is a
// compact multi-sentence summary -- the result, the key characterized numbers, the honesty caveat, and the
// link -- rather than one clipped sentence. This REPLACES the old "N new commits" digest: the
// channel now reports SCIENCE, not commit counts, and posts NOTHING when there is no new result to report
// (see .github/workflows/x-post.yml).
//
// Red lines (enforced here AND in scripts/post-x-text.ts, which refuses any non-ASCII byte):
//  - English-only ASCII; no time-implying words (this week / recently / overnight / today ...).
//  - NEVER claims a new planet. A blind candidate is always "UNCONFIRMED ... for human follow-up".
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

const SITE = "spacedatarig.app";

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
  candidate?: { periodDays?: number };
  crossmatch?: { matchedKnownPlanet?: boolean; knownPlanetName?: string };
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
}

function within(iso: string | undefined, start: number, end: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= start && t <= end;
}

/** X's long-post ceiling for a Premium author, in weighted chars (CJK/emoji count 2, any URL counts 23). Our
 *  text is pure ASCII with a single short bare-domain URL, so the naive .length sits far below the weighted
 *  count and far below this cap; a composed digest is ~800 chars. This is a hard safety net (never a target),
 *  mirroring the clamp in post-x-text.ts so composeDigest can never overflow. */
const MAX_LEN = 25000;
function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 3).trimEnd()}...` : t;
}

function periodDays(f: DigestFinding | undefined): number | null {
  const p = f?.candidate?.periodDays;
  return p != null && Number.isFinite(p) ? p : null;
}

/**
 * Build the standing-characterization paragraph from web/research.json, or "" when there is no survey to cite.
 * Every number is read from the data (never hardcoded); purity is labelled the LOWER bound it is, and the blind
 * test is labelled an independent cross-check. `lead` lets a caller phrase it as "separately characterized"
 * (context inside an event post) or "is characterized" (the research-milestone post itself), which keeps a
 * known-planet re-validation honestly separate from the detector's real-photometry survey.
 */
function characterization(research: DigestResearch | null | undefined, lead: string): string {
  const survey = research?.survey;
  if (!survey || survey.stars == null || !Number.isFinite(survey.stars)) return "";

  const rawComp: DigestCompletenessPoint[] = Array.isArray(survey.completeness) ? survey.completeness : [];
  const comp = rawComp
    .filter((c) => Boolean(c) && Number.isFinite(c.depthPpm) && Number.isFinite(c.rate))
    .map((c) => ({ depthPpm: c.depthPpm as number, rate: c.rate as number }))
    .sort((a, b) => a.depthPpm - b.depthPpm);
  let completenessTxt = "";
  if (comp.length >= 2) {
    const lo = comp[0];
    const hi = comp[comp.length - 1];
    completenessTxt = ` Injection-recovery completeness rises from ${Math.round(lo.rate * 100)}% at ${lo.depthPpm} ppm to ${Math.round(hi.rate * 100)}% at ${hi.depthPpm} ppm.`;
  } else if (comp.length === 1) {
    completenessTxt = ` Injection-recovery completeness is ${Math.round(comp[0].rate * 100)}% at ${comp[0].depthPpm} ppm.`;
  }

  const purityTxt =
    survey.purity != null && Number.isFinite(survey.purity)
      ? ` The purity LOWER bound is ${Math.round(survey.purity * 100)}% -- a genuine but uncatalogued planet is counted against it, so the true value can only be higher.`
      : "";

  const bt = research?.blindTest;
  const blindTxt =
    bt && Number.isFinite(bt.recall) && Number.isFinite(bt.precision)
      ? ` An independent sealed-key blind test measured ${Math.round((bt.recall as number) * 100)}% recall at ${Math.round((bt.precision as number) * 100)}% precision.`
      : "";

  return `${lead} ${survey.stars} real public TESS-SPOC stars.${completenessTxt}${purityTxt}${blindTxt}`;
}

/**
 * Return the single most important honest science post for the window -- a LONG-FORM Premium summary (result +
 * key characterized numbers + honesty caveat + link), or "" when there is nothing new to report (the workflow
 * then posts NOTHING). Priority: (1) results sealed on-chain, (2) newly flagged UNCONFIRMED blind candidates,
 * (3) a research milestone when research.json landed in the window.
 */
export function composeDigest(input: DigestInput): string {
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";

  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const byId = new Map<string, DigestFinding>();
  for (const f of findings) if (f && typeof f.id === "string") byId.set(f.id, f);

  // (1) Results sealed on-chain in this window. Name it ONLY when the row resolves to a KNOWN-planet
  //     re-validation; otherwise state the honest, origin-neutral fact (N results anchored). Either way this is
  //     a LONG-FORM summary: the event, then the detector's standing characterization as SEPARATE context, then
  //     the discoveryClaim=false caveat and the link. A known-planet re-validation may run on seeded stand-ins,
  //     so it never borrows the real-photometry survey's provenance -- that survey is cited only as the
  //     detector's separate characterization.
  const anchored = ledger.filter((e) => e && e.signature && within(e.anchoredAt, start, end));
  if (anchored.length) {
    const n = anchored.length;
    const resolved = anchored
      .map((e) => byId.get(String(e.findingId || "")))
      .filter((f): f is DigestFinding => Boolean(f));
    const known = resolved.find(
      (f) => f.origin !== "blind-toi" && f.crossmatch?.matchedKnownPlanet && typeof f.crossmatch?.knownPlanetName === "string",
    );
    const ctx = characterization(input.research, "The detector is separately characterized on");
    if (known && known.crossmatch?.knownPlanetName) {
      const pd = periodDays(known);
      const period = pd != null ? ` (P=${pd.toFixed(2)}d)` : "";
      const sealed = n > 1 ? ` and sealed ${n} reproducible results on-chain in total` : " and sealed the analysis on-chain";
      return clip(
        `Space Data Rig re-verified the known exoplanet ${known.crossmatch.knownPlanetName}${period}${sealed}. ` +
          `Re-covering a catalogued planet is a recovery check -- it shows the pipeline reproduces a signal astronomers already know -- not a discovery. ` +
          `${ctx ? `${ctx} ` : ""}Every result carries discoveryClaim=false. ` +
          `Full numbers, methods and on-chain proofs: ${SITE}`,
      );
    }
    return clip(
      `Space Data Rig anchored ${n} reproducible analysis result${n === 1 ? "" : "s"} on-chain from its autonomous exoplanet survey. ` +
        `Anchoring timestamps each result and its exact inputs, so anyone can re-run the analysis and get the identical answer -- reproducibility, not a claimed discovery (discoveryClaim=false). ` +
        `${ctx ? `${ctx} ` : ""}Full numbers, methods and on-chain proofs: ${SITE}`,
    );
  }

  // (2) Newly flagged UNCONFIRMED blind candidates (newest first, for the example). These are contractually
  //     recovered blind on real photometry, so "real TESS photometry" is accurate HERE (and only here).
  const blind = findings
    .filter((f) => f && f.origin === "blind-toi" && within(f.createdAt, start, end))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (blind.length) {
    const n = blind.length;
    const eg = blind[0];
    const pd = periodDays(eg);
    // targetId is already a catalogue label that carries its own prefix (src/core/types.ts: e.g. "TIC 261136679"
    // or "KIC 10666592"), so use it verbatim -- prepending "TIC" here would print "TIC TIC 261136679".
    const example = eg.targetId ? ` (e.g. ${eg.targetId}${pd != null ? `, P=${pd.toFixed(2)}d` : ""})` : "";
    const ctx = characterization(input.research, "The detector is separately characterized on");
    return clip(
      `Space Data Rig flagged ${n} new UNCONFIRMED transit candidate${n === 1 ? "" : "s"} in its blind survey of real TESS photometry${example}. ` +
        `A blind candidate is a periodic dip the detector found without being told where to look; each stays UNCONFIRMED and is posted for human follow-up rather than any claimed discovery (discoveryClaim=false). ` +
        `${ctx ? `${ctx} ` : ""}Full numbers, methods and on-chain proofs: ${SITE}`,
    );
  }

  // (3) A research milestone, only when web/research.json actually landed in this window. Cite the stable
  //     survey characterization (completeness span, purity LOWER bound, independent blind test) and frame it as
  //     the operating point it is -- never a discovery.
  const survey = input.researchUpdated ? input.research?.survey : undefined;
  if (survey && survey.stars != null && Number.isFinite(survey.stars)) {
    const metrics = characterization(input.research, "our autonomous TESS transit pipeline is characterized on");
    return clip(
      `Space Data Rig research update: ${metrics} ` +
        `These are measurements of the pipeline operating point and independent cross-checks, not discoveries: every result carries discoveryClaim=false, and any blind candidate stays UNCONFIRMED, for human follow-up rather than a claimed planet. ` +
        `Full numbers, methods and on-chain proofs: ${SITE}`,
    );
  }

  return ""; // nothing new and honest to report this window -> the workflow posts nothing
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

  const FALLBACK_MS = 40 * 60 * 1000; // ~40m (cadence is 30m), so a slightly-late tick cannot leave a gap
  const endParsed = untilArg ? new Date(untilArg) : new Date();
  const windowEnd = Number.isNaN(endParsed.getTime()) ? new Date() : endParsed;
  let startParsed = sinceArg ? new Date(sinceArg) : new Date(windowEnd.getTime() - FALLBACK_MS);
  if (Number.isNaN(startParsed.getTime())) startParsed = new Date(windowEnd.getTime() - FALLBACK_MS);

  let findings: DigestFinding[] = [];
  let ledger: DigestLedgerEntry[] = [];
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
  });

  console.error(
    `science-digest: window ${startParsed.toISOString()} .. ${windowEnd.toISOString()}; ` +
      `findings=${findings.length} ledger=${ledger.length} researchUpdated=${researchUpdated}`,
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
