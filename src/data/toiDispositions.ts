// data-fetch seat: ExoFOP-TESS public TOI table with community DISPOSITION labels -- the labelled
// negative class the P0 true-veto acceptance test needs, reachable WITHOUT a token.
//
// WHY THIS EXISTS. P52 concluded the blend/FP labels were "token-gated", but it only tried the wrong
// endpoint (api/planets/). The public TOI-table export
//   https://exofop.ipac.caltech.edu/tess/download_toi.php?output=csv&Show=All
// is anonymous (200, ~3.8 MB, ~8k rows) and carries two disposition columns -- `TESS Disposition`
// (EB, KP, CP, PC, ...) and `TFOPWG Disposition` (FP, FA, KP, CP, APC, PC, ...) -- on every row, plus
// a full ephemeris (Period, Epoch BJD, Duration, Depth) and the observing Sector(s). That is exactly a
// labelled positive (known planet) vs negative (false positive / eclipsing binary) population with
// positions, so a veto tool's TRUE catch-rate -- not just its over-kill rate -- becomes measurable.
//
// LABEL POLICY (conservative). We only assert the two unambiguous classes and leave the rest
// "other" so we never mis-label a candidate:
//   known-planet  : either disposition column == "KP"  (a confirmed planet -- must be KEPT)
//   blend-or-fp   : TFOPWG == "FP" (False Positive) or TESS == "EB" (Eclipsing Binary)  (should be VETOED)
// Parsed with a real RFC-4180 reader (several fields contain quoted commas) and sexagesimal RA/Dec
// ("02:31:51.31"). Runtime-agnostic (fetch only); returns [] if the network is unavailable so callers
// report "unavailable" rather than fabricate labels. Research-only: no verdict/bundle/money path.

export interface ToiRecord {
  tic: number;
  toi: string;
  ra: number; // degrees
  dec: number; // degrees
  tessMag: number;
  periodDays: number;
  epochBjd: number;
  durationHours: number;
  depthPpm: number;
  starRadiusSolar: number;
  starMassSolar: number;
  sectors: number[];
  tessDisposition: string;
  tfopwgDisposition: string;
  /** "known-planet" | "blend-or-fp" | "other" (see LABEL POLICY above). */
  label: "known-planet" | "blend-or-fp" | "other";
}

const TOI_CSV_URL = "https://exofop.ipac.caltech.edu/tess/download_toi.php?output=csv&Show=All";
// Some WAFs 403 the default `node` user-agent; send a browser UA (same convention as exoplanetArchive).
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Split CSV text into records, honouring double-quoted fields that contain commas or newlines. */
export function parseCsvRecords(text: string): string[][] {
  const recs: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") { /* skip */ }
    else if (ch === "\n") { row.push(field); recs.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); recs.push(row); }
  return recs.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

/** Parse a sexagesimal angle like "02:31:51.31" or "+28:57:57.64"/"-12:00:00" to decimal degrees. */
export function parseSexagesimal(value: string): number {
  const s = String(value).trim();
  if (!s) return NaN;
  const sign = s.startsWith("-") ? -1 : 1;
  const parts = s.replace(/^[+-]/, "").split(":").map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  const [deg = 0, min = 0, sec = 0] = parts;
  return sign * (deg + min / 60 + sec / 3600);
}

/** RA is sexagesimal HOURS (right ascension is measured in h m s, not degrees): "02:31:51" is 2.53h =
 *  37.96 deg. We convert hours -> degrees with x15 and require the result to land in [0,360). Passing the raw
 *  hour value through as degrees (the pre-x15 mistake) collapses every host into the 0-24 deg strip and points
 *  every downstream cone / cross-match at the wrong sky, so the x15 is load-bearing, not cosmetic. */
function parseRa(value: string): number {
  const hours = parseSexagesimal(value);
  if (!Number.isFinite(hours) || hours < 0 || hours >= 24) return NaN;
  return hours * 15;
}

