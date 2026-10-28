// P65 - EXTERNAL CANDIDATE AUDIT ENTRY (roadmap "community / external audit: submit a third-party candidate
// -> run the FULL critic + report whether it passes the CURRENT gates", research mode, NOT on-chain).
//
// This is the public-facing PRIMITIVE. Give it a claimed candidate (someone else's planet), and it runs the
// ENTIRE rig on it using only public data: the independent audit (src/review/externalReview.ts -- novelty,
// Gaia dilution/blend, geometry self-consistency, our OWN blind re-detection and its power rank, and a
// detectability floor so a non-detection is honestly attributed to OUR sensitivity) AND the deterministic
// mission-critic with the current gates (src/critic/review.ts), fed a soft blend-likelihood from the audit's
// own Gaia dilution (src/candidate/softScore.ts) and a calibrated FAP. It prints a PASS/FAIL against the
// current gating and writes a report.
//
// HONEST, HARD RED LINES (baked in):
//  - This reviews SOMEONE ELSE'S claim. It is NEVER our discovery (discoveryClaim false everywhere) and NOTHING
//    is anchored / put on-chain / gated onto the money path -- it is a research-mode audit, run and reported.
//  - The critic is run BLIND (catalog = []): a genuine but unconfirmed / external signal hits the honest ceiling
//    "needs-more-data", i.e. it does NOT pass the accepted-only money gate. That is the correct, safe outcome;
//    we never auto-accept or stake an outside candidate.
//  - "Our detector did not rank it first" reflects OUR sensitivity at that cadence (the detectability floor says
//    when we are blind), not a refutation of the claim.
//
// Sample claims reuse the p16 TOI-style external candidates (real published params, no fabrication). Pass your
// own with --claim-file path.json (a CandidateClaim). Run: npm run p65:external-audit [-- --claim-file path.json]

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { reviewCandidate } from "../src/critic/review.ts";
import { blendLikelihood } from "../src/candidate/softScore.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { stitchLightCurves, createSpocSectorFetcher } from "../src/data/mastS3.ts";
import { fetchGaiaBySourceId, fetchGaiaNeighborhood } from "../src/data/gaiaDilution.ts";
import { reviewExternalCandidate, type CandidateClaim, type ReviewDeps } from "../src/review/externalReview.ts";
import type { LightCurve } from "../src/core/types.ts";

const DEFAULT_CLAIMS: CandidateClaim[] = [
  { label: "Aakanksha", tic: 370612437, gaiaSourceId: "1981360227180249088", periodDays: 3.564921, epochBjd: 2458742.1409, depthPpm: 210, t14Hours: 1.44, rpEarth: 1.04, rpOverRs: 0.0144, impactParam: 0.73, sectors: [16, 17, 56, 57, 76, 77, 83, 84] },
  { label: "Orbit", tic: 252721481, gaiaSourceId: "1991778271640247808", periodDays: 4.933533, epochBjd: 2458740.6616, depthPpm: 279, t14Hours: 1.59, rpEarth: 1.1, rpOverRs: 0.0167, impactParam: 0.68, sectors: [16, 17, 57, 77, 84] },
];

async function ticsConfirmed() {
  const r = await fetchConfirmedPlanets({ maxTmag: 14, requireTic: true, limit: 6000 });
  const tics = new Set<number>();
  for (const p of r.planets) if (p.tic != null) tics.add(p.tic);
  return { tics, scanned: r.planets.length, source: r.source };
}
async function ticsToi() {
  const r = await fetchTocCandidates({ excludeConfirmedHosts: false, limit: 20000 });
  const tics = new Set<number>();
  for (const c of r.candidates) if (Number.isFinite(c.tic)) tics.add(c.tic);
  return { tics, scanned: r.candidates.length, source: r.source };
}
const sectorFetcher = createSpocSectorFetcher({ concurrency: 4 });
const deps: ReviewDeps = {
  confirmedTics: ticsConfirmed,
  toiTics: ticsToi,
  gaiaById: (id) => fetchGaiaBySourceId(id),
  gaiaNeighborhood: (ra, dec) => fetchGaiaNeighborhood(ra, dec, { radiusDeg: 21 / 3600 }),
  // concurrent + per-key byte CACHED: the audit and the critic both ask for the same (tic,sectors), so the
  // second call is a cache hit -- no double download, and a slow sector is best-effort-omitted, never a hang.
  lightCurves: (tic, sectors, label) => sectorFetcher.fetchSectors(tic, sectors, label),
  runBls: (lc) => detectTransit(lc).bls,
  calibratedSignificance: (lc, snr, period) => { const s = calibratedFap(lc, snr, period, { maxPoints: 2500, nNull: 60 }); return { fap: s.fap, rho: s.rho }; },
};

