/**
 * SERVER-SIDE QUERY of the findings catalog (v0.2 Interactive Verification Console, P0).
 *
 * WHY. Until now the only way to read the catalog was `GET /api/state` (~324 KB, every finding card) and
 * `GET /api/findings` (every card, no filter). The browser then filtered in memory. That is fine at a dozen rows
 * and wrong at a hundred-plus (distinctRecords 103 rows over 90 host stars and climbing): a reader who wants "the blind candidates between
 * 800 and 2000 ppm with P under 3 d" had to download the whole catalog to answer it, and the transport wall the
 * twelfth-round audit measured (40-60% fetch failure on the big payload) is exactly what a query endpoint exists to
 * avoid. This is a pure projection over rows that already exist -- it runs nothing, gates nothing, and touches no
 * verdict, bundle hash or money path.
 *
 * BACKWARD-COMPATIBILITY IS DELIBERATE. An EMPTY query returns the input list UNCHANGED (same order, every row,
 * hasMore=false): a committed research figure (`scripts/depth-significance-figure.ts`) reads `/api/findings` with
 * no parameters and depends on getting the whole catalog in the store's own order. Filtering, sorting and paging
 * only engage when a caller actually asks for them.
 *
 * RUNTIME-AGNOSTIC. No node:*, no @cloudflare/workers-types -- so the Node server and the edge Worker share one
 * implementation and cannot diverge, the same discipline as src/core/state-summary.ts and src/survey/rotation.ts.
 *
 * FILTERABLE FIELDS ARE ONLY THE ONES A Finding ACTUALLY CARRIES. `sector` and the calibrated FAP are NOT fields
 * on a Finding (sector is not persisted; FAP lives in the bundle manifest's gating checks), so they are
 * deliberately absent here rather than silently faked -- see P1, which surfaces the manifest checks per card.
 */
import type { Finding } from "./types.ts";
import { hostKeyOf } from "./signal-identity.ts";

export type FindingSort = "recent" | "score" | "period" | "depth" | "snr";

