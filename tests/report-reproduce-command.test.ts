// ROUND-26 R26-15: every published report row must tell the reader how to re-run it.
//
// THE GAP. `web/reports/index.json` carries a `reproduce` command per row, scraped by scripts/report-md.ts out of a
// `Reproduce: \`...\`` line in the report's own markdown. Six of 56 rows had none -- including five the gate happily
// reports as `verified`. Freshness says the bytes match the inputs a run recorded; it says nothing about whether a
// reader can perform that run, so a row could be machine-checked and still unrepeatable by anyone who found it on the
// site. Round-26 fixed the two it could re-run offline (p68, p90) by adding the line to the GENERATOR -- hand-editing a
// generated .md would recreate exactly the artifact-vs-source divergence this round has been chasing -- and the fleet's
// live arm then picked up p91's (it re-ran with the generator that emits the line, so p91.md now carries it and has been
// pruned from the allow-list below). Three rows remain excused, each for a named reason.
//
// WHY A RATCHET AND NOT A CLEAN-UP ASSERTION. The remaining ids are blocked for named, checkable reasons, not by
// neglect, and pretending otherwise would either fail CI for days or invite a `--allow-stale`-shaped workaround. So the
// allow-list is asserted in BOTH directions: no id may join it silently, and no id may stay on it once it has been
// fixed. That second half matters -- an allow-list nobody prunes becomes a lie with a date stamp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const INDEX = "web/reports/index.json";

/** Rows with no reproduce command, and the specific reason each one is still standing. */
const ALLOWED_EMPTY: Record<string, string> = {
  "p85-contaminant-fit": "its stamp covers out/scaled/*.jsonl, a gitignored checkpoint no other checkout carries; re-running it here would restamp the row against bytes that exist on one workstation",
  "crosscheck/benchmark-vs-field": "produced by the LEO-Vetter CI harness, not a scripts/ generator; the fix belongs in that job's report writer",
  "crosscheck/cross-pipeline": "produced by the Python cross-pipeline CI harness (batman/wotan/astropy), which has no npm reproduce command to emit yet",
};

test("no published report row is silently missing its reproduce command", () => {
  if (!existsSync(INDEX)) return; // library not built on this checkout
  const idx = JSON.parse(readFileSync(INDEX, "utf8")) as {
    reports: { id: string; reproduce?: string; stamped: boolean; verified: boolean }[];
  };
  const empty = idx.reports.filter((r) => !(r.reproduce || "").trim());
  const unexpected = empty.filter((r) => !(r.id in ALLOWED_EMPTY)).map((r) => `${r.id} (stamped=${r.stamped} verified=${r.verified})`);
  assert.deepEqual(
    unexpected, [],
    `row(s) published with no reproduce command and no recorded reason: ${unexpected.join(", ")}. ` +
      "Add the line to the GENERATOR's markdown (Reproduce: `npm run ...`) and re-run it -- not to the .md by hand.",
  );
});

test("the allow-list is pruned: an id it names must still be missing its command", () => {
  if (!existsSync(INDEX)) return;
  const idx = JSON.parse(readFileSync(INDEX, "utf8")) as { reports: { id: string; reproduce?: string }[] };
  const stale = Object.keys(ALLOWED_EMPTY).filter((id) => {
    const row = idx.reports.find((r) => r.id === id);
    return !!row && (row.reproduce || "").trim().length > 0;
  });
  assert.deepEqual(
    stale, [],
    `these rows now DO carry a reproduce command, so remove them from the allow-list in this file: ${stale.join(", ")}. ` +
      "An unpruned exemption list is a claim about the past that reads as a claim about the present.",
  );
});

test("the command comes from the generator, not from a hand-edited markdown file", () => {
  // The point of R26-15 is that the command comes from the code that writes the report. A hand-edited .md would be
  // overwritten by the next re-run and would look like provenance while being a guess.
  for (const [script, cmd] of [["scripts/p68-discriminator-roc.ts", "npm run p68:discriminator-roc"],
    ["scripts/p90-depth-estimators.ts", "npm run p90:depth-estimators"],
    ["scripts/p91-claim-provenance.ts", "npm run p91:claim-provenance"]]) {
    const src = readFileSync(script, "utf8");
    assert.ok(src.includes(`Reproduce: \`${cmd}\``), `${script} must emit its own reproduce command into the report markdown`);
  }
  for (const id of ["p68-discriminator-roc", "p90-depth-estimators", "p91-claim-provenance"]) {
    const md = readFileSync(`reports/${id}.md`, "utf8");
    assert.match(md, /^Reproduce: `npm run /m, `reports/${id}.md must carry the command its generator writes`);
  }
});
