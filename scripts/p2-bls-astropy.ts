// P2 harness: cross-validate the rig's simplified BLS (src/detect/bls.ts) against the mature
// reference implementation, astropy's BoxLeastSquares.
//
// Two halves:
//   1. TS (ALWAYS runs, no deps): build a few DETERMINISTIC synthetic transits with known truth
//      periods, run OUR bls() on each, and export the exact input arrays, the identical trial
//      grid, our result and the injected truth to out/bls-astropy-fixtures.json. A self-check then
//      asserts our own bls recovered every truth period (this needs no python).
//   2. Python (runs ONLY if python + astropy are present): scripts/bls_astropy_check.py re-runs
//      astropy's BLS on the SAME input over the SAME exported period/duration grid and asserts the
//      two implementations agree on the transit period (tight) and box depth (loose).
//
// If python or astropy is missing, half 2 is SKIPPED as an honest no-op (exit 0) -- this is a
// dev-only convenience, never a build/test gate. Half 1 still writes the fixtures so any machine
// with astropy can run the comparison later. This harness only READS bls(); it lives in scripts/
// (never imported by src/), so it cannot touch the detector, the pipeline, or the bundle hash.
//
// Usage:
//   npm run p2:bls-astropy
//   python scripts/bls_astropy_check.py out/bls-astropy-fixtures.json    (after the above)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSyntheticTransit } from "../src/data/synthetic.ts";
import { bls } from "../src/detect/bls.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outPath = join(repoRoot, "out", "bls-astropy-fixtures.json");
const pyScript = join(here, "bls_astropy_check.py");

// One grid handed to BOTH our bls and (via the exported arrays) astropy, so the two search the
// identical set of trial periods and durations. minPeriodDays 1.0 keeps every trial duration
// (<= 0.5 d) shorter than every trial period, which astropy requires; maxPeriodDays 10 stays below
// every fixture baseline so no trial period exceeds the span of the data.
const GRID = {
  minPeriodDays: 1.0,
  maxPeriodDays: 10,
  oversample: 16,
  minDurationHours: 0.5,
  maxDurationHours: 12,
  nDurations: 12,
};

// Deterministic fixtures: seeded synthetic transits spanning a deep/short, a mid-depth, and a
// red-noise (AR1 rho 0.5) case. All are comfortably recoverable (>= 4 transits, high SNR) so any
// period disagreement points at the ALGORITHM, not at a marginal signal. cadenceSec 300 and
// dutyCycle 1.0 (no gaps) keep the exported arrays small and remove a confounder.
const CASES = [
  { name: "white-deep-short", seed: 101, periodDays: 2.2, depthFrac: 0.01, noisePpm: 200, baselineDays: 12, rho: 0 },
  { name: "white-mid", seed: 202, periodDays: 3.3, depthFrac: 0.003, noisePpm: 150, baselineDays: 14, rho: 0 },
  { name: "red-active", seed: 303, periodDays: 2.75, depthFrac: 0.008, noisePpm: 300, baselineDays: 13, rho: 0.5 },
];

// MUST mirror src/detect/bls.ts logSpace(): the trial durations exported to astropy have to be the
// exact same set our bls searched, or the comparison is not apples-to-apples.
function logSpace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  const out: number[] = [];
  const la = Math.log(a);
  const lb = Math.log(b);
  for (let i = 0; i < n; i++) out.push(Math.exp(la + ((lb - la) * i) / (n - 1)));
  return out;
}

interface FixtureCase {
  name: string;
  targetId: string;
  cadenceSec: number;
  baselineDays: number;
  truth: { periodDays: number; t0Bjd: number; depthFrac: number; durationHours: number };
  input: { time: number[]; flux: number[]; fluxErr: number[] };
  grid: { periods: number[]; durations: number[]; params: typeof GRID };
  ours: {
    periodDays: number;
    epochBjd: number;
    durationDays: number;
    depth: number;
    snr: number;
    power: number;
    nInTransit: number;
  };
}

