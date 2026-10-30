// ROUND-30 (R30, audit of the auditor, fourth round): HANDOFF section 13 states the corpus ledger as live fact
// (`total / stamped / verified / fullyVerified / unattested / stale`), and the next reader trusts it -- yet
// tests/handoff-freshness.test.ts holds that section only to its DATE, its named shas' reachability, and the
// awaiting-deploy marker. NOTHING checked that the NUMBERS it prints equal the index the site actually serves. The
// exact failure class R27/R28/R29 kept finding: a checker that agrees because it never re-measures. A future round
// that lifts a report (rebuilds the index to verified=37) and forgets to edit section 13 would publish a stale count
// with a green suite. This closes that: section 13's leading ledger line is recomputed against the served index on
// every test run, and the index's own freshness summary is recomputed against its rows, so neither can drift from the
// other silently. No number is hardcoded -- the assertion is equality between two independent measurements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const INDEX = resolve(process.cwd(), "web", "reports", "index.json");
const HANDOFF = resolve(process.cwd(), "HANDOFF.md");

type Ledger = {
  total: number;
  stamped: number;
  verified: number;
  fullyVerified: number;
  unattested: number;
  stale: string;
};

/** Read the section-13 slice (its header up to the next level-2 `## ` header), collapsing newlines so a ledger
 *  figure that wraps across two source lines is matched as one. */
function section13(): string {
  const text = readFileSync(HANDOFF, "utf8");
  const start = text.indexOf("## 13.");
  assert.ok(start >= 0, "HANDOFF.md must have a '## 13.' section");
  const rest = text.slice(start);
  const boundary = rest.indexOf("\n## ", 5); // next level-2 header (skip the section's own header)
  const slice = boundary < 0 ? rest : rest.slice(0, boundary);
  return slice.replace(/\s+/g, " ");
}

/** Every `total N / stamped M / verified V / fullyVerified F / unattested U / stale [...]` figure in the section. */
function ledgerLines(section: string): Ledger[] {
  const re = /total (\d+) \/ stamped (\d+) \/ verified (\d+) \/ fullyVerified (\d+) \/ unattested (\d+) \/ stale (\[[^\]]*\])/g;
  const found: Ledger[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    found.push({
      total: +m[1],
      stamped: +m[2],
      verified: +m[3],
      fullyVerified: +m[4],
      unattested: +m[5],
      stale: m[6].replace(/\s+/g, "").trim(),
    });
  }
  return found;
}

const normStale = (a: unknown): string => "[" + (Array.isArray(a) ? a.slice().sort().join(",") : "") + "]";

test("section 13 states the served index's ledger numbers -- not a stale count the suite would otherwise never see", () => {
  assert.ok(existsSync(INDEX), "web/reports/index.json must be built (run p86) for this check");
  const idx = JSON.parse(readFileSync(INDEX, "utf8")) as { freshness: Ledger & { stale: unknown[] } };
  const published = idx.freshness;
  const asLedger: Ledger = {
    total: published.total,
    stamped: published.stamped,
    verified: published.verified,
    fullyVerified: published.fullyVerified,
    unattested: published.unattested,
    stale: normStale(published.stale),
  };
  const stated = ledgerLines(section13());
  assert.ok(stated.length >= 1, "section 13 carries no machine-readable `total / stamped / verified ...` ledger line");
  const match = stated.find((l) =>
    l.total === asLedger.total &&
    l.stamped === asLedger.stamped &&
    l.verified === asLedger.verified &&
    l.fullyVerified === asLedger.fullyVerified &&
    l.unattested === asLedger.unattested &&
    l.stale === asLedger.stale,
  );
  assert.ok(
    match,
    `section 13 does not state the served ledger ${JSON.stringify(asLedger)}; it only says ${JSON.stringify(stated)} -- ` +
      `the index moved and the handoff was not updated (or vice versa).`,
  );
});

test("the served index's freshness summary equals a recount from its own rows -- the ledger's source of truth is self-consistent", () => {
  assert.ok(existsSync(INDEX), "web/reports/index.json must be built (run p86) for this check");
  const idx = JSON.parse(readFileSync(INDEX, "utf8")) as {
    reports: { stamped: boolean; verified: boolean }[];
    freshness: { total: number; stamped: number; verified: number; fullyVerified: number; unattested: number; stale: unknown[] };
  };
  const rows = idx.reports;
  const f = idx.freshness;
  assert.equal(f.total, rows.length, "freshness.total must equal the number of served rows");
  assert.equal(f.stamped, rows.filter((r) => r.stamped).length, "freshness.stamped must equal the recount of stamped rows");
  assert.equal(f.verified, rows.filter((r) => r.verified).length, "freshness.verified must equal the recount of verified rows");
  assert.ok(f.fullyVerified <= f.verified, "fullyVerified cannot exceed verified");
  assert.ok(normStale(f.stale) === "[]", `a verified corpus must publish an empty stale list, got ${JSON.stringify(f.stale)}`);
});
