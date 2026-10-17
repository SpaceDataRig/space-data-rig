// P89 -- MULTI-EPOCH PSF DIFF-IMAGING, SCORED AS A REAL 2x2 (discovery roadmap M2).
//
// WHY. P53 calibrated the PSF-model double-difference localizer on a POSITIVE-only set (confirmed planets): it
// drove the naive veto's false-kill from 6/16 down to 1/16, but with no negative class it could only show "safe",
// never "useful" -- veto POWER (how often it catches a real off-target blend) is unmeasurable on positives alone.
// P58 added a labelled negative class but at 36 cases, and each target was localized in a SINGLE sector. This does
// both properly: a much larger labelled population (ExoFOP KP positives + FP/EB negatives, now on CORRECT host
// coordinates -- the RA-hours bug fixed in d306ce6 was corrupting every positional census before it), and MULTI-EPOCH
// diff imaging -- we localize each target in up to N covering sectors and treat the target as caught if ANY epoch
// places the transit flux off the host. Longer/independent baselines and per-epoch confirmation are exactly the
// discriminating power the single-sector P58 veto lacked.
//
// THE 2x2. Positive = confirmed planet (transits its host): every "off-target" is a FALSE veto and disqualifies.
// Negative = community FP/EB: an off-target localization is the true catch. The scorer is the repo's standard
// vetoAcceptance 2x2 (Wilson CI on veto power + a chance floor). safeToGate requires ZERO false vetoes AND power
// significantly above chance. Honest negative results (weak power) are reported as such, never gated.
//
// Research-only: not imported by the worker; no verdict / bundle hash / money path; discoveryClaim stays false.
// NETWORK read-only, run locally (CI has no network), like p53/p58. Bounded by default; --pos/--neg/--max-sectors.
//   npm run p89:multiepoch-di -- --pos 12 --neg 16 --max-sectors 3 --tmag 13 --boot 80
import { writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { fetchToiTable, confirmedPositives, labelledNegatives, type ToiRecord } from "../src/data/toiDispositions.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { localizePsfDiff, judgePsfDiff } from "../src/detect/psfDiffImaging.ts";
import { localizeTransitSource } from "../src/detect/diffImaging.ts";
import { vetoMetrics, acceptVetoTool, type VetoCase } from "../src/candidate/vetoAcceptance.ts";

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) { const v = Number(hit.split("=")[1]); if (Number.isFinite(v)) return v; }
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

const POS_N = Math.max(1, Math.round(argNum("pos", 12)));
const NEG_N = Math.max(1, Math.round(argNum("neg", 16)));
const MAX_SECTORS = Math.max(1, Math.round(argNum("max-sectors", 3)));
const TMAG = argNum("tmag", 13);
const BOOT = Math.max(1, Math.round(argNum("boot", 80)));
const PHASES = Math.max(1, Math.round(argNum("phases", 16)));
const ARCSEC_VETO = argNum("arcsec", 2.0);
const MIN_AMP_SNR = argNum("ampsnr", 5);
const MIN_DELTA_CHI2 = argNum("dchi2", 9);

interface Diag { offsetArcsec: number; deltaChi2: number; ampSnr: number; classified: string; sector: number; phaseFrac: number; }

// Localize at one candidate phase. A cheap bootstrap is used while sweeping phases (we only need the
// drop SNR to rank them); the full bootstrap runs once on the chosen phase.
function evalAtPhase(cube: Parameters<typeof localizePsfDiff>[0], t0: number, P: number, dur: number, b: number) {
  return { psf: localizePsfDiff(cube, t0, P, dur, { bootstraps: b, seed: 4242 }), naive: localizeTransitSource(cube, t0, P, dur, { bootstraps: Math.min(b, 40), seed: 4242 }) };
}

/** A labelled case is usable only if it has a real ephemeris (period + epoch + duration) and a TIC + position. */
function usable(r: ToiRecord): boolean {
  return Number.isFinite(r.tic) && r.tic > 0 && Number.isFinite(r.ra) && Number.isFinite(r.dec) &&
    Number.isFinite(r.periodDays) && r.periodDays > 0 &&
    Number.isFinite(r.epochBjd) && r.epochBjd > 2450000 && r.epochBjd < 2470000 &&
    Number.isFinite(r.durationHours) && r.durationHours > 0;
}

/** Localize one target across up to MAX_SECTORS covering SPOC sectors. In EACH epoch we phase-sweep one
 *  period (cheap) to find the strongest real dip, then re-localize at that phase with the full bootstrap --
 *  the same confound-removal that upgraded P57 to P58, now applied per independent epoch. Collects EVERY
 *  measurable epoch (unlike P58, which stopped at the first sector with a cube). */
