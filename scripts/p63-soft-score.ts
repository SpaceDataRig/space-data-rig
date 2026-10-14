// P63 - SOFT BLEND-LIKELIHOOD score: publish its false-kill rate on real labelled data, offline (roadmap
// "pixel/veto tools -> continuous soft score, not a hard gate"). This script adds NO new measurement: it
// re-derives `src/candidate/softScore.ts` blend-likelihood from the CONTINUOUS per-test metrics already
// committed in reports/p61-llm-hypothesis.json (the --deep run stored psf-localize offset arcsec and
// gaia-dilution dilution-factor for every labelled target), then scores them on the same ground-truth classes
// (TOI confirmed planets = positives, FP/EB = labelled blends). Deterministic, no network, no new data pulled.
//
// WHY: P57-P59 showed the pixel/dilution tools false-kill known planets, so they must not be a binary veto.
// Turning them into a 0..1 score keeps the information, but the honest price is the false-kill rate -- and we
// publish it here at a threshold sweep. The verdict is ALWAYS advisory: a soft score informs ranking, it does
// not gate. safeToGate and discoveryClaim stay structurally false; nothing is wired into a money path.
//
// Run: npm run p63:soft-score   (reads reports/p61-llm-hypothesis.json, writes reports/p63-soft-score.*)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { blendLikelihood, falseVetoAtThreshold, type SoftVetoCase } from "../src/candidate/softScore.ts";

const p61 = JSON.parse(readFileSync("reports/p61-llm-hypothesis.json", "utf8"));
const targets: any[] = p61.targets || [];

interface Scored { name: string; tic: number; isBlend: boolean; score: number; psfOffsetArcsec: number | null; dilutionFactor: number | null; nSignals: number }
const scored: Scored[] = [];
for (const t of targets) {
  const a = t.audit || {};
  const psf = a["psf-localize"];
  const gaia = a["gaia-dilution"];
  const psfOffsetArcsec = psf && psf.determined && Number.isFinite(psf.metric) && psf.metric >= 0 ? (psf.metric as number) : null;
  const dilutionFactor = gaia && gaia.determined && Number.isFinite(gaia.metric) && gaia.metric >= 0 && gaia.metric <= 1 ? (gaia.metric as number) : null;
  if (psfOffsetArcsec == null && dilutionFactor == null) continue; // no continuous pixel/aperture signal -> undetermined
  const r = blendLikelihood({ psfOffsetArcsec: psfOffsetArcsec ?? undefined, dilutionFactor: dilutionFactor ?? undefined });
  if (!r.determined) continue;
  scored.push({ name: t.name, tic: t.tic, isBlend: !!t.isBlend, score: r.score, psfOffsetArcsec, dilutionFactor, nSignals: r.nSignals });
}

