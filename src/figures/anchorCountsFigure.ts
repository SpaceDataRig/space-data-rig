/**
 * The anchor-counts figure, as a pure builder.
 *
 * WHY A MODULE AND NOT A SCRIPT. A picture is the least auditable form of a claim: a number drawn in a <text>
 * element looks exactly as authoritative as a number checked against data. So the geometry lives here, takes the
 * snapshot as an argument, touches no network and no clock, and REFUSES to draw when the published counters do not
 * follow from the rows -- which is the property tests/anchored-stats.test.ts cannot check, because it has no live
 * ledger. scripts/anchor-counts-figure.ts does the fetching and the writing, and a test can rebuild the committed
 * SVG from the committed JSON without the network, so the shipped picture is reproducible from the shipped data.
 *
 * WHAT IT SAYS. Two counts that were being published as one: how many results the rig has put on chain, and how
 * many of those the bytes still on the site actually match. The smaller one moves while nothing is un-anchored,
 * which is precisely why it was never a total.
 */

import { isCommittedLedgerRow } from "../core/anchor-verify.ts";

export interface AnchorSnapshotBundle {
  findingId: string;
  hash: string;
  createdAt?: string;
  solanaTx?: string;
}

export interface AnchorSnapshotLedgerRow {
  findingId: string;
  bundleHash: string;
  status: string;
  signature?: string;
  anchoredAt?: string;
}

export interface AnchorSnapshot {
  /** UTC instant the live state was read, taken from the snapshot file rather than from a clock in here. */
  measuredAt: string;
  source: { state: string; ledger: string };
  stats: { bundlesAnchored: number; ledgerAnchored: number };
  bundles: AnchorSnapshotBundle[];
  ledger: AnchorSnapshotLedgerRow[];
}

export interface AnchorDerived {
  committed: number;
  stillMatching: number;
  superseded: number;
  stampedBundles: number;
  /** Anchored rows that carry no signature: not commitments, and must not inflate the total. */
  anchoredWithoutSignature: number;
  /** Findings whose published bundle has no ledger row at all -- the mirror image of a superseded seal. */
  stampedWithoutLedgerRow: number;
}

const PALETTE = {
  bg: "#0b1020",
  fg: "#e6edf7",
  title: "#7dd3fc",
  good: "#4ade80",
  amber: "#fbbf24",
  dim: "#94a3b8",
  card: "#131a2e",
  grid: "#243049",
};

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Recompute both counts from the rows. Throws when the published numbers do not follow from the data. */
export function deriveAnchorCounts(snap: AnchorSnapshot): AnchorDerived {
  const committedRows = snap.ledger.filter(isCommittedLedgerRow);
  const publishedHash = new Map(snap.bundles.map((b) => [b.findingId, b.hash]));
  const stillMatching = committedRows.filter((e) => publishedHash.get(e.findingId) === e.bundleHash).length;
  const stampedBundles = snap.bundles.filter((b) => b.solanaTx).length;
  const anchoredWithoutSignature = snap.ledger.filter((e) => e.status === "anchored" && !e.signature).length;
  const stampedIds = new Set(snap.bundles.filter((b) => b.solanaTx).map((b) => b.findingId));
  const ledgerIds = new Set(committedRows.map((e) => e.findingId));
  const stampedWithoutLedgerRow = [...stampedIds].filter((id) => !ledgerIds.has(id)).length;

  // Every check below compares a number the site publishes against the rows the site publishes, so a figure can
  // never show a total the API disagrees with. If one trips, the honest output is an error, not a picture.
  if (snap.stats.ledgerAnchored !== committedRows.length) {
    throw new Error(`stats.ledgerAnchored says ${snap.stats.ledgerAnchored} but ${committedRows.length} ledger rows carry a landed commitment -- refusing to draw`);
  }
  if (snap.stats.bundlesAnchored !== stampedBundles) {
    throw new Error(`stats.bundlesAnchored says ${snap.stats.bundlesAnchored} but ${stampedBundles} published bundles carry a stamp -- refusing to draw`);
  }
  if (stampedBundles !== stillMatching) {
    throw new Error(`${stampedBundles} stamped bundles vs ${stillMatching} commitments whose hash is still the published one -- the two counts are not the two this pass defined, refusing to draw`);
  }
  return {
    committed: committedRows.length,
    stillMatching,
    superseded: committedRows.length - stillMatching,
    stampedBundles,
    anchoredWithoutSignature,
    stampedWithoutLedgerRow,
  };
}

