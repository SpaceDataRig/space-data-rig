/**
 * M4 MILESTONE FIGURE -- the geometry and the wording, as pure functions over a measurement record.
 *
 * WHAT THE PICTURE IS FOR. Five passes of audit work have produced a pile of verdicts, and a reader of the feed gets
 * them one tweet at a time with no way to see the shape: which levers measured OUT, which measured NOTHING, and where
 * the rig stopped claiming more than its instruments can say. This figure is that shape in one panel -- four
 * measurements and the layer of public definitions that came out of auditing them.
 *
 * THE HONESTY RULE THAT SHAPES THE CODE. Every number on the picture is read out of a committed artifact
 * (reports/p88, p89, p90, p91) or out of the live counters (reports/m4-milestone.json), never typed into the drawer.
 * `tests/m4-milestone-figure.test.ts` rebuilds the committed SVG from the committed record and requires BYTE
 * equality, so the picture cannot drift away from the data it is a picture of, and a figure with an invented number
 * cannot be produced at all -- the record has nowhere to put it.
 *
 * Wording stays flat and stated with its basis: this project has been audited, repeatedly, for sentences that read
 * better than they mean.
 */

/** The measurement record the figure draws from. Produced by scripts/m4-milestone-figure.ts. */
export interface M4Record {
  schema: "sdr-m4-milestone/1";
  measuredAt: string;
  source: Record<string, string>;
  /** P88 -- independent-instrument COVERAGE of the labelled set (Gaia DR3 TAP). */
  p88: { n: number; withGaiaData: number; periodMatched: number; vetoPower: number };
  /** P89 -- multi-epoch PSF double-difference on the same labels. */
  p89: { n: number; falseVeto: number; vetoPower: number };
  /** P90 -- which depth estimator the rig publishes, measured against a reference neither saw. */
  p90: { matched: number; publishedMedianSignedErrPct: number; boxMedianSignedErrPct: number };
  /** P91 -- provenance review of a public claim: the axes it graded and whether the controls held. */
  p91: { rows: number; controls: number; controlsMet: number; axes: string[]; verdict: string };
  /** The definition layer, read from the live counters at capture time. */
  publicCounters: {
    bundlesAnchored: number;
    ledgerAnchored: number;
    blindHeld: number;
    blindCandidates: number;
    surveyPassClaimed: number;
    distinctHosts: number;
  };
  /** Cadence MEASURED from the recorded finding timestamps, not asserted. */
  cadence: { passes: number; fullPassSpanMedianSec: number; idleMedianSec: number; cronEveryMin: number };
}

export interface Panel {
  key: string;
  title: string;
  /** The headline figure, already formatted with its unit. */
  value: string;
  /** One line of basis: what was measured, on how many, and what it does NOT say. */
  basis: string;
  /** Tone drives the colour band: measured / null-result / correction. */
  tone: "good" | "flat" | "warn";
}

const pct = (x: number): string => `${x > 0 ? "+" : ""}${x.toFixed(1)}%`;

/**
 * The five panels, in a fixed order so two runs over the same record draw the same picture. A panel whose numbers
 * are absent from the record throws rather than drawing a placeholder -- a silent zero in a milestone figure is
 * exactly the "verified" vs "stamped" confusion this repo has already been audited for.
 */
