// FFI BLIND-SEARCH YIELD + NOVELTY PROBE (discovery roadmap, Stage 1).
//
// WHAT THIS IS. A bounded, read-only survey that enumerates real TGLC full-frame-image light curves
// from the token-free public S3 bucket, runs the SAME blind detector the rig uses (bls) on each, and
// then -- for signals in the planet-depth band -- checks NOVELTY against the live confirmed + TOI
// catalogs and emits an honest CANDIDATE RECORD via the Stage 0 contract. This is the first end-to-end
// discovery-pipeline step: real un-targeted data -> blind detection -> novelty -> candidate.
//
// HONEST FRAMING (hard rules):
//   - Nothing here is a discovery claim. Deep periodic signals in FFI data are dominated by eclipsing
//     binaries; a raw BLS peak is a CANDIDATE at best and most are false positives. Stage 2 vetting is
//     what separates them. The candidate contract caps every record at a confidence TIER and forces
//     discoveryClaim=false.
//   - No verdict, no anchoring, no money path. It does not import the worker and cannot touch a bundle
//     hash. It is research infrastructure, like p5/p7/p17.
//   - Novelty is only asserted when BOTH catalogs come from the live archive (source "nasa-tap"). If
//     either falls back to the bundled sample, the scan is far too small to call anything novel, so we
//     SKIP candidate emission rather than over-claim (this is the silent-truncation pitfall, guarded).
//   - Network + runtime bound: one sector, at most --limit curves, per-file failures skipped.
//
// Run:  npm run p19:ffi-blind  [-- --sector 1 --limit 10 --no-novelty]

