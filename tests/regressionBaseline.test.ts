import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runOfflineBaseline, serializeBaseline } from "../src/orchestrator/regressionBaseline.ts";

const ALLOWED = new Set(["accepted", "rejected", "needs-more-data"]);

test("offline closed-loop matches the committed regression baseline", async () => {
  const rows = await runOfflineBaseline({ maxTargets: 3, confidenceTrials: 6 });
  // sanity: the digest is non-empty and every verdict is a known value (guards against a vacuous pass)
  assert.ok(rows.length >= 1, "baseline produced no findings");
  for (const r of rows) {
    assert.ok(ALLOWED.has(r.verdict), `unexpected verdict ${r.verdict} for ${r.targetId}`);
    assert.ok(Number.isFinite(r.periodDays) && r.periodDays > 0, `bad period for ${r.targetId}`);
  }
  const got = serializeBaseline(rows);
  // normalize line endings so a CRLF checkout on Windows cannot spuriously fail an LF golden
  const want = readFileSync("tests/fixtures/baseline-offline.json", "utf8").replace(/\r\n/g, "\n");
  assert.equal(got, want.endsWith("\n") ? want : want + "\n");
});
