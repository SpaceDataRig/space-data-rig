// TRUE-VETO 2x2 ACCEPTANCE PROTOCOL (discovery roadmap, priority 0 -- the unblocked half).
//
// THE GAP. A professional reviewer's standard for a VETO tool is not "it did not kill a planet on
// the positives we happen to have" (that is what P44/P45/P51/P53 could measure) but the full 2x2:
// given a MIX of real blends (which the veto SHOULD fire on) and real planets (which it must NOT),
// how many blends does it actually CATCH (veto power) and how many planets does it WRONGLY KILL
// (false-veto)? P52 proved the LABELLED BLENDS are blocked behind an ExoFOP token, so we cannot run
// this on real data yet -- but the SCORER is pure logic and can be built, unit-tested, and made
// ready now, so the moment a labelled negative class exists it is one call, not a new project.
//
// WHAT THIS IS. A runtime-agnostic, deterministic scorer. It takes labelled cases (isBlend: true = a
// real astrophysical false positive that SHOULD be vetoed; false = a real planet that must be kept)
// plus each tool's decision (and optionally a continuous veto score for the ROC), and returns the
// 2x2 confusion matrix, veto power and false-veto rate with Wilson intervals, veto precision, the
// ROC curve + AUC, and an explicit safe-to-gate acceptance verdict. It measures NOTHING itself -- no
// network, no detector -- so it cannot silently over-claim: garbage labels in, honest garbage out.
//
// THE ACCEPTANCE RULE encodes the project's standing bias: a false veto (killing a real planet) is
// worse than a missed one, so a tool is safeToGate only if its observed false-veto count is zero
// (measure-before-gate) AND its veto power clears a target with a confidence interval that excludes
// chance. Pure + offline; not wired into any verdict / bundle hash / money path.

import { wilsonInterval } from "../sim/completenessGrid.ts";

export interface VetoCase {
  /** stable id for reporting (optional). */
  id?: string;
  /** true = a real blend / astrophysical false positive (the veto SHOULD fire); false = a real planet. */
  isBlend: boolean;
  /** the tool's hard decision at its operating point: did it veto (call off-target / blend)? */
  veto: boolean;
  /** optional continuous "blend-ness" score (higher = more confident blend) for the ROC sweep. */
  score?: number;
}

export interface ConfusionMatrix {
  /** veto fired on a real blend -- a correct rejection. */
  trueVeto: number;
  /** veto did NOT fire on a real blend -- a missed false positive. */
  missedBlend: number;
  /** veto fired on a real planet -- the disqualifying false kill. */
  falseVeto: number;
  /** veto did NOT fire on a real planet -- a correct keep. */
  trueKeep: number;
}

export interface VetoMetrics {
  n: number;
  nBlend: number;
  nPlanet: number;
  cm: ConfusionMatrix;
  /** catch rate on blends = trueVeto / (trueVeto + missedBlend) == sensitivity / TPR. */
  vetoPower: number | null;
  vetoPowerCI: [number, number] | null;
  /** over-kill rate on planets = falseVeto / (falseVeto + trueKeep) == FPR. */
  falseVetoRate: number | null;
  falseVetoCI: [number, number] | null;
  /** of the cases the veto killed, how many were really blends = trueVeto / (trueVeto + falseVeto). */
  vetoPrecision: number | null;
}

/** Tally the 2x2 confusion matrix over labelled cases. */
export function confusionMatrix(cases: VetoCase[]): ConfusionMatrix {
  const cm: ConfusionMatrix = { trueVeto: 0, missedBlend: 0, falseVeto: 0, trueKeep: 0 };
  for (const c of cases) {
    if (c.isBlend && c.veto) cm.trueVeto++;
    else if (c.isBlend && !c.veto) cm.missedBlend++;
    else if (!c.isBlend && c.veto) cm.falseVeto++;
    else cm.trueKeep++;
  }
  return cm;
}

/** Compute veto-power / false-veto / precision with Wilson intervals from the confusion matrix. */
export function vetoMetrics(cases: VetoCase[]): VetoMetrics {
  const cm = confusionMatrix(cases);
  const nBlend = cm.trueVeto + cm.missedBlend;
  const nPlanet = cm.falseVeto + cm.trueKeep;
  const powerK = cm.trueVeto;
  const killK = cm.falseVeto;
  const vetoed = cm.trueVeto + cm.falseVeto;
  return {
    n: cases.length,
    nBlend,
    nPlanet,
    cm,
    vetoPower: nBlend > 0 ? powerK / nBlend : null,
    vetoPowerCI: nBlend > 0 ? wilsonInterval(powerK, nBlend) : null,
    falseVetoRate: nPlanet > 0 ? killK / nPlanet : null,
    falseVetoCI: nPlanet > 0 ? wilsonInterval(killK, nPlanet) : null,
    vetoPrecision: vetoed > 0 ? cm.trueVeto / vetoed : null,
  };
}

