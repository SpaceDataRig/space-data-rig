// Anchor-counts figure: the CLI that reads production, writes the record, and draws the panel.
//
// Split from the geometry on purpose (src/figures/anchorCountsFigure.ts): importing a script that reaches the
// network at load time means a test either triggers a live read or skips coverage, and this repository has already
// been audited into that trap with the deploy guard. So all the checks and all the text live in the pure module,
// and this file only fetches, persists and writes files.
//
// Usage:
//   npm run figure:anchor-counts                          # read production, write both artifacts
//   npm run figure:anchor-counts -- --from-json reports/anchor-counts.json   # redraw offline from the record
//
// The JSON it writes is the measurement: the counters as published, the rows they were computed from, and the
// instant they were read. A reader can re-derive both numbers by hand from those rows, and tests/anchor-counts-
// figure.test.ts rebuilds the committed SVG from the committed JSON and requires byte equality, so the picture
// cannot drift away from the data it is a picture of.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAnchorFigure, deriveAnchorCounts, type AnchorSnapshot } from "../src/figures/anchorCountsFigure.ts";

const STATE_URL = "https://spacedatarig.app/api/state";
const LEDGER_URL = "https://spacedatarig.app/api/ledger";
const JSON_OUT = resolve(process.cwd(), "reports", "anchor-counts.json");
const SVG_OUT = resolve(process.cwd(), "web", "anchor-counts-figure.svg");

function arg(name: string, dflt = ""): string {
  const argv = process.argv;
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

async function readLive(): Promise<AnchorSnapshot> {
  const [state, ledgerRes] = await Promise.all([
    fetch(STATE_URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${STATE_URL} -> HTTP ${r.status}`)))),
    fetch(LEDGER_URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${LEDGER_URL} -> HTTP ${r.status}`)))),
  ]);
  const stats = state?.stats;
  if (!stats || typeof stats.bundlesAnchored !== "number" || typeof stats.ledgerAnchored !== "number") {
    throw new Error("/api/state did not carry both anchor counters -- the deployed revision predates this pass");
  }
  if (!Array.isArray(state?.bundles) || !Array.isArray(ledgerRes?.ledger)) {
    throw new Error("missing bundles or ledger rows; refusing to draw a figure from half a read");
  }
  return {
    // The instant this read completed. /api/state carries no timestamp of its own, so the record states that it
    // was true when READ, and a redraw from the record reuses the stored instant instead of re-stamping the date --
    // which is what keeps the committed SVG byte-stable and the picture honest about its own age.
    measuredAt: new Date().toISOString(),
    source: { state: STATE_URL, ledger: LEDGER_URL },
    stats: { bundlesAnchored: stats.bundlesAnchored, ledgerAnchored: stats.ledgerAnchored },
    bundles: state.bundles,
    ledger: ledgerRes.ledger,
  };
}

const from = arg("from-json", "");
const snap = from
  ? (JSON.parse(readFileSync(resolve(from), "utf8")) as AnchorSnapshot)
  : await readLive();

const d = deriveAnchorCounts(snap); // runs every consistency check before anything is written
const svg = buildAnchorFigure(snap);

writeFileSync(SVG_OUT, svg, "utf8");
// The record is rewritten only from a live read; a redraw from the record must not re-stamp its own date.
if (!from) writeFileSync(JSON_OUT, JSON.stringify(snap, null, 2) + "\n", "utf8");

console.log(
  `[figure] commitments ${d.committed} | sealed as published ${d.stillMatching} | superseded ${d.superseded} | ` +
    `anchored-without-signature ${d.anchoredWithoutSignature} | stamped-without-ledger-row ${d.stampedWithoutLedgerRow}`,
);
console.log(`[figure] wrote ${SVG_OUT}${from ? " (redrawn from " + from + ", no live read)" : " and " + JSON_OUT}`);
