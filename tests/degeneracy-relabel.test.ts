// R5 honesty guard: a STORED verdictReason that calls a signal "physically-consistent" while quoting an
// implausibly high SNR must be caveat-annotated in the render layer -- the same projection pattern as the legacy
// "Confirmed:" re-label. The critic already refuses this wording for NEW reviews (src/critic/review.ts gates on
// SNR_IMPLAUSIBLE), but historical anchored bundles are immutable and still carry the old text, so the correction
// happens at display, never by rewriting a bundle.
//
// The load-bearing risk here is TWO IMPLEMENTATIONS OF ONE RULE drifting apart (the audit's recurring theme), so
// this file asserts the browser mirror and the critic authority hold the SAME threshold, then drives the real
// predicate over representative text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { degeneracyCaveat, SNR_IMPLAUSIBLE as BROWSER_SNR, DEGENERACY_NOTE } from "../web/relabel.js";
import { SNR_IMPLAUSIBLE as CRITIC_SNR } from "../src/critic/review.ts";

const APP = readFileSync(resolve(process.cwd(), "web", "app.js"), "utf8");

test("the browser mirror and the critic share ONE SNR-implausibility threshold (no drift)", () => {
  assert.equal(BROWSER_SNR, CRITIC_SNR, "web/relabel.js SNR_IMPLAUSIBLE must equal src/critic/review.ts SNR_IMPLAUSIBLE");
});

const finding = (verdictReason: string) => ({ verdictReason });

test("a stored 'physically-consistent' verdict at an implausible SNR is caveated", () => {
  // F-TOI-1830-01 carried SNR 45172 -- an absurd value the critic itself would now refuse.
  const reason = `Blind recovery: significant, physically-consistent transit (SNR 45172, recovery 100%) independently cross-matches TOI-1830 b at its fundamental period.`;
  assert.equal(degeneracyCaveat(finding(reason)), DEGENERACY_NOTE);
});

test("a legitimate known-planet recovery just over the bar is still flagged (the rule is SNR, not plausibility)", () => {
  const reason = `significant, physically-consistent transit (SNR 2456, recovery 90%)`;
  assert.equal(degeneracyCaveat(finding(reason)), DEGENERACY_NOTE);
});

test("a 'physically-consistent' verdict at a sound SNR is NOT annotated", () => {
  const reason = `significant, physically-consistent transit (SNR 18, recovery 92%)`;
  assert.equal(degeneracyCaveat(finding(reason)), "", "an honest moderate-SNR recovery must not get a caveat");
});

test("a reason that never claims physical consistency is NOT annotated, whatever its SNR", () => {
  assert.equal(degeneracyCaveat(finding(`Significant but DEGENERATE transit (SNR 45172); physical consistency is not asserted`)), "");
  assert.equal(degeneracyCaveat(finding(`needs a second sector (SNR 40)`)), "");
});

test("a 'physically-consistent' reason with no parseable SNR is left alone (conservative, never a false annotation)", () => {
  assert.equal(degeneracyCaveat(finding(`a physically-consistent transit with no number quoted`)), "");
});

test("the boundary is strict: an SNR exactly at the threshold is honest, one above is caveated", () => {
  assert.equal(degeneracyCaveat(finding(`physically-consistent transit (SNR ${CRITIC_SNR})`)), "", "at the bar is not over it");
  assert.notEqual(degeneracyCaveat(finding(`physically-consistent transit (SNR ${CRITIC_SNR + 1})`)), "", "one over trips");
});

test("app.js imports the shared caveat and renders it in cardHtml", () => {
  assert.match(APP, /import \{[^}]*\bdegeneracyCaveat\b[^}]*\} from "\/relabel\.js"/, "app.js must import the ONE shared caveat");
  assert.match(APP, /const degen = degeneracyCaveat\(f\)/, "cardHtml must call the caveat");
  assert.match(APP, /\$\{degen \? `<div class="relabel-note">/, "cardHtml must render the caveat when present");
});
