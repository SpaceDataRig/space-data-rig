// MULTI-SECTOR BLIND-SEARCH AGGREGATOR with cross-sector corroboration + local persistence
// (discovery roadmap, Stage 4 -- scale + false-positive control).
//
// WHAT THIS DOES. Runs the SAME per-star blind chain as p19 (TGLC download -> blind BLS -> Stage-2 depth
// screen -> novelty gate -> candidate contract) across SEVERAL sectors, then aggregates:
//   * collapseCoincident -- ephemerides shared by multiple host stars are ONE sector-common systematic, not
//     N candidates (p19 showed 4 different TICs reporting one 10.13 d / same T0 in Sector 1).
//   * corroborateHosts -- the honest cross-sector test: a real planet reappears at the same (period, epoch)
//     on the SAME host across INDEPENDENT sectors; a single-sector systematic does not.
// Surviving candidates are persisted to a local JSON RESEARCH ARTIFACT (out/, git-ignored) -- NOT the
// production DO/R2 store -- and printed as a ranked follow-up queue.
//
// HONEST FRAMING (hard rules, same as p19): nothing here is a discovery claim; it does no anchoring, no
// POST, no money path, and is not imported by the worker. Novelty is asserted only when BOTH catalogs come
// from the live archive (source "nasa-tap"); on fallback it skips the novelty label rather than over-claim.
// Network + runtime bound: a handful of sectors, at most --limit curves each, per-file failures skipped.
//
// Run:  npm run p22:blind-multisector  [-- --sectors 1,2,3 --limit 6 --out out/candidates-multisector.json]

import { writeFileSync } from "node:fs";
import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import type { TglcHeaderMeta } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { noveltyFromSets } from "../src/review/externalReview.ts";
import { buildCandidateRecord } from "../src/candidate/candidateRecord.ts";
import type { CandidateRecord } from "../src/candidate/candidateRecord.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { collapseCoincident, corroborateHosts, type TaggedCandidate } from "../src/candidate/dedup.ts";
import { partitionBySystematic } from "../src/candidate/corroboration.ts";
import { prioritize, DEFAULT_SITE } from "../src/candidate/prioritize.ts";
import { validateSnapshot, CANDIDATE_SCHEMA, CANDIDATE_DISCLAIMER, type CandidateRow, type CandidateSnapshot } from "../src/candidate/snapshot.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-ffi-multisector)";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function s3Keys(prefix: string, maxKeys = 1000): Promise<string[]> {
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status} for ${prefix}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}
async function download(key: string): Promise<Uint8Array | null> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}
function epochAtMinFlux(lc: LightCurve): number {
  let t = NaN;
  let min = Infinity;
  for (const p of lc.points) if (p.flux < min) { min = p.flux; t = p.time; }
  return t;
}

interface Blip { gaiaid: string; meta: TglcHeaderMeta; periodDays: number; snr: number; depthPpm: number; epochBjd: number; sector: number; }

async function scanSector(sector: number, limit: number): Promise<Blip[]> {
  const sectStr = `s${String(sector).padStart(4, "0")}`;
  let keys: string[];
  try {
    keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
  } catch (e) {
    console.log(`[p22] sector ${sectStr} listing failed (network?): ${e instanceof Error ? e.message : e}`);
    return [];
  }
  const out: Blip[] = [];
  for (const key of keys) {
    const m = key.match(/gaiaid-(\d+)/);
    const gaiaid = m ? m[1] : key.split("/").pop() ?? key;
    try {
      const bytes = await download(key);
      if (!bytes) continue;
      const lc = tglcBytesToLightCurve(bytes, `Gaia ${gaiaid}`);
      if (!lc) continue;
      const meta = tglcHeaderMeta(bytes);
      const r = bls(lc);
      out.push({ gaiaid, meta, periodDays: r.periodDays, snr: r.snr, depthPpm: r.depth * 1e6, epochBjd: epochAtMinFlux(lc), sector });
    } catch { /* skip an unusable curve */ }
  }
  console.log(`[p22] sector ${sectStr}: ${keys.length} listed, ${out.length} parsed.`);
  return out;
}

