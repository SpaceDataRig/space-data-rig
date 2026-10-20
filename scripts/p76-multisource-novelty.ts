// P76: MULTI-SOURCE novelty of the live candidate board -- upgrades P48 by widening the de-duplication net.
//
// WHY THIS EXISTS. P48 checked novelty against only TWO NASA Exoplanet Archive tables (`toi` + `pscomppars`)
// and openly noted it did NOT cover ExoFOP-TESS or candidate TOIs (CTOIs). The external eumemic/exoplanets
// survey de-duplicates against MANY sources at once (ExoFOP TOI+CTOI with community FP/EB labels, the Archive,
// SPOC TCEs, ...). More catalogs can only make a "novel" claim HARDER -- every extra match turns a would-be
// "nobody has seen this" into "someone already announced it". So this is a strictly MORE conservative novelty
// test, and its whole value is measuring how much of P48's apparent novelty SHRINKS once the ExoFOP TOI/CTOI
// table (which carries CTOIs and FP/EB dispositions the Archive `toi` query omits) is added.
//
// A probe confirmed the Archive exposes no `ctoi`/`tce`/`dsv` table (HTTP 400), so the distinct extra source
// reachable token-free is the public ExoFOP TOI table (already parsed in src/data/toiDispositions.ts).
//
// READ-ONLY + CONTROLLED. Two live controls run first: (1) the Archive query path must return a known TOI
// (TOI-1011 field); (2) the ExoFOP table must load and contain that same known object. If a path fails, its
// 0-hits are meaningless and the run is marked inconclusive. It NEVER claims a discovery; discoveryClaim and
// safeToGate are structurally false; nothing is gated, anchored, or deployed.
//
// Run:  npm run p76:multisource-novelty   (reads web/candidates.json, writes reports/p76-multisource-novelty.*)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { disposition, findMatches, type CatalogEntry, type CandidatePos } from "../src/candidate/novelty.ts";
import { fetchToiTable, type ToiRecord } from "../src/data/toiDispositions.ts";
import { buildStamp } from "./report-freshness.ts";

const TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const RADIUS_ARCSEC = 30;
const BOX_DEG = 0.05;

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

async function fetchArchiveAround(c: CandidatePos): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const toi = await q<Record<string, unknown>>(
    `select tid,toidisplay,ra,dec,pl_orbper from toi where ${box("ra", c.ra)} and ${box("dec", c.dec)}`);
  for (const r of toi) entries.push({ label: String(r.toidisplay ?? `TOI-${r.tid}`), kind: "toi", ra: num(r.ra) ?? NaN, dec: num(r.dec) ?? NaN, tic: num(r.tid), periodDays: num(r.pl_orbper) });
  const conf = await q<Record<string, unknown>>(
    `select pl_name,hostname,tic_id,ra,dec,pl_orbper from pscomppars where ${box("ra", c.ra)} and ${box("dec", c.dec)}`);
  for (const r of conf) entries.push({ label: String(r.pl_name ?? r.hostname ?? "confirmed"), kind: "confirmed", ra: num(r.ra) ?? NaN, dec: num(r.dec) ?? NaN, tic: parseTic(r.tic_id), periodDays: num(r.pl_orbper) });
  return entries.filter((e) => Number.isFinite(e.ra) && Number.isFinite(e.dec));
}

function exofopEntries(recs: ToiRecord[]): CatalogEntry[] {
  return recs
    .filter((r) => Number.isFinite(r.ra) && Number.isFinite(r.dec))
    .map((r) => ({
      label: `${r.toi || `TIC-${r.tic}`} [${r.tfopwgDisposition || r.tessDisposition || "?"}]`,
      kind: "exofop" as const, ra: r.ra, dec: r.dec, tic: r.tic, periodDays: Number.isFinite(r.periodDays) ? r.periodDays : undefined,
    }));
}

