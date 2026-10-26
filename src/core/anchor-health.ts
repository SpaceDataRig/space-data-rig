// Round-21 audit defect 2: the on-chain anchor set and the board's CURRENT judgement can drift apart
// (a row is anchored while accepted, then a later pass downgrades it; the commitment is permanent), and
// until now that drift was only visible row-by-row -- there was no aggregate disclosure, so an external
// reader had to join /api/ledger to /api/findings by hand to learn that some anchored rows are no longer
// accepted. This pure helper turns (ledger, served rows) into exactly that aggregate: how many anchored
// rows are currently needs-more-data / rejected / label-conflicted / stand-in synthetic, and how many
// carry a planet letter the label-conflict predicate structurally cannot verify (round-21 defect 5).
//
// Pure + offline so BOTH runtimes (the edge DO route and the Node parity route) and the tests drive the
// SAME function; the routes only supply the inputs. It changes no verdict, no hash and no ledger row --
// it is a read-only disclosure, the "aggregate honesty" layer the twentieth-round audit asked for.

/** A served finding row (the findingView projection) as far as the aggregate needs it. */
export type AnchorHealthRow = {
  id: string;
  verdict: string;
  bundleHash?: string;
  labelConflictsWithKnown?: boolean;
  labelConflictStatus?: string;
  dataTier?: string;
};

/** A ledger row as far as the aggregate needs it. */
export type AnchorHealthLedgerRow = {
  findingId: string;
  bundleHash?: string;
  status?: string;
  signature?: string;
  slot?: number;
};

export type AnchorHealthRowReport = {
  findingId: string;
  verdict: string | null;
  bundleHashMatch: boolean;
  labelConflictsWithKnown: boolean;
  labelConflictStatus: string;
  dataTier: string | null;
  standIn: boolean;
  unverifiableLetter: boolean;
  signature: string;
  slot: number | null;
};

export type AnchorHealthReport = {
  asOf: string;
  anchored: number;
  bundleHashMatch: number;
  needsMoreData: number;
  rejected: number;
  conflict: number;
  standIn: number;
  unverifiableLetter: number;
  missingRow: number;
  rows: AnchorHealthRowReport[];
};

/** stand-in detection on a served row: the structured tier field is authoritative. */
export function rowIsStandIn(r: AnchorHealthRow): boolean {
  return r.dataTier === "stand-in-synthetic";
}

/**
 * Aggregate the health of every anchored ledger row against the row's CURRENT served state.
 * Only `status === "anchored"` ledger rows count; failed rows are not on-chain commitments.
 */
export function anchorHealth(
  ledger: AnchorHealthLedgerRow[],
  rows: AnchorHealthRow[],
  asOf: string,
): AnchorHealthReport {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rep: AnchorHealthReport = {
    asOf,
    anchored: 0,
    bundleHashMatch: 0,
    needsMoreData: 0,
    rejected: 0,
    conflict: 0,
    standIn: 0,
    unverifiableLetter: 0,
    missingRow: 0,
    rows: [],
  };
  for (const e of ledger) {
    if (e.status !== "anchored") continue;
    rep.anchored += 1;
    const row = byId.get(e.findingId);
    if (!row) {
      rep.missingRow += 1;
      rep.rows.push({
        findingId: e.findingId, verdict: null, bundleHashMatch: false,
        labelConflictsWithKnown: false, labelConflictStatus: "missing-row",
        dataTier: null, standIn: false, unverifiableLetter: false,
        signature: e.signature ?? "", slot: e.slot ?? null,
      });
      continue;
    }
    const match = Boolean(row.bundleHash && e.bundleHash && row.bundleHash === e.bundleHash);
    const conflict = row.labelConflictsWithKnown === true;
    const standIn = rowIsStandIn(row);
    const unverifiable = row.labelConflictStatus === "unverifiable";
    if (match) rep.bundleHashMatch += 1;
    if (row.verdict === "needs-more-data") rep.needsMoreData += 1;
    if (row.verdict === "rejected") rep.rejected += 1;
    if (conflict) rep.conflict += 1;
    if (standIn) rep.standIn += 1;
    if (unverifiable) rep.unverifiableLetter += 1;
    rep.rows.push({
      findingId: e.findingId,
      verdict: row.verdict,
      bundleHashMatch: match,
      labelConflictsWithKnown: conflict,
      labelConflictStatus: row.labelConflictStatus ?? (conflict ? "conflict" : "clear"),
      dataTier: row.dataTier ?? null,
      standIn,
      unverifiableLetter: unverifiable,
      signature: e.signature ?? "",
      slot: e.slot ?? null,
    });
  }
  return rep;
}