async function main(): Promise<void> {
  const sectors = arg("sectors", "1,2,3").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  const limit = Math.max(1, parseInt(arg("limit", "6"), 10));
  const outPath = arg("out", "out/candidates-multisector.json");
  const wantNovelty = !hasFlag("no-novelty");
  // L3 is now APPLIED by default: ephemerides shared by multiple hosts are sector-common systematics (p26 measured
  // dropping them cuts the FAP-surviving false alarms ~52-63% at zero cost to single-host planets), so they are NOT
  // emitted as candidate rows -- only counted. --keep-systematic restores the old flag-only behaviour.
  const keepSystematic = hasFlag("keep-systematic");
  console.log(`[p22] multi-sector blind search: sectors=[${sectors.join(",")}], cap ${limit} curves each (token-free TGLC).`);

  const blips: Blip[] = [];
  for (const s of sectors) blips.push(...(await scanSector(s, limit)));
  if (!blips.length) {
    console.log(`[p22] no usable curves. VERDICT: NO-USEFUL-DATA (network? re-run).`);
    return;
  }

  // Stage-2 depth screen + SNR gate: planet-plausible signals carried forward.
  const planetBand = blips.filter((b) => classifyDepthRegime(b.depthPpm).planetPlausible && b.depthPpm >= 200 && b.snr >= 7);
  console.log(`\n[p22] ${blips.length} raw detections -> ${planetBand.length} planet-plausible (>=200 ppm, SNR>=7).`);

  let confirmedSet = new Set<number>();
  let toiSet = new Set<number>();
  let catalogSource = { confirmed: "skipped", toi: "skipped", asOfUtc: new Date().toISOString() };
  const asOfUtc = new Date().toISOString();
  if (wantNovelty) {
    const conf = await fetchConfirmedPlanets({ limit: 8000, requireTic: true });
    const toc = await fetchTocCandidates({ limit: 20000 });
    if (conf.source === "nasa-tap" && toc.source === "nasa-tap") {
      confirmedSet = new Set(conf.planets.map((p) => p.tic).filter((t): t is number => Number.isFinite(t)));
      toiSet = new Set(toc.candidates.map((c) => c.tic).filter((t): t is number => Number.isFinite(t)));
      catalogSource = { confirmed: `nasa-tap (${confirmedSet.size} hosts)`, toi: `nasa-tap (${toiSet.size} hosts)`, asOfUtc };
      console.log(`[p22] novelty catalogs: ${confirmedSet.size} confirmed + ${toiSet.size} TOI hosts.`);
    } else {
      console.log(`[p22] HONESTY GUARD: catalog pull fell back (confirmed=${conf.source}, toc=${toc.source}); running WITHOUT a novelty label (cannot assert new).`);
    }
  }

  const tagged: TaggedCandidate[] = [];
  for (const b of planetBand) {
    if (b.meta.tic == null || b.meta.ra == null || b.meta.dec == null || b.meta.tmag == null) continue;
    const novelty = wantNovelty && (confirmedSet.size || toiSet.size)
      ? noveltyFromSets(b.meta.tic, confirmedSet, toiSet, confirmedSet.size, toiSet.size)
      : { inConfirmed: false, inToi: false, confirmedScanned: -1, toiScanned: -1 };
    if (novelty.inConfirmed || novelty.inToi) continue; // already known -> not a candidate
    const record = buildCandidateRecord({
      host: { tic: b.meta.tic, ra: b.meta.ra, dec: b.meta.dec, tmag: b.meta.tmag },
      detection: { periodDays: b.periodDays, epochBjd: b.epochBjd, durationHours: NaN, depthPpm: b.depthPpm, snr: b.snr, nSectors: 1, nPointsInTransit: NaN },
      novelty,
      significance: null,
      vetting: { depth: classifyDepthRegime(b.depthPpm) },
      nextTransitsBjd: [0, 1, 2].map((k) => b.epochBjd + k * b.periodDays),
      dataTier: "real",
      catalogSource,
    });
    tagged.push({ record, sector: b.sector });
  }

  const groups = collapseCoincident(tagged.map((t) => t.record));
  const { independent, systematic } = partitionBySystematic(groups);
  const emitGroups = keepSystematic ? groups : independent;
  const multiHostSystematic = groups.filter((g) => g.suspectedCommonSystematic);
  const corrob = corroborateHosts(tagged);
  const corroborated = corrob.filter((c) => c.corroborated);
  console.log(`\n[p22] Stage-4 FP control: ${groups.length} independent ephemeris group(s); ${multiHostSystematic.length} span multiple hosts (sector-common systematic); ${corroborated.length} host(s) corroborated across >=2 sectors.`);
  console.log(`[p22] L3 ${keepSystematic ? "OFF (--keep-systematic): all groups emitted as rows" : "APPLIED (default): " + systematic.length + " multi-host shared-ephemeris group(s) collapsed as systematics and NOT emitted as candidates"}.`);
  for (const c of corroborated) console.log(`[p22]   CORROBORATED: TIC ${c.tic} P=${c.bestPeriodDays.toFixed(4)} d recurs in ${c.distinctSectors} sectors.`);

  // Build a validated CANDIDATE SNAPSHOT. The validator enforces the honesty invariant (every row
  // discoveryClaim===false, sane numbers); if it fails we DO NOT write, so a misleading file can never be
  // published. --out defaults to a local research artifact; --out=web/candidates.json publishes it as the
  // static asset the console's (opt-in) Candidate Board reads.
  const nowBjd = Date.now() / 86400000 + 2440587.5;
  const corrobByTic = new Map(corrob.map((c) => [c.tic, c]));
  const rows: CandidateRow[] = emitGroups
    .map((g) => ({ g, record: g.representative, p: prioritize(g.representative, nowBjd) }))
    .sort((a, b) => b.p.priorityScore - a.p.priorityScore)
    .map(({ g, record, p }): CandidateRow => ({
      tic: record.host.tic, ra: record.host.ra, dec: record.host.dec, tmag: record.host.tmag,
      periodDays: record.detection.periodDays, epochBjd: record.detection.epochBjd, depthPpm: record.detection.depthPpm, snr: record.detection.snr,
      tier: record.tier, depthRegime: record.vetting?.depth?.regime ?? "unknown",
      priorityBand: p.priorityBand, priorityScore: p.priorityScore,
      nextTransitBjd: Number.isFinite(p.nextTransitBjd) ? p.nextTransitBjd : null,
      daysUntilNext: Number.isFinite(p.daysUntilNext) ? p.daysUntilNext : null,
      altitudeDeg: p.altitudeAtMidTransitDeg, observable: p.observableFromSite, siteName: DEFAULT_SITE.name,
      distinctHostsSharingEphemeris: g.distinctHosts, suspectedCommonSystematic: g.suspectedCommonSystematic,
      corroboratedSectors: corrobByTic.get(record.host.tic)?.distinctSectors ?? 1,
      discoveryClaim: false,
    }));
  const snapshot: CandidateSnapshot = {
    schema: CANDIDATE_SCHEMA,
    generatedAt: asOfUtc,
    sectors,
    referenceSite: DEFAULT_SITE.name,
    disclaimer: CANDIDATE_DISCLAIMER,
    calibrationNote: "depth screen per src/candidate/falsePositive.ts (npm run p21:depth-calibrate): hard ceiling 200000 ppm, deep-suspect 40000 ppm, from n=4207 confirmed transit depths",
    summary: { rawDetections: blips.length, planetPlausible: planetBand.length, independentEphemerides: groups.length, multiHostSystematicGroups: multiHostSystematic.length, systematicCollapsed: systematic.length, emittedCandidates: rows.length, l3Applied: !keepSystematic, corroboratedHosts: corroborated.length },
    candidates: rows,
  };
  const v = validateSnapshot(snapshot);
  if (!v.ok) {
    console.error("\n[p22] snapshot FAILED validation -- refusing to write a misleading file:");
    for (const e of v.errors) console.error(`  - ${e}`);
    console.log(`\nVERDICT: SNAPSHOT-INVALID`);
    return;
  }
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`\n[p22] wrote ${rows.length} validated candidate row(s) to ${outPath} (schema ${CANDIDATE_SCHEMA}; discoveryClaim structurally false for every row).`);
  console.log(`[p22] this file is a research snapshot; publishing it to web/candidates.json is what the opt-in Candidate Board reads. Nothing here is surfaced or anchored automatically.`);
  console.log(`\nVERDICT: MULTI-SECTOR-RAN`);
}

main().catch((e) => {
  console.error(`[p22] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
