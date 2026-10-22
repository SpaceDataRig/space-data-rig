// v0.2 P0b :: pure query-string builder for the FINDINGS catalog's SERVER-side query panel.
//
// WHY A SEPARATE MODULE (the audit-4 lesson, applied to the new console). The projection-relabel predicate once
// shipped green on nothing but a string-match of web/app.js -- "the function exists" -- while its boundary was
// wrong on real data. Extracting this builder means tests/findings-query-ui.test.ts drives the REAL function over
// form fixtures and asserts the EXACT params the browser will send, so those params are pinned to the vocabulary
// src/core/finding-query.ts actually parses. A filter whose key name drifts is caught here, offline, not in
// production against a 100+-row catalog. DOM-free: a form-values object in, a plain param object / path out.
//
// THIS LAYERS ON, IT DOES NOT REPLACE. The edge and Node both serve GET /api/findings through the same
// parseFindingQuery + queryFindings; the browser only ever ASSEMBLES a query that that module can parse. Nothing
// here filters, sorts or pages -- that is the server's job (the entire point of P0 was to stop pulling ~324 KB and
// filtering it in memory). No verdict, bundle hash, or money path is touched: this reads a projection.
//
// ASCII ONLY. Every published surface of this repo is English (tests/repo-hygiene.test.ts); the status text built
// here is rendered as textContent, so it uses plain hyphens and never a non-ASCII dash.

// Rows fetched per server page. Small on purpose: a paginated console should stream a dozen cards at a time, not
// re-create the "download the whole catalog" problem P0 exists to remove. The server clamps limit to its own
// MAX_LIMIT (500) regardless, so a hand-edited value can never ask for more than the edge will give.
export const QUERY_PAGE = 24;

// The exact parameter names src/core/finding-query.ts `parseFindingQuery` reads. Naming them once here, and
// asserting against the server module in the test, is the parity pin between what the browser sends and what
// both runtimes accept.
const NUMERIC_KEYS = ["periodMin", "periodMax", "depthMin", "depthMax", "snrMin"];

// Trim a scalar; "" / null / undefined collapse to "" so callers can treat "empty" uniformly.
function clean(v) {
  return v == null ? "" : String(v).trim();
}

/**
 * Build the query params for one page of the server-side findings query.
 *
 * `form` is a plain object of the panel's current values: { verdict, origin, tic, q, periodMin, periodMax,
 * depthMin, depthMax, snrMin, sort, dir }. Empty text fields are omitted (never sent as `?verdict=`); a numeric
 * field is sent ONLY when it parses to a finite number, so a stray "abc" in a number box drops just that one axis
 * rather than blanking the whole filter -- this mirrors parseFindingQuery's "dirty value is dropped, not trusted".
 *
 * `offset` is the row index to page from (0-based). `limit` and `offset` are ALWAYS emitted, even with no filters:
 * that keeps the query "active" server-side so it pages instead of returning the entire catalog at once, which is
 * the behaviour a browsing reader wants. (A caller that truly wants the whole catalog -- an offline figure -- uses
 * the parameterless path and never enters this function.)
 *
 * @returns {Record<string, string>} a flat string->string param map (an index signature, so callers can read any
 *   axis back and pass it straight into the server's parseFindingQuery without a key-name mismatch).
 */
export function buildFindingsParams(form, offset = 0) {
  const f = form || {};
  const params = {};

  const text = clean(f.verdict);
  if (text) params.verdict = text;
  const origin = clean(f.origin);
  if (origin) params.origin = origin;
  const tic = clean(f.tic);
  if (tic) params.tic = tic;
  const q = clean(f.q);
  if (q) params.q = q;

  for (const k of NUMERIC_KEYS) {
    const raw = clean(f[k]);
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) params[k] = String(n);
  }

  const sort = clean(f.sort);
  if (sort) params.sort = sort;
  const dir = clean(f.dir);
  if (dir) params.dir = dir;

  // Paging is unconditional: the console is a paged view, not a full-catalog dump.
  params.limit = String(QUERY_PAGE);
  params.offset = String(Math.max(0, Math.floor(Number(offset) || 0)));
  return params;
}

/** Deterministic `/api/findings?...` path. Keys sorted so the same form always yields the same URL (cache- and
 *  test-friendly); values are URL-encoded by URLSearchParams, so a free-text `q` with spaces/& is safe. */
export function findingsQueryPath(params) {
  const keys = Object.keys(params).sort();
  const usp = new URLSearchParams();
  for (const k of keys) usp.set(k, params[k]);
  const qs = usp.toString();
  return qs ? `/api/findings?${qs}` : "/api/findings";
}

/**
 * Whether the form carries any actual constraint (ignoring the always-sent paging). Used to label the view honestly:
 * "showing the full catalog (paged)" vs "filtered by N criterion/criteria". This is display only -- it never
 * changes the request, which always pages.
 */
export function hasConstraints(form) {
  return Object.keys(buildFindingsParams(form, 0)).length > 2; // > limit + offset
}

/** A plain-ASCII one-line status for the panel, built from the server's response envelope + how many rows the
 *  reader currently sees. Kept here (not in app.js) so the wording is unit-testable and identical on either
 *  runtime's data. `shown` is the cumulative rows the console has rendered so far (page 1 + any "load more").
 *
 *  The sentence always reports "server matched M of N" -- it does NOT claim "no filter" merely because a filter
 *  happened to match every row. matched===total is genuinely ambiguous (an empty query AND a filter that catches
 *  all rows both look like that), and printing "(no filter)" for the latter would tell a reader their criterion
 *  did nothing when it in fact ran and simply kept everything. Stating the two counts lets the reader judge. */
export function resultMeta(res, shown) {
  const total = Number(res && res.total) || 0;
  const matched = Number(res && res.matched != null ? res.matched : total) || 0;
  const seen = Number(shown) || 0;
  const head = `Server matched ${matched} of ${total} catalog rows`;
  const tail = res && res.hasMore ? ` - showing ${seen}, load more for older` : ` - showing all ${seen}`;
  return head + tail;
}
