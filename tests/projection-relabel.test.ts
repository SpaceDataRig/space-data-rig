// Projection-layer honesty guard -- BEHAVIOUR test (audit-3 defect B, rewritten for audit-4 P0).
//
// WHY THIS WAS REWRITTEN. The audit-3 version of this file only string-matched web/app.js source: "the
// function exists", "the policy date appears", "/confirm/i is present". A string test can prove code was not
// DELETED but can never prove the LOGIC is right. The shipped predicate used `created < POLICY_DATE` while all
// four live legacy "Confirmed:" cards were created ON the policy date (2026-10-12), so it annotated ZERO cards
// -- and every string assertion stayed green, because the strings it looked for were all still there. That is
// exactly the "deployed but never fires on real data" class the audit named.
//
// This file now drives the REAL predicate, imported from web/relabel.js (the SAME module web/app.js imports),
// over fixtures that pin the boundary behaviour. tests/live-data-regression.test.ts additionally runs it over
// the captured /api/state snapshot. The few structural assertions kept at the bottom only check the predicate
// is still WIRED into the render path and README -- which behaviour on the pure function alone cannot prove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { headlineRelabelNote, RELABEL_NOTE, RELABEL_POLICY_DATE } from "../web/relabel.js";

const APP = readFileSync(resolve(process.cwd(), "web", "app.js"), "utf8");
const README = readFileSync(resolve(process.cwd(), "README.md"), "utf8");

// A minimal finding shape carrying only the fields the predicate reads.
const card = (createdAt: string | undefined, headline: string) => ({
  createdAt,
  narration: { headline },
  verdictReason: "",
});

test("a card created ON the policy date with a 'Confirmed:' headline IS re-labeled (the audit-4 off-by-one)", () => {
  // The exact record the strict `<` boundary silently dropped: HD 189733 b, created 2026-10-12T16:00:50Z.
  const f = card("2026-10-12T16:00:50.197Z", "Confirmed: a planet orbiting every 2.22 days, matching HD 189733 b.");
  assert.equal(headlineRelabelNote(f), RELABEL_NOTE);
});

test("a card created BEFORE the policy date with a 'confirm' headline IS re-labeled", () => {
  assert.equal(headlineRelabelNote(card("2026-10-11T23:59:59Z", "Confirmed: legacy")), RELABEL_NOTE);
});

test("a card with a MISSING createdAt and a 'confirm' headline IS re-labeled (legacy fallback)", () => {
  assert.equal(headlineRelabelNote(card(undefined, "Confirmed: no timestamp")), RELABEL_NOTE);
});

test("a card created AFTER the policy date is NOT re-labeled, even if it still says 'confirm'", () => {
  assert.equal(headlineRelabelNote(card("2026-10-13T00:00:00Z", "Confirmed: brand new")), "");
});

test("a pre-policy card whose headline is already honest (no 'confirm') is NOT re-labeled", () => {
  // The /confirm/ guard, not the date, is what spares this one -- a date-only test would get it wrong.
  assert.equal(headlineRelabelNote(card("2026-10-12T16:12:24Z", "Promising but unproven: a possible signal")), "");
});

test("the boundary is INCLUSIVE: RELABEL_POLICY_DATE itself is legacy, the next day is not", () => {
  // Pin the operator-visible contract so a future `<` regression fails HERE, not silently in production.
  assert.notEqual(headlineRelabelNote(card(`${RELABEL_POLICY_DATE}T00:00:00Z`, "Confirmed: x")), "");
  assert.equal(headlineRelabelNote(card("2026-10-13T00:00:00Z", "Confirmed: x")), "");
});

// --- structural: behaviour on the pure predicate cannot prove it is still WIRED into the render path ---

test("app.js imports the shared predicate and renders its note in cardHtml", () => {
  assert.match(APP, /import \{[^}]*\bheadlineRelabelNote\b[^}]*\} from "\/relabel\.js"/, "app.js must import the ONE shared predicate");
  assert.match(APP, /const relabel = headlineRelabelNote\(f\)/, "cardHtml must call the predicate");
  assert.match(APP, /\$\{relabel \? `<div class="relabel-note">/, "cardHtml must render the note when present");
});

test("the accepted badge reads Recovered, not Confirmed (audit-10 #3)", () => {
  assert.match(APP, /accepted: \{ label: "RECOVERED"/, "accepted verdict must show RECOVERED");
});

test("README documents the projection rule, the same policy date, and names web/relabel.js", () => {
  assert.match(README, /Display \/ projection layer/, "README must describe the projection layer");
  assert.ok(README.includes(RELABEL_POLICY_DATE), "README must cite the same policy date as the predicate");
  assert.match(README, /web\/relabel\.js/, "README must name the single-source-of-truth module, not a stale path");
});
