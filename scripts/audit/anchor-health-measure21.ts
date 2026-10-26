// Round-21 measure-then-pin: drive the PRODUCTION helpers (labelConflict / dataTierOfHeadline /
// anchorHealth) over the captured live fixtures and print the aggregate, so the test pins measured
// numbers instead of guessed ones. Read-only; touches nothing.
//
// WHY THIS FILE MOVED HERE (round-25 audit). It was written to out/measure21.ts, and `out/` is gitignored -- so the
// CHANGELOG sentence describing it promised a reproducible measurement that no clean checkout could actually run.
// That is the same defect the report-freshness gate exists to catch (computed but not published), pointed at our own
// audit tooling, and the round-24 ledger repeated it for a second measurement script. Any tool a ledger says is kept
// must live on a tracked path; tests/ledger-artifacts-tracked.test.ts now enforces that.
//
// Run from the repo root: npx tsx scripts/audit/anchor-health-measure21.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { labelConflict } from "../../src/core/signal-identity.ts";
import { dataTierOfHeadline } from "../../src/data/dataTier.ts";
import { anchorHealth, type AnchorHealthLedgerRow } from "../../src/core/anchor-health.ts";

/** The subset of a captured catalog row this measurement reads. */
type FindingFx = {
  id: string;
  verdict?: string;
  bundleHash?: string;
  targetId?: string;
  crossmatch?: { knownPlanetName?: string } | null;
  narration?: { headline?: string } | null;
};
type MeasureRow = {
  id: string;
  verdict: string;
  bundleHash: string | undefined;
  labelConflictsWithKnown: boolean;
  labelConflictStatus: string;
  dataTier: string;
};

const load = <T>(f: string): T => JSON.parse(readFileSync(resolve(process.cwd(), "tests", "fixtures", f), "utf8")) as T;

const catalog = load<{ capturedAt?: string; findings: FindingFx[] }>("live-catalog.json");
const ledgerFx = load<{ capturedAt?: string; ledger: AnchorHealthLedgerRow[] }>("live-ledger.json");

const rows: MeasureRow[] = catalog.findings.map((f) => {
  const lc = labelConflict(String(f.targetId ?? ""), f.crossmatch ?? undefined);
  return {
    id: f.id,
    verdict: String(f.verdict ?? ""),
    bundleHash: f.bundleHash,
    labelConflictsWithKnown: lc.conflict,
    labelConflictStatus: lc.status,
    dataTier: dataTierOfHeadline(f.narration?.headline),
  };
});

const rep = anchorHealth(ledgerFx.ledger, rows, "measure");
const { rows: _drop, ...counters } = rep;
const tally = (pick: (r: MeasureRow) => string): Record<string, number> =>
  rows.reduce((m: Record<string, number>, r) => {
    const k = pick(r);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

console.log("fixture ledger rows:", ledgerFx.ledger.length, "capturedAt:", ledgerFx.capturedAt);
console.log("catalog rows:", catalog.findings.length, "capturedAt:", catalog.capturedAt);
console.log("counters:", JSON.stringify(counters));
console.log("status kinds over ALL rows:", JSON.stringify(tally((r) => r.labelConflictStatus)));
console.log("tier over ALL rows:", JSON.stringify(tally((r) => r.dataTier)));
for (const r of rep.rows) console.log("ROW", JSON.stringify(r));