async function localizeEpochs(rec: ToiRecord): Promise<Diag[]> {
  const out: Diag[] = [];
  const dur = Number.isFinite(rec.durationHours) && rec.durationHours > 0 ? rec.durationHours : 2;
  const sectors = (rec.sectors && rec.sectors.length ? rec.sectors : await sectorsForCoord(rec.ra, rec.dec).catch(() => [] as number[])).slice(0, MAX_SECTORS);
  for (const s of sectors) {
    try {
      const lc = await fetchSpocLightCurve(rec.tic, [s], rec.toi || `TIC ${rec.tic}`);
      if (!lc) continue;
      const cube = await fetchSpocTargetPixels(rec.tic, s, lc.targetId);
      if (!cube) continue;
      // phase sweep (boot 1): pick the phase with the strongest real transit dip (max naive dropSnr).
      let bestFrac = 0; let bestDsnr = -Infinity;
      for (let j = 0; j < PHASES; j++) {
        const frac = j / PHASES;
        const { naive } = evalAtPhase(cube, rec.epochBjd + frac * rec.periodDays, rec.periodDays, dur, 1);
        const dsnr = naive && naive.determined ? naive.dropSnr : -Infinity;
        if (dsnr > bestDsnr) { bestDsnr = dsnr; bestFrac = frac; }
      }
      // full-bootstrap re-localization at the strongest phase.
      const { psf } = evalAtPhase(cube, rec.epochBjd + bestFrac * rec.periodDays, rec.periodDays, dur, BOOT);
      if (!psf || !psf.determined) continue;
      const j = judgePsfDiff(psf, ARCSEC_VETO, { minAmpSnr: MIN_AMP_SNR, minDeltaChi2: MIN_DELTA_CHI2 });
      out.push({ offsetArcsec: psf.offsetArcsec, deltaChi2: psf.deltaChi2, ampSnr: psf.ampSnr, classified: j.classification, sector: s, phaseFrac: bestFrac });
    } catch { /* one bad epoch must not abort the target */ }
    await new Promise((res) => setTimeout(res, 400));
  }
  return out;
}

/** Aggregate per-epoch localizations into one veto case: veto fires if ANY epoch places flux off-target; score = max
 *  offset (strongest blend evidence) so the ROC is monotone in "how displaced the light was". */
async function toCase(rec: ToiRecord, isBlend: boolean): Promise<{ c: VetoCase; diag: Diag[] } | null> {
  const diags = await localizeEpochs(rec);
  if (!diags.length) return null; // no measurable epoch -> not a scored case (never fabricated)
  const veto = diags.some((d) => d.classified === "off-target");
  const score = Math.max(...diags.map((d) => d.offsetArcsec));
  const label = rec.toi || `TIC ${rec.tic}`;
  return { c: { id: `${label}:${isBlend ? "eb" : "kp"}`, isBlend, veto, score }, diag: diags };
}

async function runPool(list: ToiRecord[], isBlend: boolean): Promise<{ cases: VetoCase[]; detail: { label: string; isBlend: boolean; veto: boolean; maxOff: number; epochs: number; off: number }[] }> {
  const cases: VetoCase[] = [];
  const detail: { label: string; isBlend: boolean; veto: boolean; maxOff: number; epochs: number; off: number }[] = [];
  for (const rec of list) {
    const r = await toCase(rec, isBlend).catch(() => null);
    if (!r) { console.error(`p89: ${(rec.toi || "TIC " + rec.tic)} -- no measurable epoch (SPOC cube/PSF)`); continue; }
    const off = r.diag.filter((d) => d.classified === "off-target").length;
    const maxOff = Math.max(...r.diag.map((d) => d.offsetArcsec));
    cases.push(r.c);
    detail.push({ label: rec.toi || `TIC ${rec.tic}`, isBlend, veto: r.c.veto === true, maxOff: +maxOff.toFixed(2), epochs: r.diag.length, off });
    console.error(`p89: ${detail[detail.length - 1].label} ${isBlend ? "NEG(EB/FP)" : "POS(KP)"} epochs=${r.diag.length} off=${off} maxOff=${maxOff.toFixed(2)}" -> ${r.c.veto ? "VETO" : "keep"}`);
  }
  return { cases, detail };
}

function q(sorted: number[], f: number): number { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : NaN; }

