// M4 milestone figure -- CLI: assemble the record from committed artifacts plus the live counters, then draw.
//
// Why it reads files instead of accepting numbers on the command line: the picture is a claim about measurements that
// exist in the repository and in production. If the drawer could be handed a figure, the committed SVG would no longer
// be reproducible from anything anybody can check. So every value is pulled from reports/p88, p89, p90, p91 and
// /api/state, persisted as reports/m4-milestone.json, and the SVG is generated from THAT -- and
// tests/m4-milestone-figure.test.ts rebuilds the committed SVG from the committed record byte for byte.
//
// Refusals, because a milestone figure with a silent zero is worse than no figure:
//   - a source artifact missing or short of the fields the panels read -> throw, naming the field;
//   - /api/state without the blind pair (blindHeld AND blindCandidates) -> throw: the deployed revision predates the
//     definition split, so the picture would be drawing a counter production does not publish.
//
// Usage:
//   npm run figure:m4                              # read live + artifacts, write JSON and SVG
//   npm run figure:m4 -- --from-json reports/m4-milestone.json   # redraw offline from the record
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildM4Figure, type M4Record } from "../src/figures/m4MilestoneFigure.ts";
import { measurePassSpans, median, DEFAULT_WINDOW_POLICY } from "../src/deploy/deployWindow.ts";

const STATE_URL = "https://spacedatarig.app/api/state";
const JSON_OUT = resolve(process.cwd(), "reports", "m4-milestone.json");
const SVG_OUT = resolve(process.cwd(), "web", "m4-milestone-figure.svg");
const CRON_EVERY_MIN = DEFAULT_WINDOW_POLICY.cronEverySec / 60;

function arg(name: string, dflt = ""): string {
  const argv = process.argv;
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

/** Read a committed report JSON and pull the fields, refusing to substitute defaults for missing ones. */
function pick<T>(path: string, map: (j: any) => T, label: string): T {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`${label}: ${path} is not committed -- nothing to draw from`);
  const out = map(JSON.parse(readFileSync(abs, "utf8")));
  return out;
}

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`m4 record: ${what} is not a finite number (got ${JSON.stringify(v)})`);
  return v;
};

async function assemble(): Promise<M4Record> {
  const p88 = pick("reports/p88-independent-corroboration.json", (j) => ({
    n: num(j?.metrics?.n, "p88 metrics.n"),
    withGaiaData: num(j?.population?.withGaiaData, "p88 population.withGaiaData"),
    periodMatched: num(j?.population?.periodMatched, "p88 population.periodMatched"),
    vetoPower: num(j?.metrics?.vetoPower, "p88 metrics.vetoPower"),
  }), "p88");

  const p89 = pick("reports/p89-multiepoch-di.json", (j) => ({
    n: num(j?.metrics?.n, "p89 metrics.n"),
    falseVeto: num(j?.metrics?.cm?.falseVeto, "p89 cm.falseVeto"),
    vetoPower: num(j?.metrics?.vetoPower, "p89 metrics.vetoPower"),
  }), "p89");

  const p90 = pick("reports/p90-depth-estimators.json", (j) => ({
    matched: num(j?.meta?.matched, "p90 meta.matched"),
    publishedMedianSignedErrPct: num(j?.meta?.summary?.publishedMedianSignedErrPct, "p90 summary.publishedMedianSignedErrPct"),
    boxMedianSignedErrPct: num(j?.meta?.summary?.boxMedianSignedErrPct, "p90 summary.boxMedianSignedErrPct"),
  }), "p90");

  const p91 = pick("reports/p91-claim-provenance.json", (j) => {
    const rows = Array.isArray(j?.reviews) ? j.reviews : [];
    if (!rows.length) throw new Error("p91: the report carries no reviews");
    const cs = j?.controlsSummary ?? {};
    const real = rows.find((r: any) => r.kind === "real-claim-under-review") ?? rows[0];
    return {
      rows: num(rows.length, "p91 rows"),
      controls: num(cs.withExpectations, "p91 controlsSummary.withExpectations"),
      controlsMet: num(cs.passed, "p91 controlsSummary.passed"),
      axes: Object.keys(j?.axes ?? {}),
      verdict: String(real?.verdict?.summary ?? "no summary"),
    };
  }, "p91");

  const state = await fetch(STATE_URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${STATE_URL} -> HTTP ${r.status}`)))) as {
    stats?: Record<string, number>; findings?: Array<{ createdAt?: string }>;
  };
  const s = state?.stats;
  if (!s) throw new Error("/api/state carried no stats");
  for (const k of ["bundlesAnchored", "ledgerAnchored", "blindHeld", "blindCandidates", "surveyPass", "distinctHosts"]) {
    if (typeof s[k] !== "number") {
      throw new Error(`/api/state is missing stats.${k} -- the deployed revision predates the definition layer, so this figure cannot claim production publishes it`);
    }
  }

  const { spans, idleGapsSec } = measurePassSpans((state.findings ?? []).map((f) => Date.parse(String(f.createdAt ?? ""))), DEFAULT_WINDOW_POLICY);
  const full = spans.filter((x) => x.rows >= 6);
  if (!full.length) throw new Error("no full pass (6+ rows) in the live catalog -- cadence would be invented");

  return {
    schema: "sdr-m4-milestone/1",
    measuredAt: new Date().toISOString(),
    source: { state: STATE_URL, p88: "reports/p88-independent-corroboration.json", p89: "reports/p89-multiepoch-di.json", p90: "reports/p90-depth-estimators.json", p91: "reports/p91-claim-provenance.json" },
    p88,
    p89,
    p90,
    p91,
    publicCounters: {
      bundlesAnchored: s.bundlesAnchored,
      ledgerAnchored: s.ledgerAnchored,
      blindHeld: s.blindHeld,
      blindCandidates: s.blindCandidates,
      surveyPassClaimed: s.surveyPass,
      distinctHosts: s.distinctHosts,
    },
    cadence: {
      passes: spans.length,
      fullPassSpanMedianSec: num(median(full.map((x) => x.spanSec)), "cadence full-pass median"),
      idleMedianSec: num(median(idleGapsSec.filter((g) => g > 0)), "cadence idle median"),
      cronEveryMin: CRON_EVERY_MIN,
    },
  };
}

const from = arg("from-json", "");
const rec: M4Record = from ? (JSON.parse(readFileSync(resolve(from), "utf8")) as M4Record) : await assemble();
const svg = buildM4Figure(rec);
if (!from) writeFileSync(JSON_OUT, JSON.stringify(rec, null, 2) + "\n", "utf8");
writeFileSync(SVG_OUT, svg, "utf8");
console.log(`m4: ${svg.length} bytes -> ${SVG_OUT}${from ? ` (redrawn from ${from})` : `; record -> ${JSON_OUT}`}`);
console.log(`panels: p88 ${rec.p88.withGaiaData}/${rec.p88.n}, p89 n=${rec.p89.n}, p90 ${rec.p90.publishedMedianSignedErrPct.toFixed(1)}%, p91 ${rec.p91.controlsMet}/${rec.p91.controls}, blind ${rec.publicCounters.blindHeld}/${rec.publicCounters.blindCandidates}`);
console.log("VERDICT: M4-FIGURE-WRITTEN");