function buildFixtures(): FixtureCase[] {
  const out: FixtureCase[] = [];
  for (const c of CASES) {
    const { lc, truth } = generateSyntheticTransit({
      seed: c.seed,
      periodDays: c.periodDays,
      depthFrac: c.depthFrac,
      noisePpm: c.noisePpm,
      cadenceSec: 300,
      baselineDays: c.baselineDays,
      rho: c.rho,
      dutyCycle: 1.0,
      targetIdLabel: `BLSXVAL-${c.seed}`,
    });
    const r = bls(lc, GRID);
    const times = lc.points.map((p) => p.time);
    const baseline = Math.max(...times) - Math.min(...times);
    // Same duration set our bls used: log-spaced, then the baseline/2 filter from bls.ts.
    const durations = logSpace(GRID.minDurationHours / 24, GRID.maxDurationHours / 24, GRID.nDurations).filter(
      (d) => d < baseline / 2,
    );
    out.push({
      name: c.name,
      targetId: lc.targetId,
      cadenceSec: lc.cadenceSec ?? 300,
      baselineDays: baseline,
      truth: {
        periodDays: truth.periodDays,
        t0Bjd: truth.t0Bjd,
        depthFrac: truth.depthFrac,
        durationHours: truth.durationHours,
      },
      input: {
        time: times,
        flux: lc.points.map((p) => p.flux),
        fluxErr: lc.points.map((p) => p.fluxErr ?? c.noisePpm * 1e-6),
      },
      // periodGrid holds every trial period our bls actually scored (our best period is in it), so
      // astropy is handed the exact same set rather than a re-derived approximation.
      grid: { periods: r.periodGrid.map((g) => g.period), durations, params: GRID },
      ours: {
        periodDays: r.periodDays,
        epochBjd: r.epochBjd,
        durationDays: r.durationDays,
        depth: r.depth,
        snr: r.snr,
        power: r.power,
        nInTransit: r.nInTransit,
      },
    });
  }
  return out;
}

function findPython(): string | null {
  for (const cmd of ["python", "python3", "py"]) {
    const res = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (!res.error && res.status === 0) return cmd;
  }
  return null;
}

function hasAstropy(py: string): boolean {
  const res = spawnSync(py, ["-c", "import astropy"], { encoding: "utf8" });
  return !res.error && res.status === 0;
}

function main(): number {
  const cases = buildFixtures();
  mkdirSync(dirname(outPath), { recursive: true });
  const doc = {
    schema: "space-data-rig/bls-astropy-fixtures@1",
    generatedBy: "scripts/p2-bls-astropy.ts",
    blsSource: "src/detect/bls.ts",
    note:
      "Deterministic BLS cross-validation fixtures. Each case carries the exact input light curve, " +
      "the identical trial period/duration grid, our bls() result and the injected truth. " +
      "scripts/bls_astropy_check.py re-runs astropy BoxLeastSquares on the same input+grid and " +
      "asserts the two implementations agree.",
    cases,
  };
  writeFileSync(outPath, JSON.stringify(doc));

  // Half-1 self-check (needs no python): our bls must recover each truth period. This alone proves
  // the fixtures are sound; astropy agreement is the bonus half-2.
  console.log("BLS astropy cross-validation harness");
  console.log(`fixtures -> ${relative(repoRoot, outPath)} (${cases.length} case(s))`);
  console.log("");
  // "Recovered" means within about one period-grid step: at oversample 16 a step is ~1.2-1.5%
  // across these baselines, so a 2% gate is the honest resolution limit, not an arbitrary cut.
  console.log("case                  truthP     ourP      dP%    ourDepth   ourSNR  nIn  recovered");
  let selfOk = true;
  for (const c of cases) {
    const dPct = ((c.ours.periodDays - c.truth.periodDays) / c.truth.periodDays) * 100;
    const ok = Math.abs(dPct) <= 2.0;
    if (!ok) selfOk = false;
    console.log(
      `${c.name.padEnd(20)}  ${c.truth.periodDays.toFixed(4).padStart(7)}  ${c.ours.periodDays.toFixed(4).padStart(7)}  ${dPct.toFixed(3).padStart(7)}  ${(c.ours.depth * 1e6).toFixed(0).padStart(7)}ppm ${c.ours.snr.toFixed(1).padStart(7)}  ${String(c.ours.nInTransit).padStart(3)}  ${ok ? "yes" : "NO"}`,
    );
  }
  console.log("");
  if (!selfOk) {
    console.log("HALF-1 FAILED: our own bls missed a truth period by > 2% (one grid step); fixtures unsound.");
    return 1;
  }
  console.log("half-1 OK: our bls recovered every injected period within one grid step (fixtures are sound).");

  const py = findPython();
  if (!py) {
    console.log("");
    console.log("SKIP half-2: no python interpreter found (tried python, python3, py).");
    console.log("  This cross-check is dev-only and a no-op without python; the fixtures above are");
    console.log("  still written, so on any machine with python+astropy you can run:");
    console.log(`    python scripts/bls_astropy_check.py ${relative(repoRoot, outPath)}`);
    return 0;
  }
  if (!hasAstropy(py)) {
    console.log("");
    console.log(`SKIP half-2: ${py} found but astropy is not installed (pip install astropy numpy).`);
    console.log("  No-op: the TS fixtures are still written for a later astropy run.");
    return 0;
  }
  console.log("");
  console.log(`half-2: running astropy cross-check via ${py} ...`);
  const res = spawnSync(py, [pyScript, outPath], { stdio: "inherit" });
  return res.status ?? 1;
}

process.exit(main());
