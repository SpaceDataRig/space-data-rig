// Shared worker parameter shape for a durable pipeline run.
//
// This is what the Worker (POST /api/run) serializes into a Workflow instance
// and what the RigRunWorkflow consumes. It mirrors the knobs of the Node
// OrchestratorOptions but is deliberately plain-JSON (no functions, no fs paths)
// so it survives the Workers RPC boundary.

export interface RunParams {
  /** Stable run label, e.g. "run-20261010-115859". */
  runId: string;
  /** Number of target stars to process. */
  targets: number;
  /** Injection-recovery trials per candidate (each is its own workflow step). */
  confidenceTrials: number;
  /** NASA catalog brightness cut (TESS magnitude). */
  maxTmag: number;
  /** Pause between seats so the live feed is watchable (ms). */
  stageDelayMs: number;
  /** Use the bundled fallback catalog instead of a live NASA fetch. */
  offline: boolean;
  /** Resume from the last persisted snapshot, skipping completed tasks. */
  resume: boolean;
  /**
   * Autonomous (cron-launched) run: eligible for the budget-gated auto-anchor
   * after each accepted finding. Absent/false for a dashboard POST /api/run, so
   * manual runs keep anchoring strictly manual (spend nothing).
   */
  autonomous?: boolean;
  /**
   * audit-5 (audience-legibility): when true the run ROTATES through a broad real target pool
   * (known planets re-validated + UNCONFIRMED TOI candidates) selected from a persisted survey cursor,
   * so the catalog grows across passes instead of re-running the same brightest handful in place.
   * Absent/false keeps the historical "brightest top-N" selection byte-for-byte -- a dashboard manual
   * run is always predictable, only the autonomous cron sets this.
   */
  rotation?: boolean;
  /** Rotating pool depth: how many confirmed + how many TOI rows to fetch before windowing (default 120/60). */
  pool?: number;
}
