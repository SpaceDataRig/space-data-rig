// BENCHMARK CORE STATISTICS: faithful, self-contained reimplementations of the headline statistic of the three
// established transit-validation tools the external audit told us to benchmark against -- TCE (BLS detection),
// DAVE / TRICERATOPS (blend false-positive probability), and TPM (Burke 2015 completeness probability model).
//
// WHY PURE FUNCTIONS HERE. We cannot run those projects' full production pipelines (they need Kepler/TESS
// space-to-ground tables, PSF subroutines, and their own calibration). What we CAN do honestly is reimplement the
// CORE, closed-form statistic each one is known for, validate it offline (monotonicity + hand-checkable limits),
// then feed it the SAME real numbers our own pipeline measures (from reports/p47, p78, p74/p77) so the comparison
// is quantitative on shared data -- NOT a quote of their papers on different instruments. Every constant with a
// literature origin is labelled; every assumption is stated. Research only: never imported by the runtime, so no
// bundle hash / verdict / money path changes.

// ------------------------------------------------------------------ TCE: BLS detection SNR + acceptance
export interface BlsSnrInput {
  depthPpm: number;
  periodDays: number;
  durationHours: number;
  cadenceMin: number; // 2.0 for TESS SPOC, 20.0 for FFI
  baselineDays: number; // total time span of the curve
  noisePpm: number; // per-point photometric scatter
}

export interface BlsSnr {
  nTransits: number;
  inTransitPoints: number;
  snr: number; // BLS box-least-squares SNR: (depth/noise) * sqrt(#in-transit points)
}

/**
 * First-order BLS signal-to-noise. For a box transit, folding N_tr transits each contributing n_p in-transit
 * samples gives SNR = (depth/noise) * sqrt(N_tr * n_p) -- the quantity TCE thresholds on (its BLS_DETHRESH=40 is
 * this SNR scaled by sqrt(#bins)). Deterministic; used both for our completeness model and the TCE comparison.
 */
export function blsTransitSnr(i: BlsSnrInput): BlsSnr {
  const nTransits = Math.floor(i.baselineDays / i.periodDays);
  const pointsPerTransit = Math.max(1, (i.durationHours * 60) / i.cadenceMin);
  const inTransitPoints = nTransits * pointsPerTransit;
  const snr = i.noisePpm > 0 ? (i.depthPpm / i.noisePpm) * Math.sqrt(Math.max(0, inTransitPoints)) : 0;
  return { nTransits, inTransitPoints, snr };
}

/**
 * TCE-style acceptance: at least `minTransits` (TCE uses 3), BLS SNR above `snrThresh` (our production gate is 7),
 * and the depth inside a plausible planet band. Returns why it failed when it does. This is the detection
 * COMPLETENESS predicate, not the shape/eclise vetoes (which need a light curve).
 */
export function tceAccepts(
  i: BlsSnrInput,
  opts: { snrThresh?: number; minTransits?: number; minDepthPpm?: number; maxDepthPpm?: number } = {},
): { accept: boolean; snr: number; nTransits: number; reason: string } {
  const snrThresh = opts.snrThresh ?? 7;
  const minTransits = opts.minTransits ?? 3;
  const minDepth = opts.minDepthPpm ?? 50;
  const maxDepth = opts.maxDepthPpm ?? 20000; // above this it is an EB, not a planet (TCE depth veto analogue)
  const { snr, nTransits } = blsTransitSnr(i);
  if (nTransits < minTransits) return { accept: false, snr, nTransits, reason: `only ${nTransits} transits in ${i.baselineDays}d baseline (< ${minTransits})` };
  if (i.depthPpm < minDepth) return { accept: false, snr, nTransits, reason: `depth ${i.depthPpm}ppm < ${minDepth}` };
  if (i.depthPpm > maxDepth) return { accept: false, snr, nTransits, reason: `depth ${i.depthPpm}ppm > ${maxDepth} (EB regime)` };
  if (snr < snrThresh) return { accept: false, snr, nTransits, reason: `BLS SNR ${snr.toFixed(1)} < ${snrThresh}` };
  return { accept: true, snr, nTransits, reason: "accepted" };
}

/** Smooth detection probability from BLS SNR (logistic centred on the threshold) -- the TCE model completeness. */
export function detectionProbability(snr: number, snrThresh = 7, steepness = 0.8): number {
  if (!Number.isFinite(snr)) return 0;
  return 1 / (1 + Math.exp(-(snr - snrThresh) * steepness));
}

// ------------------------------------------------------------------ DAVE / TRICERATOPS: blended EB false-positive probability
export interface Neighbor {
  contrast: number; // F_neighbor / F_target (flux ratio, > 0)
}

