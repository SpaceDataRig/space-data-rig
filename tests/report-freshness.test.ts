// REPORT FRESHNESS GATE -- offline behaviour drill (audit-6 #2).
//
// The failure class this closes: a report's numbers stay published after the input they were computed from
// changed (the RA-unit fix re-ran the P82 centroid checkpoint, but P84/P85 kept quoting wrong-sky figures,
// and the web/reports P81 page still showed "contradictions (4)" after the repository md said 0). Like the
// live-probe drill, we PROVE THE ALARM RINGS without network by feeding synthetic stamps + an injected hash
// function into the real decision logic that scripts/p86-report-library.ts calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareInputs,
  isProvenanceStale,
  evaluateAgainst,
  stampFromMeta,
  buildStamp,
  type FreshnessStamp,
} from "../scripts/report-freshness.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-17T12:00:00.000Z");

const stamp = (inputs: { path: string; sha256: string | null }[]): FreshnessStamp => ({
  generatedAt: new Date(T0).toISOString(),
  gitSha: "deadbeef",
  inputs,
});

/** A hash function backed by a fixed snapshot of the filesystem: path -> current content hash (null = gone). */
const hashFrom = (fs: Record<string, string | null>) => (path: string): string | null => (path in fs ? fs[path] : null);

test("compareInputs: HARD-STALE when a recorded checkpoint's bytes changed (the centroid re-run case)", () => {
  const r = compareInputs([{ path: "out/scaled/centroid.jsonl", recorded: "aaa", current: "bbb" }]);
  assert.equal(r.hardStale, true);
  assert.match(r.reasons.join(" "), /changed since this report was generated/);
});

test("compareInputs: a recorded input that is simply absent is NOT hard-stale (unverifiable, noted only)", () => {
  const r = compareInputs([{ path: "out/scaled/centroid.jsonl", recorded: "aaa", current: null }]);
  assert.equal(r.hardStale, false);
  assert.match(r.reasons.join(" "), /not present to re-verify/);
});

test("compareInputs: matching hashes stay fresh", () => {
  assert.deepEqual(compareInputs([{ path: "x", recorded: "aaa", current: "aaa" }]), { hardStale: false, reasons: [] });
});

test("isProvenanceStale: a source committed AFTER the report trips the gate; equal/before/unknown do not", () => {
  assert.equal(isProvenanceStale(T0, T0 + DAY), true); // input newer -> stale
  assert.equal(isProvenanceStale(T0, T0 - DAY), false); // input older -> fresh
  assert.equal(isProvenanceStale(T0, T0), false); // strictly newer only
  assert.equal(isProvenanceStale(T0, null), false); // no known input -> never guesses stale
  assert.equal(isProvenanceStale(Number.NaN, T0 + DAY), false); // unknown report time -> do not flag
});

test("evaluateAgainst: stamp with intact inputs is authoritative -- mtime noise cannot override a matching sha", () => {
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const v = evaluateAgainst(s, {
    reportMs: T0,
    inputNewestMs: T0 + DAY, // checkpoint file looks newer...
    hash: hashFrom({ "out/scaled/centroid.jsonl": "aaa" }), // ...but its recorded hash still matches
  });
  assert.equal(v.stamped, true);
  assert.equal(v.stale, false);
});

test("evaluateAgainst: stamp with a tampered input is stale (the published-stale-numbers bug)", () => {
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const v = evaluateAgainst(s, { reportMs: T0, inputNewestMs: null, hash: hashFrom({ "out/scaled/centroid.jsonl": "CHANGED" }) });
  assert.equal(v.stale, true);
  assert.equal(v.fresh, false);
});

test("evaluateAgainst: a vanished recorded input is NOT hard-stale (unverifiable, noted; provenance is only a soft note)", () => {
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const v = evaluateAgainst(s, { reportMs: T0, inputNewestMs: T0 + DAY, hash: hashFrom({ "out/scaled/centroid.jsonl": null }) });
  assert.equal(v.stale, false); // a gitignored checkpoint cleaned up must never block a deploy
  assert.match(v.reasons.join(" "), /not present to re-verify/);
  assert.match(v.reasons.join(" "), /informational, not blocking/);
});

test("evaluateAgainst: legacy / unstamped reports are NEVER hard-stale -- no wall-clock false positives", () => {
  // Regression guard: an unrelated later commit touching a shared source (a lint fix, a refactor) used to
  // mark every old report stale and block publishes. Staleness now requires a RECORDED input sha mismatch.
  const unstampedNewer = evaluateAgainst(null, { reportMs: T0, inputNewestMs: T0 + 30 * DAY });
  assert.equal(unstampedNewer.stale, false);
  assert.equal(unstampedNewer.stamped, false);
  assert.match(unstampedNewer.reasons.join(" "), /no freshness stamp/);
  const stampedNoInputs = evaluateAgainst(stamp([]), { reportMs: T0, inputNewestMs: T0 + 30 * DAY });
  assert.equal(stampedNoInputs.stale, false);
  assert.match(stampedNoInputs.reasons.join(" "), /records no input checkpoint/);
});

test("stampFromMeta: reads nested + flat shapes, rejects legacy metas with no generatedAt", () => {
  assert.equal(stampFromMeta({ generatedAt: "2026-10-17T00:00:00Z", gitSha: "abc", inputs: [{ path: "p", sha256: "h" }] })?.gitSha, "abc");
  assert.equal(stampFromMeta({ generatedBy: "scripts/p59-offtarget-subset.ts" }), null); // the pre-gate meta shape
  assert.equal(stampFromMeta(undefined), null);
});

test("buildStamp: stamps a real repo file and reads it back through stampFromMeta", () => {
  const s = buildStamp(["scripts/report-freshness.ts"]);
  assert.match(s.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.inputs[0].path, "scripts/report-freshness.ts");
  assert.match(s.inputs[0].sha256 ?? "", /^[0-9a-f]{64}$/);
  const back = stampFromMeta(s);
  assert.deepEqual(back?.inputs, s.inputs);
});

test("the gate re-flags a real committed report when its recorded checkpoint is tampered (end-to-end wiring)", async () => {
  // Read the actual stamped P85 json shipped in the repo, keep its recorded hashes but pretend the
  // checkpoint changed, and confirm the same function p86 calls says STALE.
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync("reports/p85-contaminant-fit.json")) return; // report set varies; skip silently if absent
  const meta = (JSON.parse(readFileSync("reports/p85-contaminant-fit.json", "utf8")) as { meta?: unknown }).meta;
  const s = stampFromMeta(meta);
  if (!s || !s.inputs.length) return; // P85 not yet regenerated with a stamp on this checkout
  const v = evaluateAgainst(s, { reportMs: T0 + 10 * DAY, inputNewestMs: null, hash: () => "0".repeat(64) });
  assert.equal(v.stale, true);
});