export interface RocPoint {
  threshold: number;
  tpr: number; // veto power at this threshold
  fpr: number; // false-veto rate at this threshold
}

/**
 * Sweep the continuous score as a veto threshold (veto iff score >= threshold) and emit ROC points
 * (fpr = false-veto rate, tpr = catch rate), sorted by increasing fpr. Cases without a score are
 * ignored. Includes the (0,0) and (1,1) anchors so the curve is complete.
 */
export function rocCurve(scored: VetoCase[]): RocPoint[] {
  const withScore = scored.filter((c) => Number.isFinite(c.score));
  if (withScore.length === 0) return [];
  const thresholds = [...new Set(withScore.map((c) => c.score as number))].sort((a, b) => a - b);
  const pts: RocPoint[] = [];
  for (const thr of thresholds) {
    const cases = withScore.map((c) => ({ isBlend: c.isBlend, veto: (c.score as number) >= thr }));
    const m = vetoMetrics(cases);
    pts.push({ threshold: thr, tpr: m.vetoPower ?? 0, fpr: m.falseVetoRate ?? 0 });
  }
  pts.sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  return [{ threshold: Infinity, tpr: 0, fpr: 0 }, ...pts, { threshold: -Infinity, tpr: 1, fpr: 1 }];
}

/** Trapezoidal AUC over ROC points sorted by fpr. 1.0 = perfect veto, 0.5 = no discrimination. */
export function aucRocCurve(points: RocPoint[]): number {
  if (points.length < 2) return NaN;
  let auc = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].fpr - points[i - 1].fpr;
    const avgY = (points[i].tpr + points[i - 1].tpr) / 2;
    auc += dx * avgY;
  }
  return auc;
}

export interface AcceptanceVerdict {
  /** safe to promote the veto to a hard gate: zero observed false vetoes AND power above target. */
  safeToGate: boolean;
  /** one-line honest summary of why. */
  reason: string;
  metrics: VetoMetrics;
  auc: number | null;
}

/**
 * The acceptance decision. A tool passes ONLY if it killed ZERO real planets (measure-before-gate:
 * any false veto disqualifies) AND its blend catch-rate point estimate meets targetPower with a
 * Wilson lower bound above chanceFloor. `maxFalseVetoes` defaults to 0. This is the reviewer's 2x2
 * standard, codified -- ready to run the instant labelled blends exist.
 */
export function acceptVetoTool(
  cases: VetoCase[],
  opts: { targetPower?: number; chanceFloor?: number; maxFalseVetoes?: number } = {},
): AcceptanceVerdict {
  const targetPower = opts.targetPower ?? 0.5;
  const chanceFloor = opts.chanceFloor ?? 0.5;
  const maxFalseVetoes = opts.maxFalseVetoes ?? 0;
  const metrics = vetoMetrics(cases);
  const auc = cases.some((c) => Number.isFinite(c.score)) ? aucRocCurve(rocCurve(cases)) : null;

  if (metrics.nBlend === 0) {
    return { safeToGate: false, reason: "no labelled blends in the sample -- veto power is unmeasurable (need a negative class)", metrics, auc };
  }
  if (metrics.nPlanet === 0) {
    return { safeToGate: false, reason: "no labelled planets in the sample -- false-veto rate is unmeasurable", metrics, auc };
  }
  const falseVetoes = metrics.cm.falseVeto;
  const power = metrics.vetoPower ?? 0;
  const powerLow = metrics.vetoPowerCI ? metrics.vetoPowerCI[0] : 0;
  if (falseVetoes > maxFalseVetoes) {
    return { safeToGate: false, reason: `${falseVetoes} real planet(s) wrongly vetoed (max ${maxFalseVetoes}) -- measure-before-gate disqualifies the gate`, metrics, auc };
  }
  if (power < targetPower || powerLow <= chanceFloor) {
    return { safeToGate: false, reason: `zero false vetoes but veto power ${power.toFixed(2)} (95% low ${powerLow.toFixed(2)}) is below target ${targetPower} / not above chance ${chanceFloor} -- safe but under-powered`, metrics, auc };
  }
  return { safeToGate: true, reason: `zero false vetoes and veto power ${power.toFixed(2)} (95% low ${powerLow.toFixed(2)} > ${chanceFloor}) meets target ${targetPower}`, metrics, auc };
}