if (scored.length < 4) {
  console.log(`only ${scored.length} labelled targets carry a continuous pixel/dilution metric (needs reports/p61-llm-hypothesis.json from a --deep run). VERDICT: INSUFFICIENT-DATA`);
  process.exitCode = 0;
} else {
  const cases: SoftVetoCase[] = scored.map((s) => ({ isBlend: s.isBlend, score: s.score }));
  const nPos = scored.filter((s) => !s.isBlend).length;
  const nNeg = scored.filter((s) => s.isBlend).length;
  const meanScore = (arr: Scored[]) => (arr.length ? arr.reduce((a, x) => a + x.score, 0) / arr.length : NaN);
  const meanPos = meanScore(scored.filter((s) => !s.isBlend));
  const meanNeg = meanScore(scored.filter((s) => s.isBlend));

  const thresholds = [0.25, 0.4, 0.5, 0.6, 0.75];
  const sweep = thresholds.map((thr) => falseVetoAtThreshold(cases, thr));
  const op = sweep.find((s) => s.threshold === 0.5) || sweep[0]; // the operating point we surface

  console.log(`P63 SOFT blend-likelihood on ${scored.length} labelled targets (${nPos} confirmed planets, ${nNeg} labelled blends). Offline re-derivation from reports/p61 continuous metrics; no new data.`);
  console.log(`  mean blend-likelihood: planets ${meanPos.toFixed(2)} vs blends ${meanNeg.toFixed(2)}`);
  console.log(`\n  threshold | false-veto (known planets flagged) | blend catch (95% Wilson CI)`);
  for (const s of sweep) {
    console.log(`      ${s.threshold.toFixed(2)}     |  ${s.falseKills}/${s.nPlanets} = ${(100 * s.falseVetoRate).toFixed(0)}%            |  ${s.caughtBlends}/${s.nBlends} = ${(100 * s.blendCatchRate).toFixed(0)}% [${(100 * s.blendCatchCI[0]).toFixed(0)}, ${(100 * s.blendCatchCI[1]).toFixed(0)}]`);
  }

  // Any non-zero false-veto on KNOWN planets disqualifies a hard gate; the soft score stays advisory regardless.
  const zeroFalseVeto = op.falseKills === 0;
  const verdict =
    `ADVISORY-ONLY: at threshold ${op.threshold}, the continuous blend-likelihood flags ${(100 * op.falseVetoRate).toFixed(0)}% of KNOWN planets (${op.falseKills}/${op.nPlanets}) and catches ${(100 * op.blendCatchRate).toFixed(0)}% of labelled blends.` +
    (zeroFalseVeto ? " Even so it stays a ranking weight, not a veto, because the false-kill rate is not certified at scale." : " A non-zero false-kill rate is exactly why this is a score, not a gate.");
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  the soft score may only DOWNWEIGHT the critic ranking score (src/critic/review.ts blendScore), never flip a verdict; money path untouched; discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p63-soft-score.ts", source: "reports/p61-llm-hypothesis.json continuous metrics (offline re-derivation, no new data)",
      nScored: scored.length, nPositives: nPos, nNegatives: nNeg,
      signals: "blendLikelihood over available per-target psf-localize offset (arcsec) + gaia-dilution factor from the P61 --deep run",
      note: "soft continuous blend-likelihood as an ADVISORY ranking weight; its false-kill rate published here; NOT a gate; nothing anchored or claimed.",
    },
    meanBlendLikelihood: { planets: meanPos, blends: meanNeg },
    operatingPoint: { threshold: op.threshold, falseVetoRate: op.falseVetoRate, falseKills: op.falseKills, nPlanets: op.nPlanets, blendCatchRate: op.blendCatchRate, caughtBlends: op.caughtBlends, nBlends: op.nBlends, blendCatchCI: op.blendCatchCI },
    thresholdSweep: sweep,
    verdict,
    safeToGate: false,
    discoveryClaim: false,
    targets: scored.map((s) => ({ name: s.name, tic: s.tic, isBlend: s.isBlend, blendLikelihood: Number(s.score.toFixed(4)), psfOffsetArcsec: s.psfOffsetArcsec, dilutionFactor: s.dilutionFactor, nSignals: s.nSignals })),
  };
  writeFileSync("reports/p63-soft-score.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P63 soft blend-likelihood score (continuous, not a veto) and its published false-kill rate",
    "",
    "Reproduce: `npm run p63:soft-score` (pure offline re-derivation from reports/p61-llm-hypothesis.json; adds",
    "no new measurement). P57-P59 showed the pixel/dilution tools false-kill known planets, so they are turned",
    "into a continuous 0..1 blend-likelihood (src/candidate/softScore.ts) that the critic may use ONLY as a",
    "bounded ranking weight -- never a gate.",
    "",
    `On **${scored.length}** labelled targets (${nPos} confirmed planets, ${nNeg} labelled blends) with a determined`,
    `continuous signal: mean blend-likelihood ${meanPos.toFixed(2)} (planets) vs ${meanNeg.toFixed(2)} (blends).`,
    "",
    "| threshold | false-veto (known planets flagged) | blend catch [95% Wilson CI] |",
    "|---|---|---|",
    ...sweep.map((s) => `| ${s.threshold.toFixed(2)} | ${s.falseKills}/${s.nPlanets} = ${(100 * s.falseVetoRate).toFixed(0)}% | ${s.caughtBlends}/${s.nBlends} = ${(100 * s.blendCatchRate).toFixed(0)}% [${(100 * s.blendCatchCI[0]).toFixed(0)}, ${(100 * s.blendCatchCI[1]).toFixed(0)}] |`),
    "",
    `**VERDICT: ${json.verdict}**`,
    "",
    "The soft score is wired into the critic as an optional `blendScore` that can only downweight the ranking",
    "score (never flip the verdict or reject), so the money path is untouched. safeToGate false, discoveryClaim",
    "false; nothing here is gated, anchored, or deployed.",
    "",
  ].join("\n");
  writeFileSync("reports/p63-soft-score.md", md);
  console.log("\nwrote reports/p63-soft-score.md and reports/p63-soft-score.json");
}
