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

/**
 * Whether a sealed bundle records a REAL harmonic-alias resolution. audit-13 (P1-1): `aliasMultiple === 1` means
 * "the BLS period was already correct" (src/detect/pipeline.ts:18; src/critic/review.ts:270 sets the odd-even check
 * pass from exactly this), so a card carrying x1 has NO alias to report -- and its own checks[] even say "period is
 * clean (alias x1)". Gating the Evidence note on `!= null` used to stamp "harmonic alias x1" on the majority of
 * clean cards, contradicting the sealed manifest right above it. This returns true only for a finite multiple that
 * is genuinely not 1 (an alias actually resolved by the odd-even test). DOM-free and unit-tested.
 */
export function isHarmonicAlias(m) {
  if (!m || m.aliasMultiple == null || m.aliasMultiple === "") return false; // no alias data at all
  const n = Number(m.aliasMultiple);
  return Number.isFinite(n) && n !== 1;
}

/**
 * Collapse rows by id, keeping the FIRST occurrence. audit-13 (P2-6): paging with "load more" appends the next
 * server slice to what is already shown; if the catalog shifts between two requests (a new run upserts a row, the
 * sort recomputes), the same finding can appear on two pages and be rendered twice. Identity `id` is the stable key
 * on every Finding, so de-duping here keeps the reader's list honest without touching the server's paging.
 */
export function dedupeById(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const id = r && r.id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(r);
  }
  return out;
}

/**
 * audit-14 N4: the WHOLE page-merge decision, as a pure function the console calls and the tests drive. audit-13
 * shipped this logic inline in app.js and proved it only by regex-matching the source string -- the very audit-4
 * failure mode the header of this module warns about ("a browser behaviour proven by string-matching app.js can
 * ship wrong on real data"). It belongs here so tests can feed REAL response envelopes and assert the resulting
 * rows/counts, on the exact function the browser runs. Given the current view state, the incoming page's `res` and
 * the offset it was requested at, it returns the next { rows, total, matched, hasMore }: a fresh query (offset 0)
 * REPLACES the rows, "load more" APPENDS, and either way the merged set is de-duplicated by id. Absent/dirty counts
 * fall back to what the rows actually show, never to a lie.
 */
export function applyFindingsPage(state, res, offset) {
  const r = res || {};
  const page = Array.isArray(r.findings) ? r.findings : [];
  const base = state && Array.isArray(state.rows) ? state.rows : [];
  const rows = dedupeById(offset === 0 ? page : base.concat(page));
  const totalN = Number(r.total);
  const matchedN = Number(r.matched);
  const total = Number.isFinite(totalN) ? totalN : rows.length;
  const matched = r.matched != null && Number.isFinite(matchedN) ? matchedN : total;
  return { rows, total, matched, hasMore: Boolean(r.hasMore) };
}

/**
 * audit-14 N4: the failure transition, also pure and testable. A failed FRESH query (offset 0) must clear the board
 * to an honest empty state -- leaving the previous query's cards stranded under an error line is the audit-13 P2 fix
 * that was, until now, only string-asserted. A failed "load more" (offset > 0) must NOT throw away rows the reader
 * already saw; it keeps them and preserves the prior counts. Returns the next state slice (rows/total/matched/hasMore).
 */
export function applyFailedPage(state, offset) {
  if (offset === 0) return { rows: [], total: 0, matched: 0, hasMore: false };
  const s = state || {};
  return {
    rows: Array.isArray(s.rows) ? s.rows : [],
    total: Number(s.total) || 0,
    matched: Number(s.matched) || 0,
    hasMore: Boolean(s.hasMore),
  };
}

/**
 * A plain-ASCII one-line status for the panel, built from the server's response envelope + how many rows the reader
 * currently sees. Kept here (not in app.js) so the wording is unit-testable and identical on either runtime's data.
 * `shown` is the cumulative rows the console has rendered so far (page 1 + any "load more").
 *
 * audit-13 (P2-5): `opts.filtered` comes from hasConstraints(form), NOT from matched===total, so "no filter" is
 * decided by what the reader actually typed rather than by a count that a filter matching every row also produces.
 * audit-13 (P2-4): the "load more" tail only says "for older" under the default `recent` sort; a catalog sorted by
 * depth/snr/TIC pages in THAT key's order, so the tail names the active sort instead of falsely implying time.
 */
export function resultMeta(res, shown, opts) {
  const o = opts || {};
  const total = Number(res && res.total) || 0;
  const matched = Number(res && res.matched != null ? res.matched : total) || 0;
  const seen = Number(shown) || 0;
  const sort = o.sort || "recent";
  const head = o.filtered
    ? `Server matched ${matched} of ${total} catalog rows`
    : `Full catalog: ${total} rows`;
  let tail;
  if (res && res.hasMore) {
    tail = sort === "recent"
      ? ` - showing ${seen}, load more for older`
      : ` - showing ${seen}, load more for the next by ${sort}`;
  } else {
    tail = ` - all ${seen} shown`;
  }
  return head + tail;
}
