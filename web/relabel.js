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