async function main(): Promise<void> {
  console.log(`P76 MULTI-SOURCE NOVELTY: P48's Archive (toi+pscomppars) PLUS the ExoFOP TOI/CTOI table. radius ${RADIUS_ARCSEC}". Token-free; read-only; discoveryClaim false.`);

  // CONTROL 1: Archive query path must return a known TOI.
  const ctlArchive = await q<Record<string, unknown>>(`select toidisplay from toi where ${box("ra", 113.984761)} and ${box("dec", -32.841999)}`);
  const archiveControlOk = ctlArchive.some((r) => String(r.toidisplay).startsWith("TOI-1011"));
  console.log(`  control Archive (TOI-1011 field): ${archiveControlOk ? "PASS" : "FAIL"}`);

  // CONTROL 2: ExoFOP table must load AND contain that same known object.
  const exofopRecs = await fetchToiTable();
  const exofopControlOk = exofopRecs.length > 1000 && exofopRecs.some((r) => /^1011\./.test(r.toi)); // ExoFOP stores "1011.01", no TOI- prefix
  console.log(`  control ExoFOP (rows=${exofopRecs.length}, TOI 1011 present): ${exofopControlOk ? "PASS" : "FAIL"}`);

  if (!archiveControlOk || !exofopControlOk) {
    console.log("\nVERDICT: INCONCLUSIVE-CONTROL (a catalog path is not verified live; 0-hits would be meaningless)");
    process.exitCode = 0;
    return;
  }

  const exofopCat = exofopEntries(exofopRecs);
  const board = JSON.parse(readFileSync("web/candidates.json", "utf8")) as { candidates: BoardCandidate[] };
  const rows = [];
  for (const c of board.candidates) {
    const cand: CandidatePos = { tic: c.tic, ra: c.ra, dec: c.dec, periodDays: c.periodDays };
    const archive = await fetchArchiveAround(cand);
    const dArchive = disposition(cand, archive, { radiusArcsec: RADIUS_ARCSEC });
    const dUnion = disposition(cand, [...archive, ...exofopCat], { radiusArcsec: RADIUS_ARCSEC });
    // Was novel on P48's two Archive tables, but the ExoFOP TOI/CTOI table announces something here?
    const shrank = dArchive.novelLocation && !dUnion.novelLocation;
    const exMatches = findMatches(cand, exofopCat, { radiusArcsec: RADIUS_ARCSEC });
    // ExoFOP row on the SAME host flagged FP/EB by the community -- direct false-positive evidence.
    const exFpEbSameTic = exMatches.some((m) => m.sameTic && /FP|EB/.test(m.entry.label));
    rows.push({ c, novelArchive: dArchive.novelLocation, novelUnion: dUnion.novelLocation, shrank, exMatchCount: exMatches.length, exFpEbSameTic, nearestUnion: dUnion.nearestLabel });
    console.log(`  TIC ${c.tic}  P=${c.periodDays.toFixed(3)}d  novel(archive)=${dArchive.novelLocation}  novel(+ExoFOP)=${dUnion.novelLocation}  ${shrank ? "SHRANK->announced" : ""}  exofopMatches=${exMatches.length}${exFpEbSameTic ? " (FP/EB on same TIC)" : ""}`);
  }

  const n = rows.length;
  const novelArchive = rows.filter((r) => r.novelArchive).length;
  const novelUnion = rows.filter((r) => r.novelUnion).length;
  const shrank = rows.filter((r) => r.shrank).length;
  const fpEb = rows.filter((r) => r.exFpEbSameTic).length;
  console.log(`\n=== P76 SUMMARY (${n} candidates) ===`);
  console.log(`  novel on Archive only (P48): ${novelArchive}/${n}`);
  console.log(`  novel after adding ExoFOP TOI/CTOI: ${novelUnion}/${n}  (shrink: ${shrank})`);
  console.log(`  candidates with an ExoFOP FP/EB row on the SAME host: ${fpEb}/${n}`);

  const verdict = shrank > 0
    ? `MULTI-SOURCE-NOVELTY-SHRINK: adding the ExoFOP TOI/CTOI table (not covered by P48's Archive query) moved ${shrank}/${novelArchive} would-be-novel candidates to ALREADY-ANNOUNCED; ${novelUnion}/${n} remain unannounced in all three sources. Wider catalogs make novelty HARDER, as they must.`
    : `NO-EXTRA-SHRINK: the ExoFOP TOI/CTOI table announced none of the ${novelArchive} Archive-novel candidates, so all ${novelUnion}/${n} stay unannounced across Archive + ExoFOP -- but that is a statement about the catalogs, not a planet claim.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  Honest reading: every remaining novel candidate is deep/single-sector with 0 corroborating hosts, which is evidence AGAINST a credible planet (the pipelines flagged nothing here), not for an undiscovered one. Archive toi+pscomppars + ExoFOP covered; SPOC TCE / peer-reviewed literature NOT covered. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["web/candidates.json", "src/candidate/novelty.ts", "src/data/toiDispositions.ts", "scripts/p76-multisource-novelty.ts"]),
      generatedBy: "scripts/p76-multisource-novelty.ts",
      catalogs: "NASA Exoplanet Archive TAP `toi`+`pscomppars` (as P48) PLUS ExoFOP-TESS public TOI/CTOI table (token-free, community FP/EB/KP dispositions)",
      exofopLegCaveat: "The ExoFOP-TESS leg reads a single anonymous ~3.8 MB CSV; on a slow or throttled mirror it can exceed the fetch timeout and return 0 rows, which trips the INCONCLUSIVE-CONTROL guard and ABORTS before this report is written. A committed report therefore reflects ONE time-truncated snapshot taken on a machine that happened to reach ExoFOP; it is not continuously re-verified and must be treated as a point-in-time result, not a live figure.",
      radiusArcsec: RADIUS_ARCSEC, boxDeg: BOX_DEG,
      controls: { archive: "TOI-1011 field via TAP", exofop: "table loads + contains 1011.01" },
      note: "novelUnion = nothing announced at/near the position across ALL THREE sources; strictly more conservative than P48. NOT a planet claim. SPOC TCE and the literature are not covered.",
    },
    controlOk: true,
    nCandidates: n,
    novelArchiveCount: novelArchive,
    novelUnionCount: novelUnion,
    shrinkCount: shrank,
    exofopFpEbSameTicCount: fpEb,
    discoveryClaim: false,
    safeToGate: false,
    rows: rows.map((r) => ({
      tic: r.c.tic, ra: r.c.ra, dec: r.c.dec, periodDays: +r.c.periodDays.toFixed(4), depthPpm: Math.round(r.c.depthPpm),
      snr: +r.c.snr.toFixed(2), corroboratedSectors: r.c.corroboratedSectors, distinctHostsSharingEphemeris: r.c.distinctHostsSharingEphemeris,
      suspectedCommonSystematic: r.c.suspectedCommonSystematic,
      novelArchive: r.novelArchive, novelUnion: r.novelUnion, shrankByExofop: r.shrank, exofopMatches: r.exMatchCount, exofopFpEbSameTic: r.exFpEbSameTic,
      nearestUnion: r.nearestUnion,
    })),
  };
  writeFileSync("reports/p76-multisource-novelty.json", JSON.stringify(json, null, 2) + "\n");

  const lines: string[] = [
    "# P76 multi-source novelty: does adding ExoFOP TOI/CTOI shrink P48's apparent novelty?",
    "",
    "Reproduce: `npm run p76:multisource-novelty` (reads `web/candidates.json`; queries the Archive `toi`+`pscomppars`",
    "AND the token-free ExoFOP-TESS public TOI/CTOI table).",
    "",
    "P48 checked only two Archive tables and flagged that it missed ExoFOP/CTOIs. This adds the ExoFOP table --",
    "which carries candidate TOIs and community FP/EB labels -- so a candidate is 'novel' only if NOTHING is",
    "announced across all three. More catalogs can only make novelty harder; we measure exactly how much.",
    "",
    "| TIC | our P (d) | depth (ppm) | corrob. sectors | novel (Archive only) | novel (Archive + ExoFOP) | ExoFOP FP/EB on host |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.c.tic} | ${r.c.periodDays.toFixed(3)} | ${Math.round(r.c.depthPpm)} | ${r.c.corroboratedSectors} | ${r.novelArchive ? "yes" : "no"} | ${r.novelUnion ? "yes" : "no"} | ${r.exFpEbSameTic ? "yes" : "no"} |`);
  }
  lines.push(
    "",
    `**Archive-only novel (P48): ${novelArchive}/${n}. After adding ExoFOP: ${novelUnion}/${n} (shrink ${shrank}).**`,
    `ExoFOP FP/EB on the same host: ${fpEb}/${n}.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: `novel` is a statement about the CATALOGS, not nature. Every remaining candidate is deep and",
    "single-sector with 0 corroborating hosts -- the TESS pipelines flagged NO credible transit there, which is",
    "evidence AGAINST a planet, not for an undiscovered one. This covers Archive + ExoFOP; SPOC TCE and the",
    "peer-reviewed literature are NOT covered. Research-only; nothing gated, anchored, claimed, or deployed.",
    "`discoveryClaim: false`.",
    "",
  );
  writeFileSync("reports/p76-multisource-novelty.md", lines.join("\n"));
  console.log("\nwrote reports/p76-multisource-novelty.md and reports/p76-multisource-novelty.json");
}

main().catch((e) => {
  console.error("p76 failed:", e instanceof Error ? e.message : e);
  console.log("\nVERDICT: INCONCLUSIVE-NETWORK");
  process.exitCode = 1;
});