interface Outcome {
  label: string; tic: number; corroborated: boolean; novel: boolean; geometryConsistent: boolean;
  blendTier: string; criticVerdict: string; passesCurrentGate: boolean; reason: string; fap: number | null; blendScore: number | null; notes: string[];
}

async function auditOne(claim: CandidateClaim): Promise<Outcome> {
  const rep = await reviewExternalCandidate(claim, deps);
  // run our OWN detector + critic blind on the best curve we can assemble.
  const curves = await deps.lightCurves(claim.tic, claim.sectors, claim.label).catch(() => [] as LightCurve[]);
  const usable = curves.filter((c) => c && c.points.length >= 50);
  const base = usable.length ? usable[0] : null;
  const stitched = usable.length >= 2 ? stitchLightCurves(usable) : null;
  const curve = stitched || base;

  let criticVerdict = "no-data";
  let passesCurrentGate = false;
  let reason = "no light curve via our token-free channel -> critic could not run";
  let fap: number | null = null;
  let blendScore: number | null = null;
  if (curve) {
    const det = detectTransit(curve);
    // SOFT blend-likelihood from the audit's own Gaia dilution (continuous, advisory -- never a hard reject here).
    if (rep.dilution) { const b = blendLikelihood({ dilutionFactor: rep.dilution.dilutionFactor }); if (b.determined) blendScore = b.score; }
    let sigFap: number | undefined;
    try { sigFap = calibratedFap(det.clean, det.candidate.snr, det.candidate.periodDays, { maxPoints: 2500, nNull: 60 }).fap; fap = sigFap; } catch { /* leave undefined */ }
    // BLIND critic: catalog = [] so an unconfirmed / external signal honestly caps at needs-more-data; the soft
    // blend-likelihood only downweights the ranking score, it never flips this. No money path.
    const review = reviewCandidate({
      candidate: det.candidate, aliasMultiple: det.aliasMultiple, catalog: [],
      vetting: { fap: sigFap, ...(blendScore != null ? { blendScore } : {}) },
    });
    criticVerdict = review.verdict;
    reason = review.reason;
    passesCurrentGate = review.verdict === "accepted"; // the accepted-only money gate; a novel claim must fail it
  }
  const novel = !rep.novelty.inConfirmed && !rep.novelty.inToi;
  return {
    label: claim.label, tic: claim.tic, corroborated: rep.corroborated, novel,
    geometryConsistent: rep.geometry.consistent, blendTier: rep.blend ? rep.blend.tier : "n/a",
    criticVerdict, passesCurrentGate, reason, fap, blendScore, notes: rep.notes,
  };
}

const MODE = "RESEARCH -- reviews third-party candidates; never our discovery; NOT anchored / on-chain / money-path";

/** The PURE aggregate: every published figure is a deterministic map over each outcome's enum/boolean critic
 *  fields. The same code path runs whether the outcomes came from a live audit or the frozen fixture, so the
 *  report is re-DERIVED, not copied (the p41/p88/p71 discipline). */
function derive(outcomes: Outcome[]) {
  const passesCurrentGate = outcomes.map((o) => ({ label: o.label, passes: o.passesCurrentGate, verdict: o.criticVerdict }));
  const anyAccepted = outcomes.some((o) => o.passesCurrentGate);
  return { passesCurrentGate, anyAccepted };
}

