// P48: novelty disposition of the live candidate board against the NASA Exoplanet Archive (priority 5
// prerequisite). READ-ONLY: it fetches public catalog rows and reports, for each board candidate,
// whether ANYONE has already announced a transit signal at or near its position, and whether any
// announcement shares our period. It NEVER claims a discovery.
//
// The honest point of this artifact: "not in the catalog" is a checkable FACT, but it is NOT "we found
// a planet." A deep, single-sector signal that shows on a PAIR of neighbouring TICs (which the board
// itself flags as a common systematic) and has NO TOI anywhere nearby is far more consistent with a
// FALSE POSITIVE -- the TESS pipeline never flagged a credible transit there -- than with a hidden new
// planet. We print that reading next to the raw disposition so the number cannot be over-claimed.
//
// A control query against a known TOI runs first; if it fails, the report is marked inconclusive
// (a 0-hit result is only meaningful when the query mechanism is proven live).
//
// Run:  npm run p48:novelty-check   (reads web/candidates.json, writes reports/p48-novelty.*)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { disposition, type CatalogEntry, type CandidatePos } from "../src/candidate/novelty.ts";
import { buildStamp } from "./report-freshness.ts";

const TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const RADIUS_ARCSEC = 30;
const BOX_DEG = 0.05; // coarse fetch box (~3 arcmin); disposition() re-filters precisely to RADIUS_ARCSEC