export function buildPanels(rec: M4Record): Panel[] {
  // Every number a panel PRINTS is checked, not just the ones that happen to be indexed. A hole in the record must
  // stop the drawing: an `undefined` interpolated into a caption reads as a measurement, which is the exact confusion
  // between "this value is zero" and "nobody looked" that this repository keeps being audited for.
  const need = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`m4 record is missing ${what}; refusing to draw a milestone figure with an invented number`);
    return v;
  };
  const p88 = { n: need(rec.p88?.n, "p88.n"), withGaiaData: need(rec.p88?.withGaiaData, "p88.withGaiaData"), periodMatched: need(rec.p88?.periodMatched, "p88.periodMatched"), vetoPower: need(rec.p88?.vetoPower, "p88.vetoPower") };
  const p89 = { n: need(rec.p89?.n, "p89.n"), falseVeto: need(rec.p89?.falseVeto, "p89.falseVeto"), vetoPower: need(rec.p89?.vetoPower, "p89.vetoPower") };
  const p90 = {
    matched: need(rec.p90?.matched, "p90.matched"),
    publishedMedianSignedErrPct: need(rec.p90?.publishedMedianSignedErrPct, "p90.publishedMedianSignedErrPct"),
    boxMedianSignedErrPct: need(rec.p90?.boxMedianSignedErrPct, "p90.boxMedianSignedErrPct"),
  };
  const p91 = { rows: need(rec.p91?.rows, "p91.rows"), controls: need(rec.p91?.controls, "p91.controls"), controlsMet: need(rec.p91?.controlsMet, "p91.controlsMet") };
  const counters = {
    bundlesAnchored: need(rec.publicCounters?.bundlesAnchored, "publicCounters.bundlesAnchored"),
    ledgerAnchored: need(rec.publicCounters?.ledgerAnchored, "publicCounters.ledgerAnchored"),
    blindHeld: need(rec.publicCounters?.blindHeld, "publicCounters.blindHeld"),
    blindCandidates: need(rec.publicCounters?.blindCandidates, "publicCounters.blindCandidates"),
    surveyPassClaimed: need(rec.publicCounters?.surveyPassClaimed, "publicCounters.surveyPassClaimed"),
    distinctHosts: need(rec.publicCounters?.distinctHosts, "publicCounters.distinctHosts"),
  };
  const cadence = {
    passes: need(rec.cadence?.passes, "cadence.passes"),
    fullPassSpanMedianSec: need(rec.cadence?.fullPassSpanMedianSec, "cadence.fullPassSpanMedianSec"),
    idleMedianSec: need(rec.cadence?.idleMedianSec, "cadence.idleMedianSec"),
    cronEveryMin: need(rec.cadence?.cronEveryMin, "cadence.cronEveryMin"),
  };
  if (!Array.isArray(rec.p91?.axes)) throw new Error("m4 record is missing p91.axes; the panel would print 'undefined' where the axis list belongs");
  if (typeof rec.p91?.verdict !== "string" || !rec.p91.verdict) throw new Error("m4 record is missing p91.verdict");
  if (counters.blindHeld > counters.blindCandidates) throw new Error(`held (${counters.blindHeld}) cannot exceed assessed (${counters.blindCandidates}) -- the two runtimes disagree, go fix the count before drawing it`);

  return [
    {
      key: "p88",
      title: "Independent coverage (Gaia DR3)",
      value: `${p88.withGaiaData}/${p88.n} covered`,
      basis:
        `period matched: ${p88.periodMatched} -- so this is instrument COVERAGE, not a Gaia-vs-TESS crossmatch; ` +
        `veto power ${p88.vetoPower.toFixed(2)} on ${p88.n} labelled rows`,
      tone: p88.periodMatched === 0 ? "warn" : "flat",
    },
    {
      key: "p89",
      title: "Multi-epoch PSF double-difference",
      value: `${p89.n} curves`,
      basis: `veto power ${p89.vetoPower.toFixed(2)}, false vetoes ${p89.falseVeto} -- localization did not separate blends from planets at this depth`,
      tone: p89.vetoPower === 0 ? "warn" : "flat",
    },
    {
      key: "p90",
      title: "Which depth we publish",
      value: `${pct(p90.publishedMedianSignedErrPct)} published`,
      basis:
        `vs the box statistic at ${pct(p90.boxMedianSignedErrPct)} on ${p90.matched} injections against a reference ` +
        `neither estimator saw -- the rig publishes the estimator that is honest about its own significance`,
      tone: Math.abs(p90.boxMedianSignedErrPct) > Math.abs(p90.publishedMedianSignedErrPct) ? "good" : "flat",
    },
    {
      key: "p91",
      title: "Claim provenance review",
      value: `${p91.controlsMet}/${p91.controls} controls met`,
      basis: `${p91.rows} rows graded on ${rec.p91.axes.length} axes (${rec.p91.axes.join(", ")}); verdict: ${rec.p91.verdict}`,
      tone: p91.controlsMet === p91.controls ? "good" : "warn",
    },
    {
      key: "counters",
      title: "The definition layer",
      value: `${counters.blindHeld}/${counters.blindCandidates} blind held/assessed`,
      basis:
        `one phrase, one rule across board and feed; anchors are two counts (${counters.bundlesAnchored} published-bytes, ` +
        `${counters.ledgerAnchored} commitments); ${counters.surveyPassClaimed} passes CLAIMED over ${counters.distinctHosts} hosts with results; ` +
        `cadence measured: ${cadence.fullPassSpanMedianSec}s per full pass inside a ${cadence.cronEveryMin}min cron, ${cadence.idleMedianSec}s idle`,
      tone: "good",
    },
  ];
}

