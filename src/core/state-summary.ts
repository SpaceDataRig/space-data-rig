/**
 * AGGREGATE-ONLY PROJECTION of DashboardState for independent verifiers (audit-12 D4).
 *
 * WHY. The full `GET /api/state` is ~324 KB, of which the findings array is ~270 KB. External auditors trying to
 * reproduce the on-chain / gate numbers hit 40-60% fetch failure at the transport layer (5 curl attempts: two
 * 14-37 s successes, one truncated body, one timeout, one reset) before they ever reached a number. A summary
 * that cannot be fetched reliably verifies nothing; so the rig publishes the SAME aggregates a reader needs to
 * re-check the tiles -- counts, populations, definitions, one card-level count of who carries a solanaTx -- with
 * the per-card detail left to `/api/findings` and `/api/bundles/:id/verify-onchain`.
 *
 * PURE. No clock read inside (generatedAt is passed in), no I/O, no gating logic. Nothing here changes the full
 * payload, the money path, or any verdict; it is a projection of rows that already exist.
 */
import type { DashboardState } from "./state-types.ts";

export const STATE_SUMMARY_SCHEMA = "sdr-state-summary/1";

/** Card-level fields we count without copying any card content out of the paginated detail endpoints. */
interface FindingProbe {
  verdict?: string;
  origin?: string;
  solanaTx?: string;
  anchored?: boolean;
}

export function summarizeState(state: DashboardState, generatedAt: string) {
  const byVerdict: Record<string, number> = {};
  const byOrigin: Record<string, number> = {};
  let withSolanaTx = 0;
  for (const f of state.findings as unknown as FindingProbe[]) {
    const v = f.verdict ?? "unknown";
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    const o = f.origin ?? "unknown";
    byOrigin[o] = (byOrigin[o] ?? 0) + 1;
    if (f.solanaTx) withSolanaTx += 1;
  }
  return {
    schema: STATE_SUMMARY_SCHEMA,
    generatedAt,
    note:
      "Aggregate-only projection of GET /api/state (identical stats/statDefinitions populations, findings array " +
      "replaced by these counts). It exists so an independent verifier can re-check the published tiles without " +
      "transferring the ~270 KB card list, which failed to fetch reliably for external auditors (audit-12 D4). " +
      "Per-card provenance remains at /api/findings and /api/bundles/:id/verify-onchain.",
    runId: state.runId,
    codeVersion: state.codeVersion ?? null,
    activeRun: { running: state.activeRun?.running ?? false },
    stats: state.stats,
    statDefinitions: state.statDefinitions,
    findingsSummary: {
      total: state.findings.length,
      byVerdict,
      byOrigin,
      withSolanaTx,
      note:
        "withSolanaTx counts finding cards whose CURRENT bytes carry a landed stamp. It can be 0 while " +
        "stats.ledgerAnchored > 0: science-hash dedup deliberately does not re-commit identical content, and a " +
        "re-derive replaces the timestamped bundle hash -- read stats.bundlesAnchored and its definition, not " +
        "this count, for current-byte coverage.",
    },
    counts: {
      seats: state.seats.length,
      bundles: state.bundles.length,
      events: state.events.length,
    },
    discoveryClaim: false,
  };
}
