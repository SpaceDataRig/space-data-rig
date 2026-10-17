// SCIENCE DIGEST: compose ONE honest, English-only line about the most important science the rig produced
// in a time window, for the half-hourly X (Twitter) digest. This REPLACES the old "N new commits" digest: the
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
export interface DigestResearch {
  survey?: { stars?: number; purity?: number };
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

/** Hard-trim to the tweet limit the same way post-x-text.ts does, so composeDigest can never overflow. */
function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 280 ? `${t.slice(0, 277).trimEnd()}...` : t;
}

function periodDays(f: DigestFinding | undefined): number | null {
  const p = f?.candidate?.periodDays;
  return p != null && Number.isFinite(p) ? p : null;
}

/**
 * Return the single most important honest science line for the window, or "" when there is nothing new to
 * report (the workflow then posts NOTHING). Priority: (1) results sealed on-chain, (2) newly flagged
 * UNCONFIRMED blind candidates, (3) a research milestone when research.json landed in the window.
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
  //     re-validation; otherwise state the honest, origin-neutral fact (N results anchored).
  const anchored = ledger.filter((e) => e && e.signature && within(e.anchoredAt, start, end));
  if (anchored.length) {
    const resolved = anchored
      .map((e) => byId.get(String(e.findingId || "")))
      .filter((f): f is DigestFinding => Boolean(f));
    const known = resolved.find(
      (f) => f.origin !== "blind-toi" && f.crossmatch?.matchedKnownPlanet && typeof f.crossmatch?.knownPlanetName === "string",
    );
    if (known && known.crossmatch?.knownPlanetName) {
      const pd = periodDays(known);
      return clip(
        `Space Data Rig re-verified the known exoplanet ${known.crossmatch.knownPlanetName}${pd != null ? ` (P=${pd.toFixed(2)}d)` : ""} and sealed the analysis on-chain. ${SITE}`,
      );
    }
    const n = anchored.length;
    return clip(
      `Space Data Rig anchored ${n} reproducible analysis result${n === 1 ? "" : "s"} on-chain from its autonomous exoplanet survey. ${SITE}`,
    );
  }

  // (2) Newly flagged UNCONFIRMED blind candidates (newest first, for the example). These are contractually
  //     recovered blind on real photometry, so "real TESS photometry" is accurate here.
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
    return clip(
      `Space Data Rig flagged ${n} new UNCONFIRMED transit candidate${n === 1 ? "" : "s"} in its blind survey of real TESS photometry, for human follow-up rather than any claimed discovery${example}. ${SITE}`,
    );
  }

  // (3) A research milestone, only when web/research.json actually landed in this window. Cite the stable
  //     survey characterization and label purity as the LOWER bound it is (research.json says so itself).
  const survey = input.researchUpdated ? input.research?.survey : undefined;
  if (survey && survey.stars != null && Number.isFinite(survey.stars)) {
    const purityTxt =
      survey.purity != null && Number.isFinite(survey.purity)
        ? `, with a purity lower bound of ${Math.round(survey.purity * 100)}% (a real-but-uncatalogued planet counts against it)`
        : "";
    return clip(
      `Space Data Rig research update: its blind transit detector is characterized on ${survey.stars} real TESS-SPOC stars${purityTxt}. ${SITE}`,
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
    console.error(`science-digest: composed (${text.length}/280): ${text}`);
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