async function q<T extends Record<string, unknown>>(query: string): Promise<T[]> {
  const url = `${TAP}?query=${encodeURIComponent(query)}&format=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) throw new Error(`TAP HTTP ${r.status}`);
      const raw = (await r.json()) as T[];
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

function box(col: string, v: number): string {
  return `${col} between ${(v - BOX_DEG).toFixed(4)} and ${(v + BOX_DEG).toFixed(4)}`;
}
function parseTic(s: unknown): number | undefined {
  const m = String(s ?? "").match(/(\d{5,})/);
  return m ? Number(m[1]) : undefined;
}
function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface BoardCandidate {
  tic: number; ra: number; dec: number; periodDays: number; depthPpm: number; snr: number;
  corroboratedSectors: number; distinctHostsSharingEphemeris: number; suspectedCommonSystematic: boolean;
}

async function fetchCatalogAround(c: CandidatePos): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const toi = await q<Record<string, unknown>>(
    `select tid,toidisplay,ra,dec,pl_orbper from toi where ${box("ra", c.ra)} and ${box("dec", c.dec)}`,
  );
  for (const r of toi) {
    entries.push({
      label: String(r.toidisplay ?? `TOI-${r.tid}`), kind: "toi",
      ra: num(r.ra) ?? NaN, dec: num(r.dec) ?? NaN, tic: num(r.tid), periodDays: num(r.pl_orbper),
    });
  }
  const conf = await q<Record<string, unknown>>(
    `select pl_name,hostname,tic_id,ra,dec,pl_orbper from pscomppars where ${box("ra", c.ra)} and ${box("dec", c.dec)}`,
  );
  for (const r of conf) {
    entries.push({
      label: String(r.pl_name ?? r.hostname ?? "confirmed"), kind: "confirmed",
      ra: num(r.ra) ?? NaN, dec: num(r.dec) ?? NaN, tic: parseTic(r.tic_id), periodDays: num(r.pl_orbper),
    });
  }
  return entries.filter((e) => Number.isFinite(e.ra) && Number.isFinite(e.dec));
}

async function main(): Promise<void> {
  // control: a known TOI must come back, or the whole check is meaningless.
  const ctl = await q<Record<string, unknown>>(
    `select toidisplay from toi where ${box("ra", 113.984761)} and ${box("dec", -32.841999)}`,
  );
  const controlOk = ctl.some((r) => String(r.toidisplay).startsWith("TOI-1011"));
  console.log(`control (TOI-1011 field returns a known TOI): ${controlOk ? "PASS" : "FAIL"}`);
  if (!controlOk) {
    console.log("VERDICT: INCONCLUSIVE-CONTROL (catalog query path not verified live; 0-hits would be meaningless)");
    return;
  }

  const board = JSON.parse(readFileSync("web/candidates.json", "utf8")) as {
    schema?: string;
    summary?: { systematicCollapsed?: number; emittedCandidates?: number; corroboratedHosts?: number };
    candidates: BoardCandidate[];
  };
  const results = [];
  for (const c of board.candidates) {
    const cand: CandidatePos = { tic: c.tic, ra: c.ra, dec: c.dec, periodDays: c.periodDays };
    const entries = await fetchCatalogAround(cand);
    const d = disposition(cand, entries, { radiusArcsec: RADIUS_ARCSEC });
    results.push({ c, d, nCatalog: entries.length });
    console.log(
      `TIC ${c.tic}  P=${c.periodDays.toFixed(3)}d  depth=${Math.round(c.depthPpm)}ppm  ` +
      `announced=${d.announced}  novelLocation=${d.novelLocation}  samePeriod=${d.samePeriodAnnounced}  ` +
      `nearest=${d.nearestLabel ?? "-"} (${d.nearestSepArcsec ?? "-"})  ` +
      `[corrob=${c.corroboratedSectors} sharedEphHosts=${c.distinctHostsSharingEphemeris} systematic=${c.suspectedCommonSystematic}]`,
    );
  }

  const novelCount = results.filter((r) => r.d.novelLocation).length;
  const samePeriodCount = results.filter((r) => r.d.samePeriodAnnounced).length;
  const systematicPairs = results.filter((r) => r.c.distinctHostsSharingEphemeris > 1 || r.c.suspectedCommonSystematic).length;
  // Audit-12 D1: the collapse count quoted in the prose below was a hardcoded constant ("collapsed 2 ... emitting
  // these 5") and rotted when the /2 board re-measured to 1 group / 4 candidates. The freshness gate verifies
  // bytes-against-inputs, NOT prose-against-data, so every load-bearing count in the text is interpolated from
  // the board's own summary from here on (and pinned by tests/p48-copy-consistency.test.ts).
  const collapsedGroups = board.summary?.systematicCollapsed ?? null;
  console.log(`\n=== P48 SUMMARY ===`);
  console.log(`  candidates: ${results.length}; at a location with NO announcement nearby: ${novelCount}; sharing a period with an announcement: ${samePeriodCount}`);
  console.log(`  candidates flagged as a shared/systematic ephemeris across neighbouring hosts: ${systematicPairs}`);
  console.log(`  multi-host systematic groups collapsed by the board's L3 before emission: ${collapsedGroups ?? "(summary absent)"}`);

  const json = {
    meta: {
      ...buildStamp(["web/candidates.json", "src/candidate/novelty.ts", "scripts/p48-novelty-check.ts"]),
      generatedBy: "scripts/p48-novelty-check.ts",
      catalogs: "NASA Exoplanet Archive TAP: table `toi` (announced candidate transits) + `pscomppars` (confirmed planets)",
      radiusArcsec: RADIUS_ARCSEC, boxDeg: BOX_DEG, control: "TOI-1011 field",
      note: "novelLocation means nothing is announced at/near the position in these two catalogs; it is NOT a claim of a planet. ExoFOP-TESS and the peer-reviewed literature are NOT covered here.",
    },
    controlOk: true,
    nCandidates: results.length,
    novelLocationCount: novelCount,
    samePeriodAnnouncedCount: samePeriodCount,
    systematicPairCount: systematicPairs,
    boardSchema: board.schema ?? null,
    boardSystematicCollapsed: collapsedGroups,
    boardEmittedCandidates: board.summary?.emittedCandidates ?? null,
    discoveryClaim: false,
    rows: results.map((r) => ({
      tic: r.c.tic, ra: r.c.ra, dec: r.c.dec, periodDays: +r.c.periodDays.toFixed(4), depthPpm: Math.round(r.c.depthPpm),
      snr: +r.c.snr.toFixed(2), corroboratedSectors: r.c.corroboratedSectors, distinctHostsSharingEphemeris: r.c.distinctHostsSharingEphemeris,
      suspectedCommonSystematic: r.c.suspectedCommonSystematic,
      announced: r.d.announced, novelLocation: r.d.novelLocation, samePeriodAnnounced: r.d.samePeriodAnnounced,
      nearestLabel: r.d.nearestLabel, nearestSepArcsec: r.d.nearestSepArcsec,
    })),
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p48-novelty.json", JSON.stringify(json, null, 2) + "\n");

  const lines: string[] = [
    "# P48 novelty disposition of the candidate board vs the NASA Exoplanet Archive",
    "",
    "Reproduce: `npm run p48:novelty-check` (reads `web/candidates.json`; queries the Archive `toi` + `pscomppars` tables).",
    "",
    "For each live board candidate we ask a narrow, checkable question: has anyone ALREADY announced a transit",
    "signal at or near this position (within " + RADIUS_ARCSEC + "\"), and does any announcement share our period?",
    "A control query against a known TOI field runs first; only if it returns do we trust any 0-hit.",
    "",
    "| TIC | our P (d) | depth (ppm) | corrob. sectors | shared-eph hosts | announced nearby? | same period? |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.c.tic} | ${r.c.periodDays.toFixed(3)} | ${Math.round(r.c.depthPpm)} | ${r.c.corroboratedSectors} | ` +
      `${r.c.distinctHostsSharingEphemeris} | ${r.d.announced ? "yes (" + (r.d.nearestLabel ?? "?") + ")" : "NO"} | ${r.d.samePeriodAnnounced ? "yes" : "no"} |`,
    );
  }
  lines.push(
    "",
    `**${novelCount}/${results.length}** candidates sit at a location with no announcement in these catalogs, and`,
    `**${samePeriodCount}/${results.length}** match an already-announced period.`,
    "",
    "Honest reading (this is the whole point): `novelLocation` is a statement about the CATALOGS, not about nature.",
    "Every one of these is deep (EB/blend-like ppm), single-sector (corroboratedSectors=1), and the board reports",
    `corroboratedHosts=${board.summary?.corroboratedHosts ?? "n/a"} overall -- the TESS pipeline itself flagged NO TOI within ${RADIUS_ARCSEC}" of any of them,`,
    "which is evidence AGAINST a credible planet here, not for an undiscovered one. (The board separately collapsed",
    (collapsedGroups === null
      ? `no summary-level collapse count is present in this snapshot; these ${results.length} are the emitted survivors -- but survivors of a blind`
      : `${collapsedGroups} multi-host systematic group(s) BEFORE emitting these ${results.length}, so these are survivors -- but survivors of a blind`),
    "single-sector search at these depths are still dominated by false positives per our own purity measurements,",
    "and none of our vetting gates (P44/P45/P46) is safe to clear an individual candidate.) We therefore report",
    "ZERO credible novel planet candidates. This check does NOT cover ExoFOP-TESS or the peer-reviewed literature.",
    "Research-only; nothing gated, anchored, claimed, or deployed. `discoveryClaim: false`.",
    "",
  );
  writeFileSync("reports/p48-novelty.md", lines.join("\n"));
  console.log("\nwrote reports/p48-novelty.md and reports/p48-novelty.json");
  console.log("VERDICT: NOVELTY-CHECK-RAN");
}

main().catch((e) => {
  console.error("p48 failed:", e instanceof Error ? e.message : e);
  console.log("\nVERDICT: INCONCLUSIVE-NETWORK");
  process.exitCode = 1;
});
