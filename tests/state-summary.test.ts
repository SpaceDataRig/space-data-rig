// Audit-12 D4: the summary endpoint exists so a verifier can re-check the published tiles without downloading
// the ~270 KB findings array that external auditors measured failing 40-60% of the time. These tests drive the
// REAL projection function over constructed rows (behavior, not existence) and pin that both runtimes wire it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeState, STATE_SUMMARY_SCHEMA } from "../src/core/state-summary.ts";
import { PUBLIC_STAT_DEFINITIONS } from "../src/core/stats-definitions.ts";

function fakeFinding(id: string, verdict: string, origin: string, solanaTx?: string) {
  return { id, targetId: `TIC-${id}`, verdict, verdictReason: "x", origin, ...(solanaTx ? { solanaTx } : {}) } as never;
}

function fakeState(n = 5): ReturnType<typeof buildState> {
  return buildState(n);
}

function buildState(n: number) {
  const findings: never[] = [];
  for (let i = 0; i < n; i++) {
    findings.push(
      i % 3 === 0 ? fakeFinding(`f${i}`, "accepted", "revalidation", i === 0 ? "sigabc" : undefined)
        : i % 3 === 1 ? fakeFinding(`f${i}`, "rejected", "blind-toi")
        : fakeFinding(`f${i}`, "needs-more-data", "blind-toi"),
    );
  }
  return {
    runId: "run-test",
    codeVersion: "0.1.1",
    activeRun: { running: true } as never,
    seats: [{ name: "reporter", status: "idle", processed: 0 }],
    findings,
    bundles: [{ id: "b1" } as never],
    events: [{ id: "e1" } as never, { id: "e2" } as never],
    stats: { surveyPass: 373, distinctHosts: 103, bundlesAnchored: 0, ledgerAnchored: 20, tasksDone: 95 } as never,
    statDefinitions: PUBLIC_STAT_DEFINITIONS,
  };
}

test("the summary projects populations, passthroughs the stats, and carries no card content", () => {
  const out = summarizeState(fakeState(6) as never, "2026-10-22T00:00:00.000Z");
  assert.equal(out.schema, STATE_SUMMARY_SCHEMA);
  assert.equal(out.discoveryClaim, false);
  assert.equal(out.activeRun.running, true);
  assert.equal(out.stats.surveyPass, 373, "stats pass through untouched -- same numbers the tiles read");
  assert.equal(out.statDefinitions.bundlesAnchored, PUBLIC_STAT_DEFINITIONS.bundlesAnchored, "definitions ride along");
  assert.equal(out.findingsSummary.total, 6);
  assert.deepEqual(out.findingsSummary.byVerdict, { accepted: 2, rejected: 2, "needs-more-data": 2 });
  assert.deepEqual(out.findingsSummary.byOrigin, { revalidation: 2, "blind-toi": 4 });
  assert.equal(out.findingsSummary.withSolanaTx, 1, "exactly the one card carrying a tx is counted, not copied");
  assert.deepEqual(out.counts, { seats: 1, bundles: 1, events: 2 });
  assert.ok(!("findings" in out), "no findings array may leak into the summary");
  assert.ok(!JSON.stringify(out).includes("verdictReason"), "no per-card internals may leak either");
});

test("the summary is transport-small against the full payload it replaces", () => {
  const heavy = fakeState(103);
  for (const f of heavy.findings as unknown as Array<Record<string, unknown>>) {
    f.candidate = { periodDays: 3.1, epochBjd: 2458000.5, depthPpm: 1200, snr: 12, filler: "x".repeat(2000) };
  }
  const big = JSON.stringify(heavy).length;
  const sum = JSON.stringify(summarizeState(heavy as never, "2026-10-22T00:00:00.000Z")).length;
  assert.ok(big > 200_000, `fixture should resemble the ~324 KB production payload (got ${big})`);
  assert.ok(sum < 8_000, `summary must stay small enough to fetch reliably (got ${sum})`);
  assert.ok(sum < big / 25, "and orders of magnitude below what the auditors could not reliably download");
});

test("both runtimes wire the same projection (edge/node parity, not a forked summary)", () => {
  const worker = readFileSync("src/cf/worker.ts", "utf8");
  const node = readFileSync("src/api/server.ts", "utf8");
  for (const [name, src] of [["worker", worker], ["server", node]] as const) {
    assert.match(src, /import \{ summarizeState \} from "\.\.\/core\/state-summary\.ts"/, `${name} must import the shared projection`);
    assert.match(src, /app\.get\("\/api\/state\/summary"/, `${name} must serve the summary route`);
    assert.match(src, /summarizeState\(/, `${name} must call it`);
  }
});