/** A parsed, clamped query. Absent keys mean "no constraint on that axis". */
export interface FindingQuery {
  verdict?: "accepted" | "rejected" | "needs-more-data";
  origin?: "revalidation" | "blind-toi";
  /** Case-insensitive substring of the target id (e.g. a bare TIC number). */
  tic?: string;
  /** Free text across target id, known-planet name, verdict and reason. */
  q?: string;
  periodMin?: number;
  periodMax?: number;
  depthMinPpm?: number;
  depthMaxPpm?: number;
  snrMin?: number;
  sort?: FindingSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

const VERDICTS = new Set<string>(["accepted", "rejected", "needs-more-data"]);
const ORIGINS = new Set<string>(["revalidation", "blind-toi"]);
const SORTS = new Set<string>(["recent", "score", "period", "depth", "snr"]);
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;

/** transit depth in ppm, the same rounding the served view uses, so a filter and a card never disagree. */
export function depthPpmOf(f: Finding): number {
  return Math.round(f.candidate.depthFrac * 1e6);
}

function num(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a Hono `c.req.query()` record into a clamped FindingQuery. Unknown/dirty values are dropped, never trusted. */
export function parseFindingQuery(raw: Record<string, string | undefined>): FindingQuery {
  const q: FindingQuery = {};
  const verdict = raw.verdict;
  if (verdict && VERDICTS.has(verdict)) q.verdict = verdict as Finding["verdict"];
  const origin = raw.origin;
  if (origin && ORIGINS.has(origin)) q.origin = origin as Finding["origin"];
  const tic = (raw.tic ?? "").trim();
  if (tic) q.tic = tic.toLowerCase();
  const text = (raw.q ?? "").trim();
  if (text) q.q = text.toLowerCase();
  const pmin = num(raw.periodMin); if (pmin !== undefined) q.periodMin = pmin;
  const pmax = num(raw.periodMax); if (pmax !== undefined) q.periodMax = pmax;
  const dmin = num(raw.depthMin); if (dmin !== undefined) q.depthMinPpm = dmin;
  const dmax = num(raw.depthMax); if (dmax !== undefined) q.depthMaxPpm = dmax;
  const smin = num(raw.snrMin); if (smin !== undefined) q.snrMin = smin;
  const sort = raw.sort;
  if (sort && SORTS.has(sort)) q.sort = sort as FindingSort;
  if (raw.dir === "asc" || raw.dir === "desc") q.dir = raw.dir;
  const limit = num(raw.limit);
  if (limit !== undefined) q.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const offset = num(raw.offset);
  if (offset !== undefined) q.offset = Math.max(0, Math.floor(offset));
  return q;
}

/**
 * audit-14 N1: which supplied query parameters were PRESENT (non-empty) but NOT applied because their value failed
 * validation. parseFindingQuery deliberately drops a bad value rather than throwing (the empty-query identity
 * invariant must hold, and a typo should not 500 the endpoint), but a silent drop is a different kind of dishonesty
 * to an external verifier reading the URL directly: `?verdict=accesped` looked like a filter and returned the whole
 * catalog with no trace. This mirrors the EXACT drop rules of parseFindingQuery -- the same vocabularies and the same
 * `num()` finite test -- so a key reported here is one that genuinely did nothing. The handlers echo it in the
 * response (`ignored: [...]`) so a caller learns their criterion was not trusted, without the endpoint changing which
 * rows it returns.
 */
export function ignoredFindingParams(raw: Record<string, string | undefined>): string[] {
  const ignored: string[] = [];
  const present = (v: string | undefined): boolean => v != null && v.trim() !== "";
  if (present(raw.verdict) && !VERDICTS.has(raw.verdict as string)) ignored.push("verdict");
  if (present(raw.origin) && !ORIGINS.has(raw.origin as string)) ignored.push("origin");
  if (present(raw.sort) && !SORTS.has(raw.sort as string)) ignored.push("sort");
  if (present(raw.dir) && raw.dir !== "asc" && raw.dir !== "desc") ignored.push("dir");
  for (const k of ["periodMin", "periodMax", "depthMin", "depthMax", "snrMin", "limit", "offset"]) {
    if (present(raw[k]) && num(raw[k]) === undefined) ignored.push(k);
  }
  return ignored;
}

/**
 * audit-15 T3: parseFindingQuery CLAMPS paging into a safe band (limit into [1, MAX_LIMIT], offset to >= 0) rather
 * than dropping it -- `limit=0` gets one row, not zero and not an error. That is a different act from the N1 drop (the
 * criterion IS applied, just at a bounded value), but a verifier reading the URL still deserves to learn their literal
 * value was moved. This reports paging keys whose FINITE supplied value the parser altered, complementing
 * ignoredFindingParams (which reports keys whose value failed validation outright); the handlers echo both.
 */
export function clampedFindingParams(raw: Record<string, string | undefined>, q: FindingQuery): string[] {
  const notes: string[] = [];
  const present = (v: string | undefined): boolean => v != null && v.trim() !== "";
  if (present(raw.limit)) {
    const n = num(raw.limit);
    if (n !== undefined && q.limit !== undefined && n !== q.limit) notes.push("limit");
  }
  if (present(raw.offset)) {
    const n = num(raw.offset);
    if (n !== undefined && q.offset !== undefined && n !== q.offset) notes.push("offset");
  }
  return notes;
}

/**
 * audit-14 N2 / audit-15 T1: `tic` promises an IDENTIFIER, so a purely numeric query must equal a whole identifier
 * number of the target -- never a loose substring, and never an incidental digit. The audit-15 catch was that my own
 * round-14 fix still split digit runs on real TESS ids of the form `TOI-<n>.<candidate>`: the dot made the
 * CANDIDATE-PLANET NUMBER `.01` its own "digit run", so `tic=01` swept in all 53 `.01` objects and zero-padded `tic=0858` (a real HR 858)
 * matched none. Two changes close it: (1) drop the candidate-number suffix before extracting runs, so only the host number
 * is comparable; (2) compare NUMERICALLY (leading zeros normalized), so `0858` == `858`. A query carrying any
 * non-digit keeps the case-insensitive contains behaviour (there is no digit-run semantics to apply), and the
 * free-text `q` stays the deliberate loose-contains tool. AUDIT-16 terminology note: `.01` is the ExoFOP
 * `ctoi_alias` CANDIDATE index (`toidisplay`, src/data/toiArchive.ts:11-12) -- an identifier naming WHICH candidate of
 * the host, not "cadence" and not noise; it is stripped here only so host-level lookup is unaffected.
 */
function targetMatchesTic(targetIdLower: string, ticLower: string): boolean {
  if (/^\d+$/.test(ticLower)) {
    const want = String(Number(ticLower));
    return identifierRuns(targetIdLower).map((r) => String(Number(r))).includes(want);
  }
  return targetIdLower.includes(ticLower);
}

/**
 * The host identifier's numeric components via the SHARED hostKeyOf reduction (audit-16: this replaces the round-15
 * narrow /(toi-\d+)\.\d+/ substitution, which was safe only while every dotted label happened to be hyphenated TOI
 * style -- a future "TIC 1234567.01" or "TOI 1234.01" would have re-leaked its candidate number with nothing in CI
 * catching it). hostKeyOf strips a trailing candidate number and/or planet designator for ANY naming scheme, so
 * digit-run identification here cannot drift from what distinctHosts counts. Hyphen/word ids keep their digits
 * (HAT-P-11 -> ["11"]).
 */
function identifierRuns(targetIdLower: string): string[] {
  return hostKeyOf(targetIdLower).match(/\d+/g) ?? [];
}

function matches(f: Finding, q: FindingQuery): boolean {
  if (q.verdict && f.verdict !== q.verdict) return false;
  if (q.origin) {
    // Absent origin on a pre-rotation row reads as "revalidation" (the audit-5 label), not as a third class.
    const eff: Finding["origin"] = f.origin ?? "revalidation";
    if (eff !== q.origin) return false;
  }
  if (q.tic !== undefined && !targetMatchesTic(f.targetId.toLowerCase(), q.tic)) return false;

  if (q.q) {
    const hay = [
      f.targetId,
      f.crossmatch?.knownPlanetName ?? "",
      f.verdictReason,
      f.verdict,
    ].join(" ").toLowerCase();
    if (!hay.includes(q.q)) return false;
  }
  const p = f.candidate.periodDays;
  if (q.periodMin !== undefined && !(p >= q.periodMin)) return false;
  if (q.periodMax !== undefined && !(p <= q.periodMax)) return false;
  const d = depthPpmOf(f);
  if (q.depthMinPpm !== undefined && !(d >= q.depthMinPpm)) return false;
  if (q.depthMaxPpm !== undefined && !(d <= q.depthMaxPpm)) return false;
  if (q.snrMin !== undefined && !(f.candidate.snr >= q.snrMin)) return false;
  return true;
}

function sortValue(f: Finding, key: FindingSort): number | string {
  switch (key) {
    case "recent": return f.createdAt;
    case "score": return f.score ?? 0;
    case "period": return f.candidate.periodDays;
    case "depth": return depthPpmOf(f);
    case "snr": return f.candidate.snr;
  }
}

export interface FindingQueryResult {
  rows: Finding[];
  total: number;
  matched: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Apply a query to a findings list. With NO filters, sort or paging requested, returns the list untouched (order
 * preserved) so existing whole-catalog consumers are unchanged. Otherwise: filter, then sort (default "recent"
 * descending), then slice by limit/offset. `matched` is the count after filtering, before paging.
 */
export function queryFindings(findings: Finding[], q: FindingQuery): FindingQueryResult {
  const total = findings.length;
  // audit-15 T2: `dir` was in the parser's vocabulary but MISSING from this active-set, so `?dir=asc` alone fell to
  // the inactive branch -- returned the whole catalog unsorted with `ignored:[]`, the exact "gave a criterion, nothing
  // happened" hole N1 was meant to close, re-hitting the ~120 KB transport wall the summary endpoint exists to dodge.
  const active =
    q.verdict !== undefined || q.origin !== undefined || q.tic !== undefined || q.q !== undefined ||
    q.periodMin !== undefined || q.periodMax !== undefined || q.depthMinPpm !== undefined ||
    q.depthMaxPpm !== undefined || q.snrMin !== undefined || q.sort !== undefined || q.dir !== undefined ||
    q.limit !== undefined || q.offset !== undefined;

  if (!active) {
    return { rows: findings, total, matched: total, limit: total, offset: 0, hasMore: false };
  }

  let out = findings.filter((f) => matches(f, q));
  const sortKey: FindingSort = q.sort ?? "recent";
  // audit-15 T4: this read as a per-sort-key rule (`sortKey === "recent" ? "desc" : "desc"`) but both arms were
  // identical -- a constant in a ternary's clothes. No sort key here wants an ASC default (newest / highest-first is
  // the wanted reading), so it is stated plainly as one. The caller's explicit `dir` still overrides it.
  const dir = q.dir ?? "desc";
  out = out.slice().sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    let c: number;
    if (typeof av === "string" || typeof bv === "string") c = String(av).localeCompare(String(bv));
    else c = av - bv;
    return dir === "asc" ? c : -c;
  });

  const matched = out.length;
  const offset = q.offset ?? 0;
  const limit = q.limit ?? DEFAULT_LIMIT;
  const rows = out.slice(offset, offset + limit);
  const hasMore = offset + rows.length < matched;
  return { rows, total, matched, limit, offset, hasMore };
}
