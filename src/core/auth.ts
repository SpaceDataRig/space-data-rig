// Opt-in admin authorization for the STATE-CHANGING endpoints (audit issue #1).
//
// WHY. CORS only stops a cross-origin browser CSRF; it does nothing against a direct request to
// the public port. Without a gate, anyone who can reach the host could POST /api/run (spend compute
// and rewrite the displayed findings) or POST /api/anchor/:id (trigger a real SOL-mainnet fee from
// the fee wallet). For a project whose headline is a budget-gated autonomous loop, an unauthenticated
// mutation endpoint is the most glaring gap.
//
// ROLLOUT SAFETY. The gate is OPT-IN so the code can ship without silently breaking the live
// dashboard: when ADMIN_TOKEN is unset/empty the endpoints behave exactly as before. The operator
// closes the hole by setting a secret (`wrangler secret put ADMIN_TOKEN` / ADMIN_TOKEN in .env);
// from then on every mutating request must carry `Authorization: Bearer <token>`.
//
// Pure + runtime-agnostic (no node:crypto): the comparison is constant-time to avoid leaking the
// secret through a timing side channel.

/** Constant-time string equality. Compares every index; no early return on first mismatch. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  // Lengths differing is not itself secret (the expected token length is fixed), but we still
  // avoid a character-by-character early exit for equal-length inputs.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull the bearer token out of an `Authorization: Bearer <t>` header value, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Whether a request is authorized for a mutating endpoint.
 *  - expected unset/empty  -> open (opt-in; today's behaviour preserved until a secret is set).
 *  - expected set          -> require an exact `Bearer` match (constant-time).
 */
export function isAdminAuthorized(authHeader: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length === 0) return true;
  const got = bearerToken(authHeader);
  return got != null && timingSafeEqualStr(got, expected);
}

/** The uniform 401 body returned when a mutating call is rejected. */
export const ADMIN_UNAUTHORIZED = { error: "unauthorized: a valid admin bearer token is required for this action" } as const;
