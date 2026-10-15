// Bearer-token admin authorization for the STATE-CHANGING endpoints (audit issue #1; default-deny per audit-10 #7).
//
// WHY. CORS only stops a cross-origin browser CSRF; it does nothing against a direct request to
// the public port. Without a gate, anyone who can reach the host could POST /api/run (spend compute
// and rewrite the displayed findings) or POST /api/anchor/:id (trigger a real SOL-mainnet fee from
// the fee wallet). For a project whose headline is a budget-gated autonomous loop, an unauthenticated
// mutation endpoint is the most glaring gap.
//
// DEFAULT-DENY posture (audit-10 #7). The gate is now DENY-BY-DEFAULT: when ADMIN_TOKEN is
// unset/empty the state-changing endpoints are CLOSED (401), so this code can never be deployed
// leaving /api/run and /api/anchor/* open. The operator ENABLES mutations by setting a secret
// (`wrangler secret put ADMIN_TOKEN` / ADMIN_TOKEN in .env); from then on every mutating request
// must carry `Authorization: Bearer <token>`. A live instance with no ADMIN_TOKEN set therefore
// rejects run/anchor calls rather than honouring them -- fail closed, not open.
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
 *  - expected unset/empty  -> DENY (default-deny: no secret configured, mutations are closed).
 *  - expected set          -> require an exact `Bearer` match (constant-time).
 */
export function isAdminAuthorized(authHeader: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length === 0) return false;
  const got = bearerToken(authHeader);
  return got != null && timingSafeEqualStr(got, expected);
}

/** The uniform 401 body returned when a mutating call is rejected. */
export const ADMIN_UNAUTHORIZED = { error: "unauthorized: a valid admin bearer token is required for this action" } as const;
