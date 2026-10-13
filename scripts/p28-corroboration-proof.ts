// P28 - cross-sector corroboration PLUMBING PROOF on KNOWN planets (discovery roadmap, Stage 4+).
//
// WHY. The public candidate board's strongest false-positive lever is L4: a real planet's ephemeris recurs
// on the SAME host across INDEPENDENT sectors, which a one-sector instrumental spike cannot fake. But p22
// never triggered it (0 corroborated) because it samples "the first N FFI curves per sector", and adjacent
// sectors hold DISJOINT stars -- the same host is never observed twice. To hunt for a genuine new planet we
// must first PROVE the multi-sector same-host path actually works, using data where we KNOW the answer.
//
// So this is a POSITIVE CONTROL, not a discovery hunt: take confirmed planets, pull the SAME TIC across the
// sectors that cover it (TESS-SPOC PDCSAP, token-free), run the BLIND per-sector BLS (we do NOT feed it the
// catalog period), and ask whether corroboration fires and whether the recovered period matches truth. Two
// corroborators are compared honestly:
//   * corroborateHosts   (strict) -- period AND folded epoch must coincide (the production collapse rule).
//   * corroborateByPeriod (loose) -- only the PERIOD must recur on the host in >=2 sectors; a planet's period
//                                    is intrinsic, so this survives the coarse period resolution of one 27-day
//                                    sector that can break the strict epoch match.
// Whatever it finds -- including "the strict test misses real planets that the period-only test catches", or
// "our blind per-sector recovery is too coarse to corroborate" -- is an honest capability measurement of OUR
// detector, NOT a claim of discovering anything. Research probe: no worker import, no verdict, no bundle hash,
// no money path, nothing anchored, nothing published.
//
// Run:  npm run p28:corroboration-proof  [-- --targets 10 --maxsectors 4 --minperiod 1 --maxperiod 13 --tmag 11]

