// Projection-layer honesty guard (audit-3 defect B).
//
// Bundles are immutable, so legacy cards still store the pre-policy "Confirmed" wording. The fix is a
// DERIVED relabel in the render layer plus a public rule in the README. Neither web/app.js nor README.md
// is covered by tsc, so this test is the regression net: if either the display hook or the documented rule
// disappears (or their shared policy date drifts), the honesty guarantee silently rots -- exactly the class
// of "implemented then not wired on the path that matters" defect the audit caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP = readFileSync(resolve(process.cwd(), "web", "app.js"), "utf8");
const README = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
const POLICY_DATE = "2026-10-12";

test("render layer derives a relabel for legacy 'Confirmed' headlines (defect B)", () => {
  assert.match(APP, /function headlineRelabelNote/, "app.js must expose the relabel helper");
  assert.ok(APP.includes(`"${POLICY_DATE}"`), "app.js must carry the shared policy date");
  assert.match(APP, /\/confirm\/i/, "the relabel keys off the stored 'confirm' wording");
  assert.match(APP, /injection-recovery/, "the note must state the honest reframe");
  assert.match(APP, /\$\{relabel \? `<div class="relabel-note">/, "cardHtml must render the note");
});

test("README documents the projection relabel rule and the same policy date", () => {
  assert.match(README, /Display \/ projection layer/, "README must describe the projection layer");
  assert.ok(README.includes(POLICY_DATE), "README must cite the same policy date as app.js");
  assert.match(README, /headlineRelabelNote/, "README must name the single source of truth");
});

test("the accepted badge reads Recovered, not Confirmed (audit-10 #3)", () => {
  assert.match(APP, /accepted: \{ label: "RECOVERED"/, "accepted verdict must show RECOVERED");
});
