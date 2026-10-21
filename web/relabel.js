// Pure, shared projection-relabel predicate (audit-4 P0).
//
// WHY A SEPARATE MODULE. The audit-3 version kept headlineRelabelNote inline in web/app.js and its test only
// string-matched the source ("the function exists", "README cites the same date"). That is exactly how an
// off-by-one-day boundary shipped green while matching ZERO live cards: the predicate used `created < POLICY_DATE`
// but all four real legacy "Confirmed:" cards were created ON the policy date (2026-10-12), so the strict `<`
// excluded every record the rule was written for. Extracting the predicate means the browser and
// tests/live-data-regression.test.ts import the SAME function, so a test can drive the real /api/state findings
// through it and assert the four legacy cards actually get annotated. No DOM, no imports: finding in, note out.

// The last day the retired "Confirmed:" wording was used on a stored headline. Cards created ON OR BEFORE this
// day are legacy and get re-labeled in the render layer (history itself is never rewritten -- bundles stay
// immutable). New cards use the "Recovered" prefix, so they never contain "confirm" and are never touched.
export const RELABEL_POLICY_DATE = "2026-10-12";

export const RELABEL_NOTE =
  "Re-labeled under the 2026-10 display policy: injection-recovery (the pipeline recovered a signal it was pointed at), not an independent confirmation.";

// Returns the honest re-label note for a legacy "Confirmed" card, or "" when no note applies.
// audit-4 fix: the boundary is `<=` (the policy date itself is still legacy), not `<`.
export function headlineRelabelNote(f) {
  const text = `${f?.narration?.headline || ""} ${f?.verdictReason || ""}`;
  const created = (f?.createdAt || "").slice(0, 10);
  const legacy = !created || created <= RELABEL_POLICY_DATE;
  if (legacy && /confirm/i.test(text)) return RELABEL_NOTE;
  return "";
}

// ---- R5: physically-consistent wording on an implausibly-high-SNR signal ----
// This MUST equal SNR_IMPLAUSIBLE in src/critic/review.ts; tests/degeneracy-relabel.test.ts reads both files and
// fails if the two literals ever diverge -- the same drift guard the headline policy date uses.
export const SNR_IMPLAUSIBLE = 1000;

export const DEGENERACY_NOTE =
  "Stored verdict text calls this a physically-consistent transit, but its signal-to-noise is above the plausibility bound the critic now applies (SNR > 1000). SNR of that size is not evidence of physical consistency; this is an immutable historical bundle whose wording the current critic no longer emits.";

// A caveat for a finding whose stored verdictReason asserts "physically-consistent" while quoting an implausible
// SNR. The SNR is read straight out of the reason text the reader actually sees, so this does not depend on a
// separate field's shape. Returns "" for every honest case -- it never annotates a sound finding, and it never
// rewrites the immutable bundle; it only adds a derived note in the render layer.
export function degeneracyCaveat(f) {
  const reason = (f && f.verdictReason) || "";
  if (!/physically-consistent/i.test(reason)) return "";
  const m = /SNR\s+(\d+(?:\.\d+)?)/i.exec(reason);
  if (!m) return "";
  return Number(m[1]) > SNR_IMPLAUSIBLE ? DEGENERACY_NOTE : "";
}
