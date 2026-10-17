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
import { dirname } from "node:path";
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

async function main(): Promise<void> {
  const posN = Math.max(1, Number(arg("pos", "8")) || 8);
  const negN = Math.max(1, Number(arg("neg", "8")) || 8);
  const tmag = Number(arg("tmag", "12")) || 12;
  const all = await fetchToiTable({});
  if (!all.length) { console.error("p88: ExoFOP TOI table unavailable (network) -- ABORT, no fabricated 2x2."); process.exitCode = 1; return; }
  const posPool = confirmedPositives(all).filter((r) => Number.isFinite(r.periodDays) && r.periodDays > 0 && r.tessMag <= tmag);
  const negPool = labelledNegatives(all).filter((r) => Number.isFinite(r.periodDays) && r.periodDays > 0 && r.tessMag <= tmag);
  console.error(`p88: pool positives=${posPool.length} negatives=${negPool.length} (tmag<=${tmag}); scoring ${posN}+${negN} with Gaia DR3 ...`);

  const pos = await run(posPool.slice(0, posN), false);
  const neg = await run(negPool.slice(0, negN), true);
  const cases = [...pos.cases, ...neg.cases];
  const scored = [...pos.scored, ...neg.scored];
  if (cases.length === 0) { console.error("p88: no host resolved to Gaia -- nothing to score."); process.exitCode = 1; return; }

  const metrics = vetoMetrics(cases);
  const verdict = acceptVetoTool(cases, { targetPower: 0.5, chanceFloor: 0.5, maxFalseVetoes: 0 });
  const nData = scored.filter((s) => s.hasGaiaData).length;
  const nMatched = scored.filter((s) => s.periodMatched).length;

  const out = {
    schema: "sdr-p88-independent-corroboration/1",
    generatedAt: new Date().toISOString(),
    instrument: "Gaia DR3 TAP (independent of TESS): vari_epoch_radial_velocity + nss_two_body_orbit + gaia_source flags",
    labelSource: "ExoFOP-TESS public TOI table (token-free): KP positives, FP/EB negatives",
    population: { positives: pos.scored.length, negatives: neg.scored.length, withGaiaData: nData, periodMatched: nMatched },
    metrics,
    verdict: { safeToGate: verdict.safeToGate, reason: verdict.reason, auc: verdict.auc },
    falseVeto: metrics.cm.falseVeto, // the disqualifying number
    discoveryClaim: false,
    cases: scored,
  };
  const md = [
    "# P88 first true-veto 2x2 from an INDEPENDENT instrument (Gaia RV / astrometry)",
    "",
    `Reproduce: \`npm run p88:independent-corroboration -- --pos ${posN} --neg ${negN} --tmag ${tmag}\``,
    "",
    `Gaia (a different satellite) is asked, for ${pos.scored.length} confirmed planets (must keep) and ${neg.scored.length} labelled FP/EB blends (should veto): does its two-body orbit / RV series independently corroborate a stellar-mass companion on the candidate's period?`,
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