async function main(): Promise<void> {
  // FROZEN DATA SOURCE -- the p41/p75/p88/p71 precedent, applied here. p65 audits third-party claims against LIVE
  // SPOC photometry + Gaia + the archive; a plain re-run re-fetches and can flip a verdict / move a count (the p90
  // drift lesson). The per-claim critic outcomes are therefore frozen into reports/fixtures/p65-frozen-outcomes.json
  // (a committed snapshot, dated at measurement) and the DEFAULT re-DERIVES every figure OFFLINE from those outcomes.
  // `--live` (or `--from-json=`) is the deliberate re-audit.
  const FROZEN = "reports/fixtures/p65-frozen-outcomes.json";
  const live = process.argv.includes("--live");
  const fromArg = (process.argv.find((a) => a.startsWith("--from-json=")) || "").split("=")[1];
  const REPLAY = live ? "" : (fromArg !== undefined ? fromArg : FROZEN);

  let outcomes: Outcome[];
  let measuredAt: string;
  let nClaims: number;

  if (REPLAY && existsSync(REPLAY)) {
    const j = JSON.parse(readFileSync(REPLAY, "utf8")) as { outcomes: Outcome[]; measuredAt?: string; meta?: { nClaims?: number } };
    outcomes = j.outcomes;
    measuredAt = j.measuredAt ?? "unknown";
    nClaims = j.meta?.nClaims ?? outcomes.length;
    console.log(`P65 EXTERNAL CANDIDATE AUDIT -- OFFLINE REPLAY from ${REPLAY}: ${outcomes.length} stored claim outcome(s), original measurement ${measuredAt}. No network, no re-audit. NOT our discovery; nothing anchored.`);
  } else {
    let claims = DEFAULT_CLAIMS;
    const cf = (process.argv.find((a) => a.startsWith("--claim-file=")) || "").split("=")[1];
    if (cf && existsSync(cf)) { try { const parsed = JSON.parse(readFileSync(cf, "utf8")); claims = Array.isArray(parsed) ? parsed : [parsed]; } catch (e) { console.error(`[p65] --claim-file parse failed: ${e instanceof Error ? e.message : e}; using defaults`); } }
    console.log(`P65 EXTERNAL CANDIDATE AUDIT (research mode, NOT on-chain). Reviews ${claims.length} third-party candidate(s) -- NOT our discovery; nothing anchored or gated.`);
    const live0: Outcome[] = [];
    for (const c of claims) {
      const o = await auditOne(c);
      live0.push(o);
      console.log(`\n---- ${o.label} (TIC ${o.tic}) ----`);
      console.log(`  corroborated by our blind detector: ${o.corroborated ? "YES" : "NO (our sensitivity -- see detectability floor in the report)"}`);
      console.log(`  novel (not in confirmed/TOI)? ${o.novel} | geometry consistent: ${o.geometryConsistent} | blend/EB tier: ${o.blendTier}${o.blendScore != null ? ` (soft blend-likelihood ${o.blendScore.toFixed(2)})` : ""}`);
      console.log(`  critic verdict: ${o.criticVerdict}${o.fap != null ? ` (calibrated FAP ${o.fap.toFixed(3)})` : ""}`);
      console.log(`  PASSES current accepted-only gate? ${o.passesCurrentGate ? "YES" : "NO"} -> ${o.reason}`);
      if (o.notes.length) console.log(`  notes: ${o.notes.join("; ")}`);
    }
    outcomes = live0;
    measuredAt = new Date().toISOString();
    nClaims = claims.length;
  }

  const d = derive(outcomes);
  console.log(`\n=== P65 SUMMARY ===`);
  console.log(`  ${outcomes.filter((o) => o.passesCurrentGate).length}/${outcomes.length} external claims pass the accepted-only gate; ${outcomes.filter((o) => o.criticVerdict === "needs-more-data").length} cap at needs-more-data (the honest ceiling for an unconfirmed / external signal).`);
  console.log(`VERDICT: ${d.anyAccepted ? "SOME-PASS (a claim met the strict blind acceptance on evidence -- still NOT auto-anchored here; that is a separate money-path decision this research entry never takes)" : "NONE-PASS (no external claim cleared the accepted-only blind gate here; correct and expected -- an outside candidate is flagged for follow-up, never auto-claimed or staked)"}; discoveryClaim false, nothing anchored.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      // Replay stamps the SCRIPT + the FROZEN outcomes (both tracked -> a clean checkout re-hashes them -> verified), NOT
      // the audit/critic/Gaia/SPOC modules, so an upstream data or detector update cannot mark this cited report stale
      // and force a drift-inducing re-audit; `--live` stamps the modules because there they really produced the outcome.
      ...buildStamp(REPLAY
        ? ["scripts/p65-external-candidate-audit.ts", FROZEN]
        : ["src/review/externalReview.ts", "src/critic/review.ts", "src/candidate/softScore.ts", "src/data/gaiaDilution.ts", "src/data/mastS3.ts", "src/data/exoplanetArchive.ts", "src/data/toiArchive.ts", "src/detect/pipeline.ts", "src/detect/significance.ts", "scripts/p65-external-candidate-audit.ts"]),
      generatedBy: "scripts/p65-external-candidate-audit.ts", mode: MODE, nClaims,
      measuredAt,
      data: REPLAY
        ? "FROZEN snapshot of the per-claim BLIND-critic audit outcomes, replayed offline -- the live audit as measured, not re-fetched"
        : "real TESS-SPOC + Gaia public channels (token-free), re-audited live",
    },
    outcomes,
    passesCurrentGate: d.passesCurrentGate,
    discoveryClaim: false,
    anchored: false,
    safeToGate: false,
  };
  writeFileSync("reports/p65-external-audit.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P65 external-candidate audit: submit a third-party claim, run the full critic + gates, report pass/fail",
    "",
    "Reproduce: `npm run p65:external-audit` (or `-- --claim-file yourClaim.json` with a CandidateClaim).",
    "",
    REPLAY
      ? `OFFLINE REPLAY: figures re-DERIVED from \`reports/fixtures/p65-frozen-outcomes.json\` (a committed snapshot of the live audit outcomes, taken ${measuredAt}); \`--live\` re-audits.`
      : `LIVE re-audit: third-party claims run through the independent audit + blind critic at run time (${measuredAt}).`,
    "",
    "This is the community / external audit ENTRY (research mode, NOT on-chain): it runs the independent audit",
    "(novelty, Gaia dilution/blend, geometry, our OWN blind re-detection + power rank, a detectability floor) AND",
    "the deterministic mission-critic with the current gates, fed a continuous soft blend-likelihood + calibrated",
    "FAP. It reports whether the claim passes the accepted-only money gate -- without ever anchoring or claiming.",
    "",
    "| claim | corroborated | novel | geometry | blend tier | soft score | FAP | critic verdict | passes gate |",
    "|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.label} | ${o.corroborated} | ${o.novel} | ${o.geometryConsistent} | ${o.blendTier} | ${o.blendScore == null ? "-" : o.blendScore.toFixed(2)} | ${o.fap == null ? "-" : o.fap.toFixed(3)} | ${o.criticVerdict} | ${o.passesCurrentGate} |`),
    "",
    `Result: ${outcomes.filter((o) => o.passesCurrentGate).length}/${outcomes.length} pass the accepted-only gate. A novel /`,
    "unconfirmed external claim honestly caps at needs-more-data -- the critic runs BLIND (catalog = []) so we never",
    "auto-accept or stake an outside candidate. A non-detection by our detector reflects our sensitivity (the",
    "detectability floor), not a refutation. This entry NEVER writes a verdict to the money path, anchors, or",
    "claims a discovery (discoveryClaim false, anchored false, safeToGate false).",
    "",
  ].join("\n");
  writeFileSync("reports/p65-external-audit.md", md);
  console.log("\nwrote reports/p65-external-audit.md and reports/p65-external-audit.json");
}

main().catch((e) => { console.error(`[p65] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