import { bls } from "../src/detect/bls.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { buildCandidateRecord } from "../src/candidate/candidateRecord.ts";
import { corroborateHosts, type TaggedCandidate } from "../src/candidate/dedup.ts";
import { corroborateByPeriod, type PeriodDetection } from "../src/candidate/corroboration.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const want = Math.max(1, parseInt(arg("targets", "10"), 10));
const maxSectors = Math.max(2, parseInt(arg("maxsectors", "4"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const minSnr = Number(arg("snr", "7"));
const periodTolPct = Number(arg("periodtol", "2"));
const matchTolPct = Number(arg("matchtol", "5")); // blind period within this % of catalog = a real recovery

const asOfUtc = new Date().toISOString();
const catalogSource = { confirmed: "nasa-tap", toi: "nasa-tap", asOfUtc };

// Best-effort download with a couple of retries so a transient socket close is not mistaken for "no data".
async function fetchSectorCurve(tic: number, sector: number, name: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lc = await fetchSpocLightCurve(tic, [sector], name);
      if (lc) return lc;
    } catch { /* transient; retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

interface Row {
  name: string; tic: number; catPeriod: number; nSectorsUsable: number; nSignif: number;
  strictSectors: number; strictCorroborated: boolean;
  periodSectors: number; periodCorroborated: boolean; periodCorroboratedAt: number;
  periodMatchedTruth: boolean;
}

async function main(): Promise<void> {
  console.log(
    `P28 corroboration plumbing proof: ${want} confirmed planets, P in [${minPeriod},${maxPeriod}] d, T<=${tmagCap}, ` +
    `up to ${maxSectors} sectors each, blind per-sector BLS (SNR>=${minSnr}). REAL photometry; research probe, no gating, no discovery claim.`,
  );

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null && Number.isFinite(p.pl_orbper!))
    .slice(0, want * 4);

  const rows: Row[] = [];
  let scanned = 0;
  for (const p of planets) {
    if (rows.length >= want) break;
    scanned++;
    const tic = p.tic!;
    const name = p.pl_name ?? p.hostname ?? `TIC ${tic}`;
    const catPeriod = p.pl_orbper!;
    let sectors: number[];
    try {
      sectors = await sectorsForCoord(p.ra!, p.dec!);
    } catch {
      continue;
    }
    if (sectors.length < 2) {
      console.log(`  ${name.padEnd(18)} P=${catPeriod.toFixed(3)}d  only ${sectors.length} sector(s) cover it -> skip`);
      continue;
    }

    const detections: PeriodDetection[] = [];
    const tagged: TaggedCandidate[] = [];
    let nUsable = 0;
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(tic, s, name);
      if (!lc || lc.points.length < 60) continue;
      nUsable++;
      let r;
      try {
        r = bls(lc, { maxPeriodDays: maxPeriod + 2 });
      } catch {
        continue;
      }
      const depthPpm = r.depth * 1e6;
      if (r.snr < minSnr || depthPpm < 200 || !classifyDepthRegime(depthPpm).planetPlausible) continue;
      detections.push({ tic, sector: s, periodDays: r.periodDays });
      const record = buildCandidateRecord({
        host: { tic, ra: p.ra!, dec: p.dec!, tmag: p.sy_tmag ?? tmagCap },
        detection: { periodDays: r.periodDays, epochBjd: r.epochBjd, durationHours: r.durationDays * 24, depthPpm, snr: r.snr, nSectors: 1, nPointsInTransit: r.nInTransit },
        novelty: { inConfirmed: true, inToi: false, confirmedScanned: 1, toiScanned: 0 }, // this IS a known planet (positive control)
        significance: null,
        vetting: { depth: classifyDepthRegime(depthPpm) },
        nextTransitsBjd: [0, 1, 2].map((k) => r.epochBjd + k * r.periodDays),
        dataTier: "real",
        catalogSource,
      });
      tagged.push({ record, sector: s });
    }

    const strict = corroborateHosts(tagged).find((c) => c.tic === tic);
    const loose = corroborateByPeriod(detections, periodTolPct).find((c) => c.tic === tic);
    const periodSectors = loose?.distinctSectors ?? 0;
    const periodCorroborated = loose?.corroborated ?? false;
    const periodCorroboratedAt = loose?.bestPeriodDays ?? NaN;
    const periodMatchedTruth = periodCorroborated && Math.abs(periodCorroboratedAt - catPeriod) / catPeriod * 100 <= matchTolPct;

    const row: Row = {
      name, tic, catPeriod, nSectorsUsable: nUsable, nSignif: detections.length,
      strictSectors: strict?.distinctSectors ?? 0, strictCorroborated: strict?.corroborated ?? false,
      periodSectors, periodCorroborated, periodCorroboratedAt, periodMatchedTruth,
    };
    rows.push(row);
    console.log(
      `  ${name.padEnd(18)} P=${catPeriod.toFixed(3)}d  usable ${nUsable}  signif ${detections.length}  ` +
      `strict ${row.strictSectors}sec${row.strictCorroborated ? " CORROB" : ""}  ` +
      `period ${periodSectors}sec${periodCorroborated ? ` CORROB@${periodCorroboratedAt.toFixed(3)}${periodMatchedTruth ? " MATCH" : " off"}` : ""}`,
    );
  }

  if (!rows.length) {
    console.log(`\nNo multi-sector planets resolved (TAP/SPOC fallback or too few sectors). scanned=${scanned}. Re-run shortly.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const with2signif = rows.filter((r) => r.nSignif >= 2).length;
  const strictCorr = rows.filter((r) => r.strictCorroborated).length;
  const looseCorr = rows.filter((r) => r.periodCorroborated).length;
  const looseMatch = rows.filter((r) => r.periodMatchedTruth).length;
  const looseCorrButStrictMissed = rows.filter((r) => r.periodCorroborated && !r.strictCorroborated).length;

  console.log(`\n=== P28 SUMMARY (${rows.length} confirmed planets with >=2 covering sectors) ===`);
  console.log(`  planets with >=2 SIGNIFICANT blind detections across sectors : ${with2signif}/${rows.length}`);
  console.log(`  STRICT corroboration (period+epoch) fired                     : ${strictCorr}/${rows.length}`);
  console.log(`  PERIOD-ONLY corroboration fired                               : ${looseCorr}/${rows.length}`);
  console.log(`  ... of those, blind period within ${matchTolPct}% of catalog truth             : ${looseMatch}/${looseCorr}`);
  console.log(`  period-only caught what the strict test MISSED                : ${looseCorrButStrictMissed}`);

  console.log(
    `\nInterpretation (measure-before-gate): this is a capability self-test on KNOWN planets, not a discovery. ` +
    `If the strict corroborateHosts fires on few real planets while the period-only test fires on more, the ` +
    `bottleneck for cross-sector corroboration is the coarse PERIOD/epoch resolution of a single 27-day sector, ` +
    `not the absence of recurrence -- and a novel-target hunt must lean on period agreement (and eventually ` +
    `longer/more baselines), not a tight epoch match. If even the period-only test rarely fires, our blind ` +
    `per-sector detector is below the recovery floor for these depths and a defensible new-planet claim needs ` +
    `deeper/longer data than a hobby blind pass over public FFI can supply. Either outcome is reported as-is.`,
  );
  console.log(`\nVERDICT: CORROBORATION-PROOF-RAN`);
}

main().catch((e) => {
  console.error(`[p28] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