/** Classify one row's two disposition strings into our conservative label. */
export function classifyDisposition(tess: string, tfopwg: string): ToiRecord["label"] {
  const t = (tess ?? "").trim().toUpperCase();
  const f = (tfopwg ?? "").trim().toUpperCase();
  if (t === "KP" || f === "KP") return "known-planet";
  if (f === "FP" || t === "EB") return "blend-or-fp";
  return "other";
}

/** Parse the public TOI CSV text into typed records (header-name based, robust to column order). */
export function parseToiTable(text: string): ToiRecord[] {
  const recs = parseCsvRecords(text);
  if (recs.length < 2) return [];
  const hdr = recs[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => hdr.indexOf(name.toLowerCase());
  const i = {
    tic: col("tic id"), toi: col("toi"), ra: col("ra"), dec: col("dec"),
    tmag: col("tess mag"), per: col("period (days)"), ep: col("epoch (bjd)"),
    dur: col("duration (hours)"), depth: col("depth (ppm)"),
    srad: col("stellar radius (r_sun)"), smass: col("stellar mass (m_sun)"),
    sectors: col("sectors"), tess: col("tess disposition"), tfop: col("tfopwg disposition"),
  };
  // Fail CLOSED if the row-key column is renamed/removed upstream. Without it every tic would coerce
  // Number("")=0 and we would silently emit garbage rows all filed under star "0" -- the exact brittle
  // degradation a schema-contract test must catch. An empty result tells callers the source is unavailable.
  if (i.tic < 0) return [];
  const get = (c: string[], k: number) => (k >= 0 ? (c[k] ?? "").trim() : "");
  const out: ToiRecord[] = [];
  for (let r = 1; r < recs.length; r++) {
    const c = recs[r];
    const tic = Number(get(c, i.tic));
    if (!Number.isFinite(tic)) continue;
    const ra = parseRa(get(c, i.ra));
    const dec = parseSexagesimal(get(c, i.dec));
    const sectors = get(c, i.sectors).split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
    out.push({
      tic,
      toi: get(c, i.toi),
      ra, dec,
      tessMag: Number(get(c, i.tmag)),
      periodDays: Number(get(c, i.per)),
      epochBjd: Number(get(c, i.ep)),
      durationHours: Number(get(c, i.dur)),
      depthPpm: Number(get(c, i.depth)),
      starRadiusSolar: Number(get(c, i.srad)),
      starMassSolar: Number(get(c, i.smass)),
      sectors,
      tessDisposition: get(c, i.tess),
      tfopwgDisposition: get(c, i.tfop),
      label: classifyDisposition(get(c, i.tess), get(c, i.tfop)),
    });
  }
  return out;
}

export interface ToiFetchOptions { timeoutMs?: number; }

/** Fetch + parse the anonymous public TOI table. Returns [] on any failure (callers must not fabricate). */
export async function fetchToiTable(o: ToiFetchOptions = {}): Promise<ToiRecord[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 45000);
    try {
      const r = await fetch(TOI_CSV_URL, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "text/plain" } });
      if (!r.ok) throw new Error(`TOI HTTP ${r.status}`);
      const text = await r.text();
      const rows = parseToiTable(text);
      if (rows.length === 0) throw new Error("empty/unparseable TOI table");
      return rows;
    } catch {
      if (attempt === 2) return [];
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

/** True if the row is a usable labelled case: finite position, a positive period, and a BJD epoch. */
export function isPlaceable(rec: ToiRecord): boolean {
  return Number.isFinite(rec.ra) && Number.isFinite(rec.dec) &&
    Number.isFinite(rec.periodDays) && rec.periodDays > 0 &&
    Number.isFinite(rec.epochBjd) && rec.epochBjd > 2450000 && rec.epochBjd < 2470000;
}

/** Labelled negatives (blend / false positive / eclipsing binary) that carry an ephemeris. */
export function labelledNegatives(records: ToiRecord[]): ToiRecord[] {
  return records.filter((r) => r.label === "blend-or-fp" && isPlaceable(r));
}

/** Labelled positives (known planets) that carry an ephemeris -- the veto must NOT fire on these. */
export function confirmedPositives(records: ToiRecord[]): ToiRecord[] {
  return records.filter((r) => r.label === "known-planet" && isPlaceable(r));
}
