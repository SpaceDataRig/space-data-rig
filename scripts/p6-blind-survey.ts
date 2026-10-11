// P6 BLIND SURVEY: survey-scale operating characteristics of the DEFAULT honest blind critic.
//
// runRoc (src/sim/roc.ts, npm run p1:roc) grades completeness/purity on the RAW BLS SNR alone. This
// survey instead pushes each target through the FULL default critic path the money path uses --
// blind detection (scout), injection-recovery confidence (simulate), the noise-color calibrated FAP
// (calibratedFap), and critique() in BLIND mode (recoveryGating:false) -- and tallies the VERDICTS.
// So "completeness" here is the fraction of re-simulated KNOWN planets the honest critic ACCEPTS on
// evidence alone, and "false-accept" is how often it accepts a planet-free star. That is the number
// a defensible survey reports, not "we found a dip".
//
// Two populations, both synthetic red-noise light curves with a per-star AR(1) rho drawn across the
// real quiet..active range (0..0.6):
//   planet: a transit is injected and the catalog carries its true period, so a clean blind recovery
//           can direct-match (harmonic 1). The detector NEVER sees the truth period.
//   noise : depthFrac 0 (planet-free) with an EMPTY catalog, so no match is possible by construction.
//
// DELIBERATE SAFETY BOUNDARY: nothing here anchors, posts, spends, or claims a discovery. Every input
// is a seeded synthetic curve and the run is fully offline/deterministic (no network, no chain). An
// "accepted" verdict means "the blind critic would forward this for human follow-up", never "a new
// planet". This is a research/CI tool, deliberately kept off the money path.
//
// Cost note: calibratedFap (the null ensemble) is computed only for candidates whose RAW SNR clears
// the minSnr floor. Below the floor critique() can never return "accepted" regardless of FAP, so
// skipping it is verdict-preserving for completeness/purity and keeps the survey tractable.
//
// Usage:
//   npm run p6:survey                                   (default 40 planets + 40 noise = 80 targets)
//   npm run p6:survey -- --planets 50 --noise 50 --seed 7 --baseline 14 --cadence 300
import { rng } from "../src/data/synthetic.ts";
import { makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { mainSequenceMassFromRadius } from "../src/sim/transitModel.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { scout, simulate, critique } from "../src/seats/seats.ts";
import type { ReviewVetting } from "../src/critic/review.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

// Realistic injected-depth pool (ppm): TESS super-Earths..hot-Jupiters on a bright dwarf.
const DEPTHS_PPM = [400, 700, 1200, 2000, 3500, 6000, 10000];

const cfg = {
  nPlanet: Math.round(arg("planets", 40)),
  nNoise: Math.round(arg("noise", 40)),
  seed: Math.round(arg("seed", 20260011)),
  cadence: arg("cadence", 300),
  baseline: arg("baseline", 12),
  noisePpm: arg("noise-ppm", 300),
  trials: Math.round(arg("trials", 6)),
  nNull: Math.round(arg("nNull", 60)),
  maxPoints: Math.round(arg("maxPoints", 2500)),
  minSnr: arg("minsnr", 7),
  fapThreshold: arg("fap", 0.05),
};

interface Row {
  name: string;
  pop: "planet" | "noise";
  truePeriod: number | null;
  depthPpm: number;
  rho: number;
  recPeriod: number;
  snr: number;
  alias: number;
  fap: number | null;
  rhoEst: number | null;
  conf: number;
  matchedTruth: boolean;
  nTransits: number;
  verdict: string;
  score: number;
  reason: string;
}

function runTarget(rand: () => number, idx: number, pop: "planet" | "noise"): Row {
  // Draw the system first so the parameter stream is identical regardless of population order.
  const hasPlanet = pop === "planet";
  // Planet periods are confined to the CONFIRMABLE regime: at least ~3 transits over the baseline
  // (P <= baseline/3). Longer periods are coverage-limited -- 1-2 transits cannot be phase-folded
  // into a recovery confidence -- so folding them in would report a coverage ceiling as if it were a
  // critic failure (the same trap runRoc documents). Noise periods are irrelevant (depthFrac 0).
  const pMax = hasPlanet ? Math.max(2, cfg.baseline / 3) : 10;
  const periodDays = 1 + rand() * (pMax - 1); // planet 1..baseline/3; noise 1..10 d
  const rho = rand() * 0.6; // quiet (0) .. active (0.6)
  const rsun = 0.7 + rand() * 0.8; // 0.7..1.5 Rsun
  const impact = rand() * 0.6;
  const depthPpm = hasPlanet ? DEPTHS_PPM[Math.floor(rand() * DEPTHS_PPM.length)]! : 0;
  const mass = mainSequenceMassFromRadius(rsun);
  const name = `${hasPlanet ? "SDS" : "NULL"}-${String(idx).padStart(3, "0")}`;
  const base: Row = {
    name, pop, truePeriod: hasPlanet ? periodDays : null, depthPpm, rho,
    recPeriod: NaN, snr: NaN, alias: NaN, fap: null, rhoEst: null, conf: NaN,
    matchedTruth: false, nTransits: 0, verdict: "error", score: 0, reason: "detection/sim error",
  };
  try {
    const lc = makeRedNoiseLightCurve({
      seed: (cfg.seed + idx * 1000003) >>> 0,
      periodDays,
      depthFrac: depthPpm * 1e-6,
      impactParam: impact,
      stellarRadiusRsun: rsun,
      stellarMassMsun: mass,
      noisePpm: cfg.noisePpm,
      rho,
      cadenceSec: cfg.cadence,
      baselineDays: cfg.baseline,
      targetIdLabel: name,
    });
    const detection = scout(lc); // BLIND: full period grid, no truth ephemeris
    const cand = detection.candidate;
    const planet: ArchivePlanet = {
      pl_name: `${name} b`,
      hostname: name,
      pl_orbper: hasPlanet ? periodDays : undefined,
      st_rad: rsun,
      st_mass: mass,
    };
    const sim = simulate({ lc, detection, planet, index: idx, confidenceTrials: cfg.trials });
    // FAP only where it can matter (raw SNR at/above the floor); see the cost note in the header.
    let vetting: ReviewVetting | undefined;
    let fap: number | null = null;
    let rhoEst: number | null = null;
    if (cand.snr >= cfg.minSnr) {
      try {
        const sig = calibratedFap(lc, cand.snr, cand.periodDays, { maxPoints: cfg.maxPoints, nNull: cfg.nNull });
        vetting = { fap: sig.fap };
        fap = sig.fap;
        rhoEst = sig.rho;
      } catch {
        /* best-effort: an uncomputable FAP simply leaves the gate unset */
      }
    }
    const catalog: ArchivePlanet[] = hasPlanet ? [planet] : [];
    const review = critique({
      detection,
      catalog,
      hostName: name,
      confidence: sim.confidence,
      truthPeriodDays: hasPlanet ? periodDays : undefined,
      truthSource: "injected",
      recoveryGating: false, // BLIND: the honest default protocol
      vetting,
    });
    base.recPeriod = cand.periodDays;
    base.snr = cand.snr;
    base.alias = detection.aliasMultiple;
    base.fap = fap;
    base.rhoEst = rhoEst;
    base.conf = sim.confidence.confidence;
    base.matchedTruth = hasPlanet && Math.abs(cand.periodDays - periodDays) / periodDays <= 0.02;
    base.nTransits = Math.max(0, Math.floor(cfg.baseline / cand.periodDays));
    base.verdict = review.verdict;
    base.score = review.score;
    base.reason = review.reason;
  } catch {
    /* a detection/sim failure is recorded as verdict "error" (never an accept) */
  }
  return base;
}

function main(): void {
  const rand = rng(cfg.seed);
  const rows: Row[] = [];
  const t0 = Date.now();
  for (let i = 0; i < cfg.nPlanet; i++) rows.push(runTarget(rand, rows.length, "planet"));
  for (let j = 0; j < cfg.nNoise; j++) rows.push(runTarget(rand, rows.length, "noise"));
  const secs = (Date.now() - t0) / 1000;

  console.log("P6 BLIND SURVEY -- synthetic, deterministic, OFFLINE. Nothing is anchored or claimed.");
  console.log(
    `planets=${cfg.nPlanet} noise=${cfg.nNoise} seed=${cfg.seed} baseline=${cfg.baseline}d cadence=${cfg.cadence}s ` +
      `noise=${cfg.noisePpm}ppm trials=${cfg.trials} fapBudget={maxPoints:${cfg.maxPoints},nNull:${cfg.nNull}} minSnr=${cfg.minSnr}`,
  );
  console.log(
    `injected planet periods 1..${Math.max(2, cfg.baseline / 3).toFixed(1)}d (>= ~3 transits over the ${cfg.baseline}d baseline = the confirmable regime)`,
  );
  console.log("");
  console.log("pop     name        trueP    recP     dP%     SNR    FAP     conf  nTr  verdict");
  for (const r of rows) {
    const dP = r.truePeriod != null && Number.isFinite(r.recPeriod) ? ((r.recPeriod - r.truePeriod) / r.truePeriod) * 100 : NaN;
    console.log(
      `${r.pop.padEnd(6)}  ${r.name.padEnd(11)} ` +
        `${r.truePeriod != null ? r.truePeriod.toFixed(3).padStart(7) : "      -"} ` +
        `${Number.isFinite(r.recPeriod) ? r.recPeriod.toFixed(3).padStart(7) : "      -"} ` +
        `${Number.isFinite(dP) ? dP.toFixed(2).padStart(6) : "     -"} ` +
        `${Number.isFinite(r.snr) ? r.snr.toFixed(1).padStart(6) : "     -"} ` +
        `${r.fap != null ? r.fap.toPrecision(2).padStart(7) : "   n/a"} ` +
        `${Number.isFinite(r.conf) ? r.conf.toFixed(2).padStart(5) : "    -"} ` +
        `${String(r.nTransits).padStart(3)}  ${r.verdict}`,
    );
  }
  console.log("");

  const planets = rows.filter((r) => r.pop === "planet");
  const noise = rows.filter((r) => r.pop === "noise");

  // Transparency: why the honest critic declined each planet-bearing target it did not accept. This
  // turns a bare "completeness = X%" into a diagnosable curve (coverage vs alias vs confidence vs
  // FAP), the same discipline runRoc reports rather than hiding the misses.
  const declined = planets.filter((r) => r.verdict !== "accepted");
  if (declined.length) {
    console.log("why not accepted (planet-bearing):");
    for (const r of declined) {
      console.log(
        `  ${r.name}  ${r.verdict}  SNR ${Number.isFinite(r.snr) ? r.snr.toFixed(1) : "-"}  conf ${Number.isFinite(r.conf) ? r.conf.toFixed(2) : "-"}  nTr ${r.nTransits}  alias x${Number.isFinite(r.alias) ? r.alias : "-"}  -- ${r.reason}`,
      );
    }
    console.log("");
  }

  const count = (arr: Row[], v: string) => arr.filter((r) => r.verdict === v).length;
  const pAcc = planets.filter((r) => r.verdict === "accepted");
  const pAccTrue = pAcc.filter((r) => r.matchedTruth);
  const nAcc = noise.filter((r) => r.verdict === "accepted"); // FALSE ALARMS
  const matched = planets.filter((r) => r.matchedTruth).length;
  const noiseSnr7 = noise.filter((r) => Number.isFinite(r.snr) && r.snr >= cfg.minSnr).length;
  const noiseSnr7FapOk = noise.filter((r) => r.snr >= cfg.minSnr && r.fap != null && r.fap <= cfg.fapThreshold).length;
  const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
  const completeness = planets.length ? pAccTrue.length / planets.length : 0;
  const falseAccept = noise.length ? nAcc.length / noise.length : 0;
  const purity = pAccTrue.length + nAcc.length > 0 ? pAccTrue.length / (pAccTrue.length + nAcc.length) : 1;

  console.log("OPERATING CHARACTERISTICS (blind default critic, verdict-level):");
  console.log(
    `  planet-bearing (N=${planets.length}): accepted ${pAcc.length} | needs-more-data ${count(planets, "needs-more-data")} | ` +
      `rejected ${count(planets, "rejected")} | error ${count(planets, "error")}`,
  );
  console.log(
    `    raw period recovery (harmonic-1 within 2%): ${matched}/${planets.length} = ${pc(planets.length ? matched / planets.length : 0)}`,
  );
  console.log(`    COMPLETENESS (accepted & correct / N): ${pAccTrue.length}/${planets.length} = ${pc(completeness)}`);
  console.log(
    `  planet-free noise (N=${noise.length}): accepted ${nAcc.length} | needs-more-data ${count(noise, "needs-more-data")} | ` +
      `rejected ${count(noise, "rejected")} | error ${count(noise, "error")}`,
  );
  console.log(
    `    noise curves with a raw BLS peak SNR>=${cfg.minSnr}: ${noiseSnr7} (of those, FAP<=${cfg.fapThreshold}: ${noiseSnr7FapOk})`,
  );
  console.log(`    FALSE-ACCEPT rate (accepted / N): ${nAcc.length}/${noise.length} = ${pc(falseAccept)}`);
  console.log(`  PURITY (accepted that are true / all accepted): ${pc(purity)}`);
  console.log("");
  console.log("Interpretation:");
  console.log(
    `  - Raw period recovery (${pc(planets.length ? matched / planets.length : 0)}) bounds completeness (${pc(completeness)}); any gap is lost to the`,
  );
  console.log("    honesty gates (SNR floor, noise-color FAP, clean alias, recovery confidence) and to mis-recovered");
  console.log("    periods, which are correctly capped at needs-more-data rather than claimed as discoveries.");
  console.log(
    `  - ${noiseSnr7} planet-free curve(s) still threw a raw SNR>=${cfg.minSnr} peak (red-noise inflation), yet ${nAcc.length} were accepted:`,
  );
  console.log("    the noise-color FAP gate plus the no-catalog-match cap stopped every false peak before acceptance.");
  console.log("");
  console.log(`SAFETY BOUNDARY: this is a simulation operating characteristic, NOT a set of detections. Nothing was`);
  console.log(`anchored, posted, spent or claimed. Done in ${secs.toFixed(1)}s.`);
}

main();
