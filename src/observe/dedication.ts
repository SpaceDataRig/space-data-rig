// DEDICATION SANITIZER (named-observation feature).
//
// A commissioning user attaches a short free-text dedication ("my father's star", a name, a date, a
// promise) to a sealed, publicly-visible, permanently-anchored observation record. That text crosses a
// trust boundary: it is stored in the sealed envelope, hashed, and shown on a public board. We do not
// run a human review queue (by product decision), so this module enforces a strict, deterministic,
// automated policy BEFORE the record is ever accepted or paid for. It is deliberately conservative:
// reject anything that could turn the immutable public record into a vector for links, markup, spoofing,
// or runaway length.
//
// PURE + OFFLINE. No network, no worker import, cannot touch a verdict / bundle hash / money path.

/** Hard cap, counted in Unicode CODE POINTS (not UTF-16 units) so emoji/CJK names are measured fairly. */
export const DEDICATION_MAX_CODEPOINTS = 160;

// C0/C1 control characters -> collapsed to a space (a dedication is a single logical line).
const CONTROL = /[\x00-\x1F\x7F-\x9F]/g;
// Zero-width + bidi-override + BOM format characters -> removed outright (invisible spoofing helpers).
const FORMAT = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
// Any URL-ish token is forbidden: the record must never become a link farm.
const URLISH = /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|io|app|xyz|dev|co|me|link|sol)\b)/i;
// Angle brackets are forbidden: no markup / no fake tags in a public field.
const ANGLE = /[<>]/;

export type DedicationResult = { ok: true; value: string } | { ok: false; errors: string[] };

/** Number of Unicode code points in a string (surrogate-pair aware). */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

/**
 * Normalize then validate a user dedication. Normalization is applied first (so a value padded with
 * control characters is judged on what it actually renders as), then the policy is enforced. Returns the
 * cleaned string when acceptable, or a list of human-readable reasons when not.
 */
export function sanitizeDedication(raw: unknown): DedicationResult {
  const errors: string[] = [];
  if (typeof raw !== "string") return { ok: false, errors: ["dedication must be a string"] };

  const value = raw
    .replace(FORMAT, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (value.length === 0) errors.push("dedication is empty after cleaning");
  if (ANGLE.test(value)) errors.push("dedication may not contain angle brackets");
  if (URLISH.test(value)) errors.push("dedication may not contain links or domains");
  if (codePointLength(value) > DEDICATION_MAX_CODEPOINTS) {
    errors.push(`dedication exceeds ${DEDICATION_MAX_CODEPOINTS} characters (got ${codePointLength(value)})`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
