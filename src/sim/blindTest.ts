// BLIND-TEST SCORER (validation roadmap, priority 5).
//
// A strict blind test hides the ground truth from the detector: some real light curves get a planet
// injected (recorded in a sealed answer key the detector never sees), the rest are left as-is (null).
// We then run the detector, collect its detections, and score them against the key: how many injected
// planets did it RECOVER (recall/completeness), and of the signals it flagged, how many were REAL
// (precision). This is the honest "do we trust the pipeline's own verdicts when it doesn't know the
// answer" measurement -- distinct from p33 (which reports completeness/purity at the operating point)
// because it frames a formal protocol with a sealed key, a full confusion matrix, Wilson confidence
// intervals on both rates, and the corroboration-capping disposition below.
//
// THE SAFETY METRIC (mirrors the project's blind-verdict decision): a detection is only ACCEPTED if it
// clears a corroboration bar (>= minCorroboration independent sectors). Anything significant but
// uncorroborated is capped as NEEDS-MORE-DATA and never auto-accepted. `falseAccepts` counts accepted
// detections that match NO injected planet -- real planets we would wrongly wave through to the money
// path. A discovery-ready pipeline wants this at 0; we report it, we do not assume it.
//
// PURE + DETERMINISTIC + NO NETWORK. The injection + detection happen in scripts/p49-blind-test.ts;
// this module only scores already-collected truth vs detections. Not imported by the runtime pipeline.

import { wilsonInterval } from "./completenessGrid.ts";

export interface Truth {
  id: string; // curve identifier
  injected: boolean; // true if a planet was planted on this curve (null curve = false)
  periodDays?: number; // the hidden injected period (present when injected)
  depthPpm?: number; // the hidden injected depth
}

export interface Detection {
  id: string; // curve identifier the detection was made on
  periodDays: number;
  depthPpm?: number;
  snr?: number;
  corroboratedSectors?: number; // independent sectors confirming the same ephemeris (default 1)
}

export interface BlindMatchOptions {
  /** relative period window for calling a detection a match to an injected planet (default 0.02). */
  periodTolFrac?: number;
  /** a detection is ACCEPTED only at >= this many independent sectors (default 2). Set 1 to disable capping. */
  minCorroboration?: number;
}

export interface BlindScore {
  nCurves: number;
  nInjected: number;
  nNull: number;
  nDetections: number;
  tp: number; // injected planets recovered
  fn: number; // injected planets missed
  fp: number; // detections matching no injected planet
  tn: number; // null curves with no detection
  recall: number; // tp / nInjected
  recallCI: [number, number];
  precision: number; // tp / (tp + fp)
  precisionCI: [number, number];
  fpPerNullCurve: number; // fp on null curves / nNull
  accepted: number; // detections at >= minCorroboration sectors
  acceptedTp: number; // accepted AND real
  falseAccepts: number; // accepted but NOT real (the safety metric; want 0)
  acceptedPrecision: number; // acceptedTp / accepted
  needsMoreData: number; // significant detections capped for lack of corroboration
  discoveryClaim: false;
}

/** Greedy, deterministic matching: each injected truth claims its closest unused in-tolerance detection. */
function matchDetections(truth: Truth[], detections: Detection[], tol: number): Set<number> {
  const used = new Set<number>();
  const injected = truth.filter((t) => t.injected && t.periodDays != null && t.periodDays > 0);
  for (const t of injected) {
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < detections.length; i++) {
      if (used.has(i) || detections[i].id !== t.id) continue;
      const err = Math.abs(detections[i].periodDays - t.periodDays!) / t.periodDays!;
      if (err <= tol && err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (best >= 0) used.add(best);
  }
  return used;
}

export function scoreBlindTest(
  truth: Truth[],
  detections: Detection[],
  opts: BlindMatchOptions = {},
): BlindScore {
  const tol = opts.periodTolFrac ?? 0.02;
  const minCorr = opts.minCorroboration ?? 2;

  const matched = matchDetections(truth, detections, tol);
  const injectedTruths = truth.filter((t) => t.injected);
  const nullIds = new Set(truth.filter((t) => !t.injected).map((t) => t.id));

  const tp = matched.size;
  const fp = detections.length - matched.size;
  const fn = injectedTruths.length - tp;
  // a true negative is a null curve with NO detection at all (a null curve that raised a detection is
  // a false-positive case, not a clean negative).
  const nullWithDetection = new Set(detections.filter((d) => nullIds.has(d.id)).map((d) => d.id));
  let tn = 0;
  for (const id of nullIds) if (!nullWithDetection.has(id)) tn++;

  // acceptance under the corroboration bar
  let accepted = 0;
  let acceptedTp = 0;
  let needsMoreData = 0;
  let fpOnNull = 0;
  detections.forEach((d, i) => {
    const isTp = matched.has(i);
    if (!isTp && nullIds.has(d.id)) fpOnNull++;
    const corr = d.corroboratedSectors ?? 1;
    if (corr >= minCorr) {
      accepted++;
      if (isTp) acceptedTp++;
    } else {
      needsMoreData++;
    }
  });
  const falseAccepts = accepted - acceptedTp;

  const nInjected = injectedTruths.length;
  const nNull = nullIds.size;
  const recall = nInjected > 0 ? tp / nInjected : NaN;
  const precision = tp + fp > 0 ? tp / (tp + fp) : NaN;

  return {
    nCurves: truth.length,
    nInjected,
    nNull,
    nDetections: detections.length,
    tp,
    fn,
    fp,
    tn,
    recall,
    recallCI: wilsonInterval(tp, nInjected),
    precision,
    precisionCI: wilsonInterval(tp, tp + fp),
    fpPerNullCurve: nNull > 0 ? fpOnNull / nNull : NaN,
    accepted,
    acceptedTp,
    falseAccepts,
    acceptedPrecision: accepted > 0 ? acceptedTp / accepted : NaN,
    needsMoreData,
    discoveryClaim: false,
  };
}