/** Build the SVG. Deterministic given the snapshot: no clock, no network, no randomness. */
export function buildAnchorFigure(snap: AnchorSnapshot): string {
  const d = deriveAnchorCounts(snap);
  const W = 980;
  const H = 560;
  const C = PALETTE;
  const x0 = 70;
  const full = W - x0 - 60; // width of the "chain commitments" bar
  const unit = full / Math.max(d.committed, 1);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">`);
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  out.push(`<text x="${x0}" y="34" fill="${C.title}" font-size="21">How many results are on chain? Two questions, so two numbers.</text>`);
  out.push(`<text x="${x0}" y="58" fill="${C.dim}" font-size="13">Live rig, read at ${esc(snap.measuredAt)}. Recomputed from /api/ledger and the published bundles,</text>`);
  out.push(`<text x="${x0}" y="76" fill="${C.dim}" font-size="13">then compared against the two counters /api/state publishes; the figure refuses to draw if they disagree.</text>`);

  // Bar 1: the cumulative commitments.
  const y1 = 130;
  out.push(`<text x="${x0}" y="${y1 - 12}" fill="${C.fg}" font-size="14">chain commitments -- a transaction exists that anybody can look up</text>`);
  out.push(`<rect x="${x0}" y="${y1}" width="${d.committed * unit}" height="42" rx="6" fill="${C.good}" opacity="0.75"/>`);
  out.push(`<text x="${x0 + 12}" y="${y1 + 27}" fill="${C.bg}" font-size="18" font-weight="bold">${d.committed}</text>`);

  // Bar 2: the subset whose published bytes still match, drawn to the same scale.
  const y2 = 210;
  out.push(`<text x="${x0}" y="${y2 - 12}" fill="${C.fg}" font-size="14">sealed as published -- the bytes on the site NOW are the bytes that commitment covers</text>`);
  out.push(`<rect x="${x0}" y="${y2}" width="${d.stillMatching * unit}" height="42" rx="6" fill="${C.title}" opacity="0.85"/>`);
  out.push(`<text x="${x0 + 12}" y="${y2 + 27}" fill="${C.bg}" font-size="18" font-weight="bold">${d.stillMatching}</text>`);
  out.push(`<rect x="${x0 + d.stillMatching * unit}" y="${y2}" width="${d.superseded * unit}" height="42" rx="6" fill="${C.amber}" opacity="0.55"/>`);
  out.push(`<text x="${x0 + d.stillMatching * unit + 10}" y="${y2 + 27}" fill="${C.bg}" font-size="14" font-weight="bold">${d.superseded} re-derived</text>`);

  const y3 = 286;
  out.push(`<text x="${x0}" y="${y3}" fill="${C.amber}" font-size="13">The amber block is not missing work. Those ${d.superseded} records were sealed on chain, then measured again</text>`);
  out.push(`<text x="${x0}" y="${y3 + 18}" fill="${C.amber}" font-size="13">by the rotating survey: a bundle hash folds the run's timestamp, so the new bundle is a hash the chain</text>`);
  out.push(`<text x="${x0}" y="${y3 + 36}" fill="${C.amber}" font-size="13">never saw, and its stale stamp is dropped rather than inherited. The transaction stays; the count falls.</text>`);

  const boxY = 350;
  out.push(`<rect x="${x0}" y="${boxY}" width="${full}" height="150" rx="10" fill="${C.card}" stroke="${C.grid}"/>`);
  out.push(`<text x="${x0 + 18}" y="${boxY + 26}" fill="${C.fg}" font-size="14">Before this pass, one field fed a tile labelled "on-chain". It carried the smaller number.</text>`);
  out.push(`<text x="${x0 + 18}" y="${boxY + 52}" fill="${C.dim}" font-size="12">Both are published now, each with the question it answers, because a single total would be wrong</text>`);
  out.push(`<text x="${x0 + 18}" y="${boxY + 70}" fill="${C.dim}" font-size="12">in both directions: the small one understates what was committed, the big one overstates</text>`);
  out.push(`<text x="${x0 + 18}" y="${boxY + 88}" fill="${C.dim}" font-size="12">what a reader can verify against the record in front of them.</text>`);
  out.push(`<text x="${x0 + 18}" y="${boxY + 114}" fill="${C.dim}" font-size="12">Excluded from the total: ${d.anchoredWithoutSignature} anchored row(s) with no signature, ${d.stampedWithoutLedgerRow} stamped</text>`);
  out.push(`<text x="${x0 + 18}" y="${boxY + 132}" fill="${C.dim}" font-size="12">bundle(s) with no ledger row. A failed retry can no longer demote a landed row (mergeLedgerRow).</text>`);

  out.push(`<text x="${x0}" y="${H - 16}" fill="${C.dim}" font-size="12">Source: ${esc(snap.source.state)} and ${esc(snap.source.ledger)} | generator: scripts/anchor-counts-figure.ts | nothing gated, claimed or spent.</text>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
