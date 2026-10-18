// The anchor-counts figure must be a picture OF the data, not a picture near it.
//
// A number inside an SVG <text> element carries the same authority as a number in a table and none of the same
// friction: nobody diffs a caption. So the committed panel is rebuilt here from the committed record, byte for byte,
// and the builder is required to REFUSE whenever the counters the site publishes do not follow from the rows the site
// publishes. Refusal is the point -- a figure that cannot be wrong cannot be checked either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAnchorFigure, deriveAnchorCounts, type AnchorSnapshot } from "../src/figures/anchorCountsFigure.ts";

const HERE = resolve(process.cwd());
const JSON_PATH = resolve(HERE, "reports", "anchor-counts.json");
const SVG_PATH = resolve(HERE, "web", "anchor-counts-figure.svg");

const committed = JSON.parse(readFileSync(JSON_PATH, "utf8")) as AnchorSnapshot;

/** A small snapshot with the arithmetic already worked out: 2 commitments, 1 of them still matching. */
function fixture(): AnchorSnapshot {
  return {
    measuredAt: "2026-10-18T00:00:00.000Z",
    source: { state: "https://example.invalid/api/state", ledger: "https://example.invalid/api/ledger" },
    stats: { bundlesAnchored: 1, ledgerAnchored: 2 },
    bundles: [
      { findingId: "F1", hash: "h1", solanaTx: "sig1" },
      { findingId: "F2", hash: "h2b" }, // re-derived: h2 was sealed, h2b is published, and the integrity sweep
      // already dropped the stamp that no longer covers it -- which is what makes the two counts agree with each
      // other in production, and what the third check below insists on.
      { findingId: "F3", hash: "h3" },
      { findingId: "F4", hash: "h4" },
    ],
    ledger: [
      { findingId: "F1", bundleHash: "h1", status: "anchored", signature: "sig1" },
      { findingId: "F2", bundleHash: "h2", status: "anchored", signature: "sig2" },
      { findingId: "F4", bundleHash: "h4", status: "anchored" }, // no signature: not a commitment
      { findingId: "F3", bundleHash: "h3", status: "failed", signature: "sig3" }, // failed: not a commitment
    ],
  };
}

test("the fixture's counts are the counts the builder reports", () => {
  const d = deriveAnchorCounts(fixture());
  assert.equal(d.committed, 2, "only anchored rows carrying a signature are commitments");
  assert.equal(d.stillMatching, 1, "F1 matches; F2's published hash moved on, so its seal no longer covers what is shown");
  assert.equal(d.superseded, 1);
  assert.equal(d.anchoredWithoutSignature, 1);
  assert.equal(d.stampedWithoutLedgerRow, 0);
});

test("the builder refuses to draw when a published counter does not follow from the rows", () => {
  const base = fixture();
  const worse = (over: Partial<AnchorSnapshot>): AnchorSnapshot => ({ ...base, ...over });
  assert.throws(
    () => deriveAnchorCounts(worse({ stats: { bundlesAnchored: 2, ledgerAnchored: 2 } })),
    /stats\.bundlesAnchored says 2 but 1 published bundles carry a stamp/,
    "a stamp count that disagrees with the bundles is a lie in the picture",
  );
  assert.throws(
    () => deriveAnchorCounts(worse({ stats: { bundlesAnchored: 1, ledgerAnchored: 9 } })),
    /stats\.ledgerAnchored says 9 but 2 ledger rows carry a landed commitment/,
    "and so is a total that disagrees with the ledger",
  );
  // Both counters individually right, but the two sets are not the two this pass defined: a stamped bundle with no
  // ledger row at all, and no commitment whose hash is the published one. The figure must not paper over that.
  const drifted = worse({ bundles: [{ findingId: "F9", hash: "h9", solanaTx: "sig9" }] });
  assert.throws(() => deriveAnchorCounts(drifted), /1 stamped bundles vs 0 commitments/);
});

test("the committed figure is the committed record, redrawn -- byte for byte", () => {
  const svg = buildAnchorFigure(committed);
  assert.equal(svg, readFileSync(SVG_PATH, "utf8"), "the shipped picture must be reproducible from the shipped data");
});

test("every number the committed figure prints is one the record re-derives", () => {
  const d = deriveAnchorCounts(committed);
  const svg = readFileSync(SVG_PATH, "utf8");
  assert.ok(svg.includes(`>${d.committed}</text>`), "the commitment total appears as derived");
  assert.ok(svg.includes(`>${d.stillMatching}</text>`), "the sealed-as-published count appears as derived");
  assert.ok(svg.includes(`${d.superseded} re-derived`), "and the superseded block is labelled with its own count");
  assert.equal(d.committed, committed.stats.ledgerAnchored);
  assert.equal(d.stillMatching, committed.stats.bundlesAnchored);
  assert.ok(d.committed >= d.stillMatching, "a commitment cannot stop existing while the published set grows");
});

test("the figure is English-only and says what it does not claim", () => {
  const svg = readFileSync(SVG_PATH, "utf8");
  assert.ok(!/[^\x00-\x7F]/.test(svg), "served content must be pure ASCII");
  assert.match(svg, /nothing gated, claimed or spent/);
  assert.doesNotMatch(svg, /discover|novel|unprecedented/i, "a count of transactions is not a claim about planets");
});

test("the drawing code stays offline and the CLI is reachable, so the check is repeatable", () => {
  const pure = readFileSync(resolve(HERE, "src", "figures", "anchorCountsFigure.ts"), "utf8");
  assert.doesNotMatch(pure, /node:fs|node:http|fetch\(/, "the builder must not touch the network or the disk");
  assert.doesNotMatch(pure, /new Date\(\)/, "or read a clock: the geometry may only use the snapshot's stated instant");

  const cli = readFileSync(resolve(HERE, "scripts", "anchor-counts-figure.ts"), "utf8");
  assert.match(cli, /from "\.\.\/src\/figures\/anchorCountsFigure\.ts"/, "the CLI draws with the shared builder, not its own copy");
  assert.match(cli, /--from-json/, "and supports an offline redraw, so a reviewer need not trust a live read");

  const pkg = JSON.parse(readFileSync(resolve(HERE, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["figure:anchor-counts"], "tsx scripts/anchor-counts-figure.ts", "npm run figure:anchor-counts is the one documented path");
});
