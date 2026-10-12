// OFFLINE CLOSED-LOOP REGRESSION BASELINE (discovery roadmap, Stage 0).
//
// PURPOSE. As we add a full-frame-image discovery path on top of the existing rig, we must not
// silently break the validated closed-loop behaviour that is already trusted and reproduced. This
// module runs the CURRENT 5-seat pipeline fully OFFLINE (bundled fallback catalog, seeded synthetic
// photometry, deterministic seeded PRNG throughout -- no network, no Math.random) over a fixed small
// target set and returns a compact "science digest": per target, the verdict, the critic score, and
// the detected period. A committed golden fixture + a test compare against it, so any change that
// moves a verdict or a recovered period fails CI on purpose -- the change can still be made, but only
// deliberately, by regenerating the baseline and reviewing the diff.
//
// This is Node-side only (uses the filesystem artifact store) and is NOT imported by the worker, so
// it cannot affect any production bundle hash or the money path.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigStore } from "../core/store.ts";
import { Orchestrator } from "./pipeline.ts";
import { getFallbackCatalog } from "../data/exoplanetArchive.ts";
import type { Finding } from "../core/types.ts";

export interface BaselineRow {
  targetId: string;
  verdict: string;
  score: number;
  periodDays: number;
}

function round3(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : NaN;
}

/**
 * Run the pipeline offline over a fixed catalog and return the science digest, sorted by targetId so
 * the ordering is stable regardless of internal scheduling. Writes artifacts to a throwaway temp dir.
 */
export async function runOfflineBaseline(opts: { maxTargets?: number; confidenceTrials?: number } = {}): Promise<BaselineRow[]> {
  const catalog = getFallbackCatalog({ maxTmag: 11, limit: 40, minPeriodDays: 1, maxPeriodDays: 14 });
  const store = new RigStore("baseline-offline");
  const outDir = mkdtempSync(join(tmpdir(), "sdr-baseline-"));
  try {
    const orch = new Orchestrator(store, {
      maxTargets: opts.maxTargets ?? 3,
      confidenceTrials: opts.confidenceTrials ?? 6,
      catalog,
      outDir,
      snapshotPath: join(outDir, "state", "rig.json"),
      useMastS3: false,
      discoverMast: false,
      recoveryGating: false,
    });
    const summary = await orch.run();
    const rows: BaselineRow[] = (summary.findings as Finding[]).map((f) => ({
      targetId: f.targetId,
      verdict: f.verdict,
      score: f.score ?? 0,
      periodDays: round3(f.candidate?.periodDays ?? NaN),
    }));
    rows.sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
    return rows;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Canonical, stable serialization of a digest for golden comparison. */
export function serializeBaseline(rows: BaselineRow[]): string {
  return JSON.stringify(rows, ["targetId", "verdict", "score", "periodDays"], 2) + "\n";
}