/* --------------------------------------------------------------------- drawing --------------------------- */

const W = 1100;
const ROW_H = 96;
const PAD = 24;
const HEAD = 64;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Split a basis line so it fits the panel width without clipping words. */
function wrap(text: string, max: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur.trim());
  return lines;
}

const TONE_COLOR: Record<Panel["tone"], string> = { good: "#2e7d32", flat: "#455a64", warn: "#b26a00" };

/** One panel: title, headline number, and the basis that qualifies the number. */
function panelSvg(p: Panel, y: number): string {
  const lines = wrap(p.basis, 118);
  const body = lines
    .map((l, i) => `    <text x="${PAD + 4}" y="${y + 62 + i * 16}" font-size="13" fill="#37474f">${esc(l)}</text>`)
    .join("\n");
  return [
    `  <g>`,
    `    <rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${ROW_H - 12}" fill="#ffffff" stroke="#cfd8dc"/>`,
    `    <rect x="${PAD}" y="${y}" width="6" height="${ROW_H - 12}" fill="${TONE_COLOR[p.tone]}"/>`,
    `    <text x="${PAD + 16}" y="${y + 24}" font-size="15" font-weight="bold" fill="#263238">${esc(p.title)}</text>`,
    `    <text x="${W - PAD - 16}" y="${y + 24}" font-size="15" font-weight="bold" text-anchor="end" fill="${TONE_COLOR[p.tone]}">${esc(p.value)}</text>`,
    body,
    `  </g>`,
  ].join("\n");
}

/**
 * Draw the milestone panel. `measuredAt` is carried from the record rather than generated, so re-running the
 * redraw from the committed JSON produces the SAME bytes -- a figure whose date silently updates is a figure that
 * claims to be current when it is a historical snapshot.
 */
export function buildM4Figure(rec: M4Record): string {
  const panels = buildPanels(rec);
  const height = HEAD + panels.length * ROW_H + PAD;
  const rows = panels.map((p, i) => panelSvg(p, HEAD + i * ROW_H)).join("\n");
  const subtitle = `measured ${rec.measuredAt}  |  drawn from reports/p88, p89, p90, p91 and the live counters in reports/m4-milestone.json`;
  const sub = wrap(subtitle, 138).map((l, i) => `  <text x="${PAD}" y="${38 + i * 15}" font-size="12" fill="#546e7a">${esc(l)}</text>`).join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="DejaVu Sans, Arial, sans-serif">`,
    `  <rect width="${W}" height="${height}" fill="#eceff1"/>`,
    `  <text x="${PAD}" y="26" font-size="20" font-weight="bold" fill="#102027">M4 - what this survey phase actually measured</text>`,
    sub,
    rows,
    `  <text x="${PAD}" y="${height - 8}" font-size="12" fill="#546e7a">Null results are printed as null results. Every panel states the population it counted.</text>`,
    `</svg>`,
    ``,
  ].join("\n");
}