async function main(): Promise<void> {
  const all = await fetchToiTable({});
  if (!all.length) { console.error("p89: ExoFOP TOI table unavailable -- ABORT, no fabricated 2x2."); process.exitCode = 1; return; }
  const posPool = confirmedPositives(all).filter((r) => usable(r) && r.tessMag <= TMAG).sort((a, b) => a.tessMag - b.tessMag);
  const negPool = labelledNegatives(all).filter((r) => usable(r) && r.tessMag <= TMAG).sort((a, b) => a.tessMag - b.tessMag);
  console.error(`p89: pools KP=${posPool.length} FP/EB=${negPool.length} (tmag<=${TMAG}); localizing ${POS_N}+${NEG_N} across up to ${MAX_SECTORS} sectors each ...`);
  const pos = await runPool(posPool.slice(0, POS_N), false);
  const neg = await runPool(negPool.slice(0, NEG_N), true);
  const cases = [...pos.cases, ...neg.cases];
  if (!cases.length) { console.error("p89: no target had a measurable multi-epoch PSF localization -- nothing to score."); process.exitCode = 1; return; }

  const metrics = vetoMetrics(cases);
  const verdict = acceptVetoTool(cases, { targetPower: 0.5, chanceFloor: 0.5, maxFalseVetoes: 0 });
  const psfOff = cases.map((c) => c.score ?? 0).sort((a, b) => a - b);

  const out = {
    schema: "sdr-p89-multiepoch-di/1",
    ...buildStamp(["src/data/toiDispositions.ts", "src/detect/psfDiffImaging.ts"]),
    method: `multi-epoch PSF-model double-difference (localizePsfDiff/judgePsfDiff) over up to ${MAX_SECTORS} covering SPOC sectors per target; veto = ANY epoch localized off-target at ${ARCSEC_VETO}"`,
    population: { kpPositives: pos.cases.length, labelledNegatives: neg.cases.length, maxOffsetArcsec: { min: q(psfOff, 0), p50: q(psfOff, 0.5), p90: q(psfOff, 0.9), max: psfOff[psfOff.length - 1] ?? null } },
    metrics, verdict: { safeToGate: verdict.safeToGate, reason: verdict.reason, auc: verdict.auc },
    falseVeto: metrics.cm.falseVeto,
    discoveryClaim: false,
    cases: { positives: pos.detail, negatives: neg.detail },
  };
  const md = [
    "# P89 multi-epoch PSF diff-imaging -- a real veto 2x2 with a labelled negative class",
    "",
    `Reproduce: \`npm run p89:multiepoch-di -- --pos ${POS_N} --neg ${NEG_N} --max-sectors ${MAX_SECTORS} --tmag ${TMAG} --boot ${BOOT}\``,
    "",
    `The PSF double-difference localizer is run for ${pos.cases.length} confirmed planets (must keep) and ${neg.cases.length} community FP/EB blends (should be caught), each across up to ${MAX_SECTORS} covering sectors. A target is vetoed if ANY epoch places the transit flux more than ${ARCSEC_VETO} arcsec off the host with sufficient amplitude/shape significance.`,
    "",
    "| | labelled blend (should veto) | labelled planet (must keep) |",
    "|---|---|---|",
    `| DI localizes off-target | ${metrics.cm.trueVeto} | ${metrics.cm.falseVeto} |`,
    `| DI does not | ${metrics.cm.missedBlend} | ${metrics.cm.trueKeep} |`,
    "",
    `- veto power (blends caught): ${metrics.vetoPower == null ? "n/a" : metrics.vetoPower.toFixed(2) + " " + JSON.stringify(metrics.vetoPowerCI)}`,
    `- false-veto (real planets wrongly killed): ${metrics.cm.falseVeto} of ${metrics.nPlanet} (${metrics.falseVetoRate == null ? "n/a" : metrics.falseVetoRate.toFixed(3)}) -- any > 0 disqualifies`,
    `- AUC (max off-target offset, blend vs planet): ${verdict.auc == null ? "n/a" : verdict.auc.toFixed(3)}`,
    "",
    `**VERDICT: safeToGate = ${verdict.safeToGate}.** ${verdict.reason}`,
    "",
    "Multi-epoch PSF diff imaging is a genuine localization test (does the dip move OFF the host across independent",
    "epochs?), strictly stronger than the single-epoch P58 veto; but it can only fire where a SPOC target-pixel cube",
    "exists and is measurable. research-only; discoveryClaim false; nothing anchored, gated, or deployed.",
  ].join("\n");
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p89-multiepoch-di.json", JSON.stringify(out, null, 2), "utf8");
  writeFileSync("reports/p89-multiepoch-di.md", md + "\n", "utf8");
  console.error(`p89: wrote reports/p89-multiepoch-di.{md,json} | safeToGate=${verdict.safeToGate} | falseVeto=${metrics.cm.falseVeto} | vetoPower=${metrics.vetoPower == null ? "n/a" : metrics.vetoPower.toFixed(2)} | auc=${verdict.auc == null ? "n/a" : verdict.auc.toFixed(3)}`);
}

const invokedDirectly = /p89-multiepoch-di(\.ts)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) main().catch((e) => { console.error(`p89: fatal: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