import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import type { TglcHeaderMeta } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { noveltyFromSets } from "../src/review/externalReview.ts";
import { buildCandidateRecord, formatFollowupCard } from "../src/candidate/candidateRecord.ts";
import { classifyDepthRegime, CALIBRATED_DEPTH } from "../src/candidate/falsePositive.ts";
import { prioritize, formatPriorityCard, DEFAULT_SITE } from "../src/candidate/prioritize.ts";
import { collapseCoincident } from "../src/candidate/dedup.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-ffi-blind)";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** Recursive (no-delimiter) anonymous ListObjectsV2 -> object keys under a prefix. */
async function s3Keys(prefix: string, maxKeys = 1000): Promise<string[]> {
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status} for ${prefix}`);
  const xml = await r.text();
  return [...xml.matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}

async function download(key: string): Promise<Uint8Array | null> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

interface Hit {
  gaiaid: string;
  meta: TglcHeaderMeta;
  lc: LightCurve;
  periodDays: number;
  snr: number;
  depthPpm: number;
  epochBjd: number;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Crude epoch anchor: time of the single deepest (lowest-flux) cadence. Duration is NOT fit here. */
function epochAtMinFlux(lc: LightCurve): number {
  let t = NaN;
  let min = Infinity;
  for (const p of lc.points) if (p.flux < min) { min = p.flux; t = p.time; }
  return t;
}

async function main(): Promise<void> {
  const sector = parseInt(arg("sector", "1"), 10);
  const limit = Math.max(1, parseInt(arg("limit", "10"), 10));
  const wantNovelty = !hasFlag("no-novelty");
  const sectStr = `s${String(sector).padStart(4, "0")}`;
  const prefix = `mast/hlsp/tglc/${sectStr}/`;
  console.log(`[p19] FFI blind-search yield probe: sector ${sectStr}, cap ${limit} curves (token-free TGLC)`);

  let keys: string[];
  try {
    keys = (await s3Keys(prefix)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
  } catch (e) {
    console.log(`[p19] listing failed (network? re-run from a clean edge): ${e instanceof Error ? e.message : e}`);
    console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
    return;
  }
  if (!keys.length) {
    console.log(`[p19] no TGLC _llc.fits keys listed under ${prefix}.`);
    console.log(`\nVERDICT: NO-DATA`);
    return;
  }
  console.log(`[p19] listed ${keys.length} light curves; searching each blind...`);

  const hits: Hit[] = [];
  let parsed = 0;
  let failed = 0;
  for (const key of keys) {
    const m = key.match(/gaiaid-(\d+)/);
    const gaiaid = m ? m[1] : key.split("/").pop() ?? key;
    try {
      const bytes = await download(key);
      if (!bytes) { failed++; continue; }
      const lc = tglcBytesToLightCurve(bytes, `Gaia ${gaiaid}`);
      if (!lc) { failed++; continue; }
      const meta = tglcHeaderMeta(bytes);
      parsed++;
      const r = bls(lc);
      hits.push({ gaiaid, meta, lc, periodDays: r.periodDays, snr: r.snr, depthPpm: r.depth * 1e6, epochBjd: epochAtMinFlux(lc) });
    } catch (e) {
      failed++;
      console.log(`  [skip] ${gaiaid}: ${e instanceof Error ? e.message : e}`);
    }
  }

  hits.sort((a, b) => b.snr - a.snr);
  console.log(`\n[p19] parsed ${parsed} curves, ${failed} unusable. Top blind detections by SNR:`);
  console.log("  gaiaid                cad   period(d)     SNR   depth(ppm)");
  for (const h of hits.slice(0, 15)) {
    console.log(`  ${h.gaiaid.padEnd(21)} ${String(h.lc.points.length).padStart(4)} ${h.periodDays.toFixed(4).padStart(10)} ${h.snr.toFixed(1).padStart(8)} ${h.depthPpm.toFixed(0).padStart(11)}`);
  }

  const depths = hits.map((h) => h.depthPpm);
  const assessed = hits.map((h) => ({ h, d: classifyDepthRegime(h.depthPpm) }));
  const notPlanetary = assessed.filter((a) => !a.d.planetPlausible);
  const deepSuspect = assessed.filter((a) => a.d.regime === "deep-suspect");
  const planetBand = assessed.filter((a) => a.d.planetPlausible && a.h.depthPpm >= 200 && a.h.snr >= 7).map((a) => a.h);
  console.log(`\n[p19] summary: median depth ${median(depths).toFixed(0)} ppm.`);
  console.log(`[p19] Stage-2 depth screen (calibrated): ${notPlanetary.length} beyond the planetary ceiling (>200000 ppm -> eclipsing binary/blend, EXCLUDED); ${deepSuspect.length} deep-suspect (40000-200000 ppm: kept but capped below high); ${planetBand.length} planet-plausible candidates (>=200 ppm, SNR>=7).`);
  console.log(`[p19] calibration source: ${CALIBRATED_DEPTH.source}`);
  console.log(`[p19] NOTE: raw BLS peaks are CANDIDATES, not discoveries; FFI is EB-dominated and this depth screen + a novelty check decide what survives. Odd/even + secondary-eclipse are NOT gated (they mis-kill real planets on single-sector data).`);

  if (!wantNovelty) {
    console.log(`\n[p19] novelty pass skipped (--no-novelty).`);
    console.log(`\nVERDICT: ${parsed > 0 ? "BLIND-SEARCH-RAN" : "NO-USEFUL-DATA"}`);
    return;
  }

  // Build the host-TIC sets from the LIVE archive with LARGE limits (a small limit silently truncates
  // and would let us falsely call a known planet "novel"). We report the scanned counts as the caveat.
  console.log(`\n[p19] pulling confirmed + TOI host catalogs for the novelty gate...`);
  let confirmedSet: Set<number>;
  let toiSet: Set<number>;
  let confSource: string;
  let toiSource: string;
  try {
    const conf = await fetchConfirmedPlanets({ limit: 8000, requireTic: true });
    const toc = await fetchTocCandidates({ limit: 20000 });
    confSource = conf.source;
    toiSource = toc.source;
    confirmedSet = new Set(conf.planets.map((p) => p.tic).filter((t): t is number => Number.isFinite(t)));
    toiSet = new Set(toc.candidates.map((c) => c.tic).filter((t): t is number => Number.isFinite(t)));
  } catch (e) {
    console.log(`[p19] catalog pull failed (network?): ${e instanceof Error ? e.message : e}`);
    console.log(`\nVERDICT: ${parsed > 0 ? "BLIND-SEARCH-RAN" : "NO-USEFUL-DATA"} (novelty INCONCLUSIVE-NETWORK)`);
    return;
  }
  console.log(`[p19] scanned ${confirmedSet.size} confirmed hosts (${confSource}) + ${toiSet.size} TOI hosts (${toiSource}).`);

  if (confSource !== "nasa-tap" || toiSource !== "nasa-tap") {
    console.log(`[p19] HONESTY GUARD: a catalog pull fell back to the bundled sample, so the scan is too`);
    console.log(`[p19] small to assert novelty. NOT emitting candidate records this run (would over-claim).`);
    console.log(`\nVERDICT: BLIND-SEARCH-RAN (novelty SKIPPED-catalog-fallback)`);
    return;
  }

  const asOfUtc = new Date().toISOString();
  const catalogSource = { confirmed: `nasa-tap (${confirmedSet.size} hosts)`, toi: `nasa-tap (${toiSet.size} hosts)`, asOfUtc };
  const nowBjd = Date.now() / 86400000 + 2440587.5; // current epoch (~BJD) for transit-date math
  const emitted: ReturnType<typeof buildCandidateRecord>[] = [];
  let novel = 0;
  let known = 0;
  let incomplete = 0;
  for (const h of planetBand) {
    if (h.meta.tic == null || h.meta.ra == null || h.meta.dec == null || h.meta.tmag == null) {
      incomplete++;
      console.log(`\n[p19] planet-band signal on Gaia ${h.gaiaid} lacks a usable TIC/position in its header; cannot run novelty -- skipped.`);
      continue;
    }
    const novelty = noveltyFromSets(h.meta.tic, confirmedSet, toiSet, confirmedSet.size, toiSet.size);
    if (novelty.inConfirmed || novelty.inToi) {
      known++;
      console.log(`\n[p19] TIC ${h.meta.tic} (P=${h.periodDays.toFixed(3)} d, ${h.depthPpm.toFixed(0)} ppm): already in ${novelty.inConfirmed ? "confirmed" : "TOI"} -> not novel.`);
      continue;
    }
    novel++;
    const record = buildCandidateRecord({
      host: { tic: h.meta.tic, ra: h.meta.ra, dec: h.meta.dec, tmag: h.meta.tmag },
      detection: { periodDays: h.periodDays, epochBjd: h.epochBjd, durationHours: NaN, depthPpm: h.depthPpm, snr: h.snr, nSectors: 1, nPointsInTransit: NaN },
      novelty,
      significance: null, // not yet calibrated this pass -> contract downgrades to low, never high
      vetting: { depth: classifyDepthRegime(h.depthPpm) }, // Stage-2 calibrated depth screen; centroid/blend/geometry still pending
      nextTransitsBjd: [0, 1, 2, 3].map((k) => h.epochBjd + k * h.periodDays),
      dataTier: "real",
      catalogSource,
    });
    console.log(`\n[p19] ===== NOVEL CANDIDATE (tier: ${record.tier}) =====`);
    console.log(formatFollowupCard(record));
    emitted.push(record);
  }

  // Stage 3: rank the surviving candidates by follow-up priority -- evidence + how soon the next transit is
  // + how high it sits from a reference ground site. Epochs are ABSOLUTE BJD (tglc.ts applied BJDREFI), so
  // the predicted transit date and the observability altitude are real, not fabricated.
  //
  // Stage 4 (FP control): collapse candidates that share ONE ephemeris across DIFFERENT host stars -- a real
  // planet lives on one star, so N hosts lighting up at the same (period, epoch) is a sector-common systematic
  // or window alias, not N independent candidates. We rank independent ephemerides (one representative each)
  // and label any collapsed group so the artifact is visible, never silently merged.
  const groups = collapseCoincident(emitted);
  const shared = groups.filter((g) => g.suspectedCommonSystematic);
  if (shared.length) {
    console.log(`\n[p19] Stage-4 FP control: ${shared.length} ephemeris group(s) span multiple hosts (same period+epoch) -> NOT independent; likely a sector-common systematic / window alias. Collapsed to one representative each:`);
    for (const g of shared) console.log(`[p19]   P=${g.representative.detection.periodDays.toFixed(4)} d, T0=${g.representative.detection.epochBjd.toFixed(4)} BJD shared by ${g.distinctHosts} hosts: ${g.members.map((m) => `TIC ${m.host.tic}`).join(", ")}`);
  }
  const ranked = groups
    .map((g) => ({ g, record: g.representative, p: prioritize(g.representative, nowBjd) }))
    .sort((a, b) => b.p.priorityScore - a.p.priorityScore);
  if (ranked.length) {
    console.log(`\n[p19] ===== STAGE-3/4 FOLLOW-UP QUEUE, ranked per independent ephemeris (observability from ${DEFAULT_SITE.name}) =====`);
    ranked.forEach(({ g, record, p }, i) => {
      const dup = g.suspectedCommonSystematic ? ` [collapsed ${g.distinctHosts} coincident hosts -> treat as ONE systematic, needs cross-sector / resolved-blend check]` : "";
      console.log(`\n[p19] ----- rank ${i + 1}: TIC ${record.host.tic} (tier ${record.tier}, priority ${p.priorityBand} ${p.priorityScore.toFixed(2)})${dup} -----`);
      console.log(formatPriorityCard(record, p));
    });
  }

  console.log(`\n[p19] novelty pass: ${planetBand.length} planet-band signals -> ${novel} novel, ${known} already known, ${incomplete} missing host id.`);
  console.log(`[p19] every emitted record is a CANDIDATE at tier '${"low"}' or below until Stage 2 vetting + calibrated significance run; discoveryClaim is structurally false.`);
  console.log(`\nVERDICT: ${parsed > 0 ? "BLIND-SEARCH+NOVELTY-RAN" : "NO-USEFUL-DATA"}`);
}

main().catch((e) => {
  console.error(`[p19] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
