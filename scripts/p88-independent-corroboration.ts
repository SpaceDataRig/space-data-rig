// P88 -- FIRST 2x2 WITH AN INDEPENDENT INSTRUMENT (discovery roadmap M1).
//
// Question: can Gaia (a DIFFERENT satellite, measuring RV/astrometry rather than photometric dips) independently
// corroborate the eclipsing-binary / stellar-companion explanation for a signal -- the thing that would let a
// no-catalog-match candidate be graded beyond needs-more-data WITHOUT relying on TESS alone? We score TWO real,
// labelled populations pulled token-free:
//   POSITIVES = ExoFOP confirmed planets (KP) -- Gaia must NOT call a real planet's transit period an EB;
//   NEGATIVES = ExoFOP FP / eclipsing-binary (EB) labels -- an EB at the candidate period is what Gaia SHOULD catch.
// For each host we resolve its Gaia DR3 source_id (cone), pull the two-body orbit + epoch RVs + summary flags, and
// run rvAstrometryVsCandidate. The scorer is the repo's standard vetoAcceptance 2x2. The DISQUALIFYING number is a
// false veto (a real planet Gaia wrongly brands an EB) -- any occurrence keeps the independent channel out of the
// money/verdict path (measure-before-gate). Catch-rate is a LOWER bound: many hosts have no Gaia orbit at all.
//
// Research-only: NOT imported by the worker; no verdict / bundle hash / money path; discoveryClaim stays false.
// NETWORK read-only, run locally (CI has no network), like p57/p58. Usage:
//   npm run p88:independent-corroboration -- --pos 8 --neg 8 --tmag 12
import { writeFileSync, mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildStamp } from "./report-freshness.ts";
import { fetchToiTable, confirmedPositives, labelledNegatives, type ToiRecord } from "../src/data/toiDispositions.ts";
import { fetchGaiaNeighborhood, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { fetchGaiaCorroboration, rvAstrometryVsCandidate } from "../src/data/gaiaRv.ts";
import { vetoMetrics, acceptVetoTool, type VetoCase } from "../src/candidate/vetoAcceptance.ts";

const HOST_MATCH_ARCSEC = 3.0;
const QUERY_TIMEOUT_MS = 150000;

function arg(name: string, dflt: string): string {
  const argv = process.argv;
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

interface Scored {
  id: string;
  isBlend: boolean;
  hasGaiaData: boolean;
  periodMatched: boolean;
  ebExclusion: string;
  veto: boolean;
}

/** Nearest Gaia DR3 source within arcsec of the host position -> its string source_id. */
async function resolveHostGaiaId(rec: ToiRecord): Promise<string | null> {
  if (!Number.isFinite(rec.ra) || !Number.isFinite(rec.dec)) return null;
  const sources = await fetchGaiaNeighborhood(rec.ra, rec.dec, { radiusDeg: HOST_MATCH_ARCSEC / 3600, timeoutMs: QUERY_TIMEOUT_MS });
  let best = "";
  let bestSep = Infinity;
  for (const g of sources) {
    const sep = angularSepArcsec(rec.ra, rec.dec, g.ra, g.dec);
    if (sep <= HOST_MATCH_ARCSEC && sep < bestSep) { bestSep = sep; best = g.sourceId; }
  }
  return best || null;
}

async function scoreOne(rec: ToiRecord, isBlend: boolean): Promise<{ c: VetoCase; s: Scored } | null> {
  const id = (await resolveHostGaiaId(rec).catch(() => null)) ?? "";
  if (!id) return null;
  const data = await fetchGaiaCorroboration(id, { timeoutMs: QUERY_TIMEOUT_MS }).catch(() => null);
  if (!data) return null;
  const hasGaiaData = Boolean(data.orbit) || data.epochs.length > 0 || (data.flags != null && (data.flags.hasRvs || data.flags.nonSingleStarBits > 0));
  const v = rvAstrometryVsCandidate({ candidatePeriodDays: rec.periodDays, orbit: data.orbit, epochs: data.epochs, flags: data.flags });
  // continuous blend-ness score for the ROC = the orbit's stellar RV semi-amplitude when the period matches;
  // unmatched / no-orbit cases carry no score so they never fabricate ROC shape.
  const kOrbit = data.orbit && v.periodMatched && Number.isFinite(data.orbit.kPrimaryMps) ? data.orbit.kPrimaryMps : undefined;
  const label = rec.toi || `TIC ${rec.tic}`;
  const c: VetoCase = { id: `${label}:${P88_TAG(isBlend)}`, isBlend, veto: v.blendCorroborated, score: kOrbit };
  const s: Scored = { id: label, isBlend, hasGaiaData, periodMatched: v.periodMatched, ebExclusion: v.ebExclusion, veto: v.blendCorroborated };
  console.error(`p88: ${label} P=${rec.periodDays.toFixed(3)}d ${isBlend ? "NEG(EB/FP)" : "POS(KP)"} data=${hasGaiaData ? "y" : "n"} -> ${v.ebExclusion}${v.periodMatched ? " [matched]" : ""}`);
  return { c, s };
}

function P88_TAG(isBlend: boolean): string { return isBlend ? "eb" : "kp"; }

async function run(list: ToiRecord[], isBlend: boolean): Promise<{ cases: VetoCase[]; scored: Scored[] }> {
  const cases: VetoCase[] = [];
  const scored: Scored[] = [];
  for (const rec of list) {
    const r = await scoreOne(rec, isBlend);
    if (r) { cases.push(r.c); scored.push(r.s); }
    await new Promise((res) => setTimeout(res, 800)); // gentle pause vs Gaia throttling
  }
  return { cases, scored };
}

/** The LIVE measurement path -- only reached with `--live`. Pulls the labelled ExoFOP populations, resolves each host to
 *  its Gaia DR3 source and scores whether Gaia independently corroborates an EB at the candidate period. */
async function measureLive(): Promise<{ cases: VetoCase[]; scored: Scored[]; posN: number; negN: number; tmag: number }> {
  const posN = Math.max(1, Number(arg("pos", "8")) || 8);
  const negN = Math.max(1, Number(arg("neg", "8")) || 8);
  const tmag = Number(arg("tmag", "12")) || 12;
  const all = await fetchToiTable({});
  if (!all.length) { console.error("p88: ExoFOP TOI table unavailable (network) -- ABORT, no fabricated 2x2."); return { cases: [], scored: [], posN, negN, tmag }; }
  const posPool = confirmedPositives(all).filter((r) => Number.isFinite(r.periodDays) && r.periodDays > 0 && r.tessMag <= tmag);
  const negPool = labelledNegatives(all).filter((r) => Number.isFinite(r.periodDays) && r.periodDays > 0 && r.tessMag <= tmag);
  console.error(`p88: pool positives=${posPool.length} negatives=${negPool.length} (tmag<=${tmag}); scoring ${posN}+${negN} with Gaia DR3 ...`);

  const pos = await run(posPool.slice(0, posN), false);
  const neg = await run(negPool.slice(0, negN), true);
  return { cases: [...pos.cases, ...neg.cases], scored: [...pos.scored, ...neg.scored], posN, negN, tmag };
}

async function main(): Promise<void> {
  // FROZEN DATA SOURCE -- the p75/p90/p41 precedent, applied here. p88 measures against the LIVE ExoFOP TOI table and
  // Gaia DR3 TAP; a plain re-fetch re-MEASURES on whatever those catalogs return NOW, silently moving the published
  // coverage / 2x2 (the exact drift that burned p90). The per-candidate outcomes are therefore frozen into
  // reports/fixtures/p88-frozen-cases.json (a committed snapshot of what a live run gathered, dated at measurement) and
  // the DEFAULT replays the 2x2 from those rows OFFLINE via the same vetoMetrics/acceptVetoTool the live run used --
  // re-DERIVING the metrics, not copying them. `--live` (or `--from-json=`) is the deliberate re-measure path.
  const FROZEN = "reports/fixtures/p88-frozen-cases.json";
  const REPLAY = arg("from-json", process.argv.includes("--live") ? "" : FROZEN);
  let cases: VetoCase[] = [];
  let scored: Scored[] = [];
  let posN = 8, negN = 8, tmag = 12;
  let measuredAt = new Date().toISOString();
  if (REPLAY) {
    const j = JSON.parse(readFileSync(REPLAY, "utf8")) as {
      cases: (VetoCase & { score?: number | null })[];
      scored: Scored[];
      measuredAt?: string;
      meta?: { posN?: number; negN?: number; tmag?: number };
    };
    cases = j.cases.map((c) => ({ id: c.id, isBlend: c.isBlend, veto: c.veto, score: c.score ?? undefined }));
    scored = j.scored;
    posN = j.meta?.posN ?? posN;
    negN = j.meta?.negN ?? negN;
    tmag = j.meta?.tmag ?? tmag;
    measuredAt = j.measuredAt ?? "unknown";
    console.error(`p88: REPLAY from ${REPLAY}: ${scored.length} stored candidates, original measurement ${measuredAt}. No network, no new measurement.`);
  } else {
    const m = await measureLive();
    cases = m.cases; scored = m.scored; posN = m.posN; negN = m.negN; tmag = m.tmag;
  }
  if (cases.length === 0) { console.error("p88: no host resolved to Gaia -- nothing to score."); process.exitCode = 1; return; }

  const metrics = vetoMetrics(cases);
  const verdict = acceptVetoTool(cases, { targetPower: 0.5, chanceFloor: 0.5, maxFalseVetoes: 0 });
  const nData = scored.filter((s) => s.hasGaiaData).length;
  const nMatched = scored.filter((s) => s.periodMatched).length;
  const positives = scored.filter((s) => !s.isBlend).length;
  const negatives = scored.filter((s) => s.isBlend).length;

  const out = {
    schema: "sdr-p88-independent-corroboration/1",
    // Replay stamps the SCRIPT + the FROZEN rows (both tracked -> any clean checkout re-hashes them -> verified), NOT the
    // Gaia/ExoFOP fetch modules, so a catalog update cannot mark this cited report stale and force a drift-inducing
    // re-measure; `--live` stamps the fetch modules because there they really produced the numbers (the p75 discipline).
    ...buildStamp(REPLAY
      ? ["scripts/p88-independent-corroboration.ts", FROZEN]
      : ["src/data/toiDispositions.ts", "src/data/gaiaRv.ts", "src/data/gaiaDilution.ts", "scripts/p88-independent-corroboration.ts"]),
    instrument: "Gaia DR3 TAP (independent of TESS): vari_epoch_radial_velocity + nss_two_body_orbit + gaia_source flags",
    labelSource: "ExoFOP-TESS public TOI table (token-free): KP positives, FP/EB negatives",
    measuredAt,
    data: REPLAY
      ? "FROZEN snapshot of the per-candidate Gaia-corroboration outcomes (nearest-DR3-source orbit/RV flags vs the labelled ExoFOP population), replayed offline -- the live sample as measured, not re-queried"
      : "live Gaia DR3 TAP vs ExoFOP-TESS labelled population, re-queried",
    population: { positives, negatives, withGaiaData: nData, periodMatched: nMatched },
    metrics,
    verdict: { safeToGate: verdict.safeToGate, reason: verdict.reason, auc: verdict.auc },
    falseVeto: metrics.cm.falseVeto, // the disqualifying number
    discoveryClaim: false,
    cases: scored,
  };
  const md = [
    "# P88 independent-instrument 2x2 -- a COVERAGE measurement, not yet a Gaia-vs-TESS crossmatch (period-matched orbits: 0)",
    "",
    REPLAY
      ? `Reproduce: \`npm run p88:independent-corroboration\` replays the frozen rows offline; \`npm run p88:independent-corroboration -- --live\` re-measures against the live ExoFOP/Gaia (and may move the numbers).`
      : `Reproduce: \`npm run p88:independent-corroboration -- --pos ${posN} --neg ${negN} --tmag ${tmag}\``,
    REPLAY ? `This report is an OFFLINE REPLAY of the ${cases.length} candidate measurements frozen on ${measuredAt} (sampled --pos ${posN} --neg ${negN} --tmag ${tmag}); the 2x2 is byte-stable across runs.` : "",
    "",
    `**Headline (read first): ${nMatched} of ${cases.length} hosts had a Gaia orbit ON the candidate period, so this run measured INDEPENDENT-INSTRUMENT COVERAGE (Gaia data present for ${nData}/${cases.length}) -- NOT a Gaia-vs-TESS period crossmatch. With ${nMatched} period matches the two datasets never actually intersected, so the 2x2 is all-zeros BY CONSTRUCTION. The honest read is "safe but under-powered", never "Gaia agrees/disagrees"; discoveryClaim false.**`,
    "",
    `Gaia (a different satellite) is asked, for ${positives} confirmed planets (must keep) and ${negatives} labelled FP/EB blends (should veto): does its two-body orbit / RV series independently corroborate a stellar-mass companion on the candidate's period?`,
    "",
    `Independent Gaia data present for **${nData}/${cases.length}** hosts; an orbit on the candidate period for **${nMatched}**.`,
    "",
    "| | labelled blend (should veto) | labelled planet (must keep) |",
    "|---|---|---|",
    `| Gaia corroborates an EB | ${metrics.cm.trueVeto} | ${metrics.cm.falseVeto} |`,
    `| Gaia does not | ${metrics.cm.missedBlend} | ${metrics.cm.trueKeep} |`,
    "",
    `- veto power (blends Gaia corroborates): ${metrics.vetoPower == null ? "n/a" : metrics.vetoPower.toFixed(2) + " " + JSON.stringify(metrics.vetoPowerCI)} (LOWER bound -- most hosts have no Gaia orbit)`,
    `- false-veto (real planets Gaia brands an EB): ${metrics.cm.falseVeto} of ${metrics.nPlanet} (${metrics.falseVetoRate == null ? "n/a" : metrics.falseVetoRate.toFixed(3)}) -- any > 0 disqualifies`,
    `- AUC (orbit RV semi-amplitude, period-matched cases): ${verdict.auc == null ? "n/a" : verdict.auc.toFixed(3)}`,
    "",
    `**VERDICT: safeToGate = ${verdict.safeToGate}.** ${verdict.reason}`,
    "",
    "Independent-instrument corroboration is a genuine second opinion (not TESS re-reading its own pixels);",
    "but at this coverage it can only EXCLUDE blends it has an orbit for, so its catch-rate is a lower bound and a",
    "single false veto on a known planet keeps it out of the money/verdict path. research-only; discoveryClaim false;",
    "nothing here is anchored, gated, or deployed.",
  ].join("\n");

  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p88-independent-corroboration.json", JSON.stringify(out, null, 2), "utf8");
  writeFileSync("reports/p88-independent-corroboration.md", md + "\n", "utf8");
  if (dirname("reports") !== "reports") void 0;
  console.error(`p88: wrote reports/p88-independent-corroboration.{md,json} | verdict ${verdict.safeToGate ? "GATE-READY" : "NOT-GATE-READY"} | falseVeto=${metrics.cm.falseVeto}`);
}

const invokedDirectly = /p88-independent-corroboration(\.ts)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) main().catch((e) => { console.error(`p88: fatal: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