export interface FppInput {
  obsDepthFrac: number; // observed diluted transit depth as a fraction (0..1)
  periodDays: number;
  neighbors: Neighbor[]; // contaminating stars within the photometric aperture
  ebPriorShortPeriod?: number // fraction of stars with a contact EB at P<10d (literature ~ 0.01-0.02)
}

/**
 * First-order blend false-positive probability (the DAVE / TRICERATOPS idea): for each nearby star that could host
 * an eclipsing binary whose diluted eclipse reaches the observed depth, add P(that star has such an EB) x P(a blend
 * at its contrast reproduces this depth). A full eclipse dims the neighbour to ~0, so to reach obsDepthFrac from a
 * neighbour of contrast c we need c >= obsDepthFrac/(1-obsDepthFrac); fainter neighbours contribute 0. The geometric
 * alignment probability of an EB eclipsing at all is folded into the EB prior; this is a defensible estimate, not a
 * calibrated space-to-ground product -- stated so, and used only for relative comparison against our measured FP.
 */
export function daveBlendedFpp(i: FppInput): number {
  const d = i.obsDepthFrac;
  if (!(d > 0 && d < 1) || i.periodDays <= 0) return 0;
  const ebPrior = i.ebPriorShortPeriod ?? 0.015;
  const minContrast = d / (1 - d); // faintest neighbour that could still cause the observed dip if fully eclipsed
  let fpp = 0;
  for (const nb of i.neighbors) {
    if (!(nb.contrast > 0) || nb.contrast < minContrast) continue;
    // deeper (larger) intrinsic eclipse needed as contrast grows past the threshold; weight by how "ordinary"
    // an EB of that depth is: dilution-corrected intrinsic depth delta_nb = d*(1+c)/c, must be <= 1.
    const deltaNb = (d * (1 + nb.contrast)) / nb.contrast;
    if (deltaNb > 1) continue;
    // eclipse-depth plausibility: shallower blends are less likely to mimic a transit (a grazing EB); use deltaNb
    // clipped to [0,1] as a shape factor so a marginal full-eclipse blend is discounted.
    const shapeFactor = Math.min(1, deltaNb * 2);
    fpp += ebPrior * shapeFactor;
  }
  return Math.max(0, Math.min(1, fpp));
}

// ------------------------------------------------------------------ TPM: Burke 2015 completeness probability model
export interface CompletenessPoint {
  periodDays: number;
  depthPpm: number;
  completeness: number; // measured fraction recovered in [0,1]
}

export interface LogisticModel {
  b0: number; // intercept
  bLogP: number; // coefficient on ln(periodDays)
  bLogD: number; // coefficient on ln(depthPpm)
}

/** TPM-style logistic completeness predictor: p = sigmoid(b0 + bLogP*lnP + bLogD*lnDepth). */
export function tpmCompletenessProbability(m: LogisticModel, periodDays: number, depthPpm: number): number {
  if (periodDays <= 0 || depthPpm <= 0) return 0;
  const z = m.b0 + m.bLogP * Math.log(periodDays) + m.bLogD * Math.log(depthPpm);
  return 1 / (1 + Math.exp(-z));
}

/**
 * Fit the logistic above to a set of MEASURED completeness points by gradient descent on log-loss (deterministic,
 * a fixed number of full-batch steps). This is how we get a TPM-style model from OUR OWN data rather than borrowing
 * Burke's Kepler coefficients -- measure-before-claim.
 */
export function fitTpmLogistic(points: CompletenessPoint[]): LogisticModel {
  const pts = points.filter((p) => p.periodDays > 0 && p.depthPpm > 0 && p.completeness > 0 && p.completeness < 1);
  if (!pts.length) return { b0: 0, bLogP: 0, bLogD: 0 };
  const X = pts.map((p) => [1, Math.log(p.periodDays), Math.log(p.depthPpm)] as const);
  const y = pts.map((p) => p.completeness);
  const b: number[] = [0, -0.2, 0.3];
  const lr = 0.5;
  const steps = 4000;
  for (let it = 0; it < steps; it++) {
    const grad = [0, 0, 0];
    for (let n = 0; n < X.length; n++) {
      const z = b[0] * X[n][0] + b[1] * X[n][1] + b[2] * X[n][2];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[n];
      grad[0] += err * X[n][0]; grad[1] += err * X[n][1]; grad[2] += err * X[n][2];
    }
    for (let k = 0; k < 3; k++) b[k] -= (lr * grad[k]) / X.length;
  }
  return { b0: b[0], bLogP: b[1], bLogD: b[2] };
}
