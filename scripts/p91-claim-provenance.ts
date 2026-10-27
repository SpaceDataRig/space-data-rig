// P91 -- CLAIM PROVENANCE REVIEW: can this rig say anything useful about a claim like
// "JUST IN: NASA's James Webb Space Telescope detects a mysterious infrared light signal ..."?
//
// WHAT THIS IS. The claim came from the operator as a question: does our system verify phenomena like this one?
// The honest answer is that our detector cannot -- a broadband optical photometer with a transit estimator has no
// way to see or refute a narrow infrared emission line -- but the CLAIM has structure that is objectively checkable
// with public metadata and no opinion: does the source it asserts exist, does that source say what the post says it
// says, is the post's timing wording compatible with the source's own dates, is the post attributable at all, and
// could our instrument in principle bear on it. Those five questions are the five axes here, each with its rule
// printed next to its answer so a reader can contest the rule instead of the result.
//
// CONTROLS, because a verifier that has never been shown a wrong answer is not trusted. Four invented claims ship
// with the real one in reports/p91-claims.json: a same-day post that cites its source (must come back CLEAN, so
// the tool cannot only ever complain), a post naming the wrong telescope for the record it cites (must MISMATCH --
// a link that resolves is not agreement), a post citing a dead identifier (must report CITATION-DOES-NOT-RESOLVE
// and never "no such result exists"), and a retrospective post with no freshness wording (must stay silent on
// timing). The expected tiers are declared in the fixture, asserted offline by tests/claim-provenance.test.ts, and
// re-checked against the live resolvers by this script.
//
// HARD LIMITS, enforced by construction rather than by intention:
//   - Nothing gates. safeToGate is false in every row of the report.
//   - A transport failure is never a finding. The p8 live-probe split is inherited: reason "transport" reports
//     UNVERIFIABLE, only "not-found" is evidence.
//   - No claim about the sky is made or retracted. Reviewing a third party's announcement does not make their
//     result ours, and it certainly does not make it a discovery.
//
// Usage:
//   npm run p91:claim-provenance                      # resolve live, write reports/p91-claim-provenance.{md,json}
//   npm run p91:claim-provenance -- --offline         # rules + controls against captured records, no network
//   npm run p91:claim-provenance -- --skip-coverage   # skip the TESScut sector lookup
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildStamp } from "./report-freshness.ts";
import { sectorsForCoord } from "../src/data/mastS3.ts";
import { extractMicronBand, reviewClaim, type ClaimReview, type PrimaryRecord, type PublicClaim } from "../src/claims/claimReview.ts";

const CROSSREF = "https://api.crossref.org/works/";
const ARXIV = "https://export.arxiv.org/api/query?id_list=";
const CLAIMS_FILE = resolve(process.cwd(), "reports", "p91-claims.json");

interface ClaimRow {
  id: string;
  kind: string;
  label: string;
  text: string;
  postedUtc: string;
  postedPrecisionNote?: string;
  asserted: { mission: string; instrument?: string; agency?: string };
  citedIds: string[];
  locatedIds?: string[];
  coord?: { raDeg: number; decDeg: number; source: string; note?: string };
  expect?: Record<string, string>;
  expectNote?: string;
}

interface Resolved extends PrimaryRecord {
  /** Where this record came from: the post cited it, or the reviewer located it. Never conflated. */
  via: "cited" | "located";
}

interface Outcome {
  row: ClaimRow;
  review: ClaimReview;
  primaries: Resolved[];
  sectors: number[] | null;
  bandSource: string;
  control: { expected: Record<string, string>; passed: boolean; failed: string[] };
}

const arg = (name: string): boolean => process.argv.includes(`--${name}`);

/* ------------------------------------------------------------------ resolvers --------------------------- */

/** DOI to registering-body record. 404 means the identifier does not exist; anything else means we do not know. */
async function resolveDoi(doi: string, via: "cited" | "located", fetchImpl: typeof fetch): Promise<Resolved> {
  const base = { kind: "doi" as const, id: doi, via };
  try {
    const r = await fetchImpl(CROSSREF + encodeURIComponent(doi), { headers: { Accept: "application/json" } });
    if (r.status === 404) return { ...base, resolved: false, reason: "not-found" };
    if (!r.ok) return { ...base, resolved: false, reason: "transport" };
    const j = (await r.json()) as { message?: Record<string, any> };
    const m = j.message ?? {};
    const parts = m?.published?.["date-parts"]?.[0];
    const publishedUtc = Array.isArray(parts) ? `${parts[0]}-${String(parts[1] ?? 1).padStart(2, "0")}-${String(parts[2] ?? 1).padStart(2, "0")}T00:00:00Z` : undefined;
    // Crossref JATS abstracts arrive as markup (<jats:title>, <jats:italic>) around real prose; the rules read
    // WORDS, so the markup is stripped here rather than being compared as if it were the paper's language.
    const abstract = typeof m.abstract === "string" ? m.abstract.replace(/<\/?jats:[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;
    return {
      ...base,
      resolved: true,
      title: Array.isArray(m.title) ? String(m.title[0]) : undefined,
      abstract,
      publishedUtc,
      venue: Array.isArray(m["container-title"]) ? String(m["container-title"][0]) : undefined,
      publisher: m.publisher ? String(m.publisher) : undefined,
    };
  } catch {
    return { ...base, resolved: false, reason: "transport" };
  }
}

/** arXiv id to its own API record, abstract included -- the abstract is the text a popular post paraphrases. */
async function resolveArxiv(id: string, via: "cited" | "located", fetchImpl: typeof fetch): Promise<Resolved> {
  const base = { kind: "arxiv" as const, id, via };
  let feed: string;
  try {
    const r = await fetchImpl(ARXIV + encodeURIComponent(id), { headers: { Accept: "application/xml" } });
    if (r.status === 404) return { ...base, resolved: false, reason: "not-found" };
    if (!r.ok) return { ...base, resolved: false, reason: "transport" };
    feed = await r.text();
  } catch {
    return { ...base, resolved: false, reason: "transport" };
  }
  // numberOfResults is the authority on "does not exist". Fields are then read from the ENTRY block only: the
  // feed itself carries a <title> ("arXiv Query: ..."), and grabbing the first <title> of the document would have
  // made every arXiv record resolve to the query string that fetched it.
  if (/<opensearch:numberOfResults[^>]*>0<[/]/.test(feed) || !/<entry>/.test(feed)) {
    return { ...base, resolved: false, reason: "not-found" };
  }
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(feed)?.[1] ?? "";
  const grab = (tag: string): string | undefined => {
    const m = new RegExp(`<${tag}[^>]*>(.*)</${tag}>`, "s").exec(entry);
    return m ? m[1].replace(/\s+/g, " ").trim() : undefined;
  };
  const published = grab("published");
  return {
    ...base,
    resolved: true,
    title: grab("title"),
    abstract: grab("summary"),
    publishedUtc: published,
    venue: "arXiv",
  };
}

function classifyId(id: string): "doi" | "arxiv" {
  return id.startsWith("10.") || /^doi:/i.test(id) ? "doi" : "arxiv";
}

async function resolveOne(id: string, via: "cited" | "located", fetchImpl: typeof fetch): Promise<Resolved> {
  const clean = id.replace(/^doi:\s*/i, "").trim();
  return classifyId(clean) === "doi" ? resolveDoi(clean, via, fetchImpl) : resolveArxiv(clean, via, fetchImpl);
}

/* ------------------------------------------------------------------ captured records for --offline ------ */

/**
 * Records transcribed from the live resolvers on 2026-10-18 (Crossref for the DOI, the arXiv API for the id),
 * abstracts included because the rules read them. Non-ASCII characters (mu signs in LaTeX units) are carried as
 * escapes so this source stays pure ASCII for the repo hygiene gate. The dead DOI is transcribed too, WITH its
 * not-found reason: offline must reproduce what live learned, including "the registering body has no such
 * record", which is evidence -- not the "we could not look" transport unknown.
 */
const CAPTURED: Record<string, Omit<Resolved, "via">> = {
  "10.3847/1538-4357/ae9a94": {
    kind: "doi",
    id: "10.3847/1538-4357/ae9a94",
    resolved: true,
    title: "A Single Line Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy",
    abstract:
      "Abstract We report the detection of a previously unknown object with a single emission line within the Hubble Ultra Deep Field, " +
      "using a new JWST NIRSpec technique called Multiobject Coronagraphy for Slitless Spectroscopy (MOCSS) with the G140M/F100LP observing mode. " +
      "This observational technique has enabled the detection of a strong emission line in four different dither positions and in two position angles, " +
      "and thus cannot be artificial. This line is detected at 1.60 \u00b5m with a line flux of [2.5 \u00b1 0.3] \u00d7 10 \u221218 erg s \u22121 cm \u22122 and an " +
      "FWHM of 13.2 \u00b1 2.0 \u00c5, and does not correspond to any known source with some of the deepest Hubble Space Telescope and JWST imaging in existence. " +
      "We discuss possible active galactic nucleus and transient phenomena that could explain the finding.",
    publishedUtc: "2026-09-22T00:00:00Z",
    venue: "The Astrophysical Journal",
    publisher: "American Astronomical Society",
  },
  "2610.12553": {
    kind: "arxiv",
    id: "2610.12553",
    resolved: true,
    title: "A Single Line-Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy",
    abstract:
      "We report the detection of a previously unknown object with a single emission line within the Hubble Ultra Deep Field, using a new JWST NIRSpec " +
      "technique called Multi-Object Coronagraphy for Slitless Spectroscopy (MOCSS) with the G140M/F100LP observing mode. This line is detected at " +
      "1.60 $\\rm \u03bcm$ with a line flux of $[2.5\\pm 0.3]\\times10^{-18} \\rm erg\\ s^{-1} cm^{-2}$ and a FWHM of $13.2\\pm2.0$\\u00c5, and does not " +
      "correspond to any known source with some of the deepest HST and JWST imaging in existence. Based upon the absence of imaging detection, we place a " +
      "lower limit on the observed frame equivalent width (EW) of 7620\\u00c5 on this object. We discuss possible AGN and transient phenomena that could " +
      "explain the finding.",
    publishedUtc: "2026-10-08T18:00:01Z",
    venue: "arXiv",
  },
  "10.0000/this-identifier-does-not-exist": {
    kind: "doi",
    id: "10.0000/this-identifier-does-not-exist",
    resolved: false,
    reason: "not-found",
  },
};

/* ------------------------------------------------------------------ run --------------------------------- */

async function run(): Promise<void> {
  const offline = arg("offline");
  const skipCoverage = arg("skip-coverage");
  const fetchImpl = offline
    ? ((() => Promise.reject(new Error("--offline performs no network I/O"))) as unknown as typeof fetch)
    : fetch;

  const doc = JSON.parse(readFileSync(CLAIMS_FILE, "utf8")) as { claims: ClaimRow[] };
  const outcomes: Outcome[] = [];

  for (const row of doc.claims) {
    const ids: Array<{ id: string; via: "cited" | "located" }> = [
      ...row.citedIds.map((id) => ({ id, via: "cited" as const })),
      ...(row.locatedIds ?? []).map((id) => ({ id, via: "located" as const })),
    ];
    const primaries: Resolved[] = [];
    for (const { id, via } of ids) {
      const clean = id.replace(/^doi:\s*/i, "").trim();
      if (offline && CAPTURED[clean]) {
        primaries.push({ ...(CAPTURED[clean] as Omit<Resolved, "via">), via });
        continue;
      }
      if (offline) {
        // An identifier with no captured record cannot be invented: report it as unknown, never as not-found.
        primaries.push({ kind: classifyId(clean), id: clean, via, resolved: false, reason: "transport" });
        continue;
      }
      primaries.push(await resolveOne(id, via, fetchImpl));
    }

    const claim: PublicClaim = {
      id: row.id,
      text: row.text,
      postedUtc: row.postedUtc,
      asserted: row.asserted,
      citedIds: row.citedIds.map((i) => i.replace(/^doi:\s*/i, "").trim()),
      locatedIds: (row.locatedIds ?? []).map((i) => i.replace(/^doi:\s*/i, "").trim()),
    };

    // The band comes from text we can cite -- the post first, then the located record's own abstract. Never from
    // what the reviewer remembers about the instrument.
    const fromPost = extractMicronBand(row.text);
    const fromRecord = primaries.find((p) => p.abstract)?.abstract ? extractMicronBand(String(primaries.find((p) => p.abstract)?.abstract)) : null;
    claim.asserted = { ...row.asserted };
    if (fromPost) {
      claim.asserted.band = fromPost;
    } else if (fromRecord) {
      claim.bandFromPrimary = fromRecord;
    }
    const bandSource = fromPost ? "the post states a wavelength" : fromRecord ? "the located primary record states it; the post gives only a colour word" : "no wavelength in the post or in any resolved record";

    let sectors: number[] | null = null;
    if (!skipCoverage && row.coord) {
      try {
        sectors = offline ? [4, 31, 105, 106, 107, 108] : await sectorsForCoord(row.coord.raDeg, row.coord.decDeg);
      } catch {
        sectors = null;
      }
    }

    const review = reviewClaim(claim, primaries, sectors);
    const expected = row.expect ?? {};
    const failed: string[] = [];
    const tierOf = (axis: string): string => {
      const box = (review as unknown as Record<string, { tier?: string }>)[axis];
      return box && typeof box.tier === "string" ? box.tier : "";
    };
    for (const [axis, want] of Object.entries(expected)) {
      const got = tierOf(axis);
      if (got !== want) failed.push(`${axis}: expected ${want}, got ${got || "n/a"}`);
    }
    outcomes.push({ row, review, primaries, sectors, bandSource, control: { expected, passed: failed.length === 0, failed } });
  }

  writeFileSync(resolve(process.cwd(), "reports", "p91-claim-provenance.json"), JSON.stringify({
    schema: "sdr-claim-provenance/1",
    mode: offline ? "offline" : "live",
    axes: {
      subject: "does the resolved primary say the thing the post says it says",
      recency: "is the post's freshness wording compatible with the primary's own first-public date",
      attribution: "does the post point at a persistent identifier, and does that identifier exist",
      band: "does the claimed wavelength fall inside our instrument's band",
      corroboration: "could this rig in principle bear on the phenomenon (band AND coverage, never either alone)",
    },
    rules: { recencyInflationDays: 7, micronHalfWindowMicron: 0.2, tessBandMicron: [0.6, 1.0], timingTerms: ["just in", "breaking", "today", "yesterday", "newly", "this week", "live now", "exclusive"] },
    reviews: outcomes.map((o) => ({
      id: o.row.id,
      kind: o.row.kind,
      label: o.row.label,
      postText: o.row.text,
      postedUtc: o.row.postedUtc,
      postedPrecisionNote: o.row.postedPrecisionNote ?? null,
      citedIds: o.row.citedIds,
      locatedIds: o.row.locatedIds ?? [],
      primaries: o.primaries.map((p) => ({ kind: p.kind, id: p.id, via: p.via, resolved: p.resolved, reason: p.reason ?? null, title: p.title ?? null, publishedUtc: p.publishedUtc ?? null, venue: p.venue ?? null })),
      coverage: o.row.coord ? { raDeg: o.row.coord.raDeg, decDeg: o.row.coord.decDeg, coordSource: o.row.coord.source, note: o.row.coord.note ?? null, sectors: o.sectors } : { raDeg: null, decDeg: null, coordSource: "none", sectors: null },
      bandSource: o.bandSource,
      verdict: o.review,
      control: o.control,
    })),
    controlsSummary: {
      rows: outcomes.length,
      withExpectations: outcomes.filter((o) => Object.keys(o.control.expected).length).length,
      passed: outcomes.filter((o) => o.control.passed || !Object.keys(o.control.expected).length).length,
      failed: outcomes.filter((o) => !o.control.passed && Object.keys(o.control.expected).length).map((o) => ({ id: o.row.id, failed: o.control.failed })),
    },
    // ROUND-26 R26-5: this used to be `stamp: buildStamp(...)`, a THIRD key that no reader looked at -- p86 resolves a
    // stamp from `meta` or from the flat top level, so a complete hashed stamp sat in the artifact invisible and the row
    // was published as unattested. The data was always good; only its address was wrong. `meta` is where the other 50
    // reports put it.
    meta: buildStamp(["reports/p91-claims.json", "src/claims/claimReview.ts", "scripts/p91-claim-provenance.ts"]),
  }, null, 2) + "\n", "utf8");

  const md: string[] = [];
  md.push("# P91 - can this rig verify a claim like that one?\n");
  // ROUND-26 R26-15: scripts/report-md.ts reads the `Reproduce:` line to fill the index's reproduce command; with none,
  // the published row told readers nothing about how to re-run it. Not `--offline`: that flag reproduces the verdicts but
  // rewrites resolved titles from captured records, which is why the fleet arm runs it live.
  md.push("Reproduce: `npm run p91:claim-provenance`");
  md.push("");
  const modeLabel = offline ? "offline (captured records, no network)" : "live (resolvers queried)";
  md.push(`Mode: **${modeLabel}** -- rules, not mood: the same input must give the same verdict either way.`);
  md.push("");
  md.push("## What is being verified, and what is not");
  md.push("Our detector is a broadband optical transit finder. A narrow infrared emission line reported by a spectrograph is not something it can see, so this study does not attempt to re-measure the phenomenon. What IS checkable is the claim's own structure: whether a primary source exists, whether it says what the post says, whether the post's timing wording survives comparison with the source's dates, whether the post is attributable at all, and whether our instrument could in principle bear on it. Every axis prints its rule beside its answer.");
  md.push("");
  md.push("| axis | question | rule |");
  md.push("| --- | --- | --- |");
  md.push("| subject | does the resolved primary say what the post says | every asserted platform token must appear in the record, and at least one phenomenon CLASS must be shared |");
  md.push("| recency | is a freshness claim compatible with the source | freshness wording plus a lag over 7 whole days past the earliest resolved public date -> INFLATED; no wording -> the axis stays silent |");
  md.push("| attribution | does the post point at anything persistent | judged on identifiers the POST cited, never on identifiers we located for it |");
  md.push("| band | is the wavelength inside our reach | interval overlap against TESS 0.6-1.0 micron, band taken from citable text only |");
  md.push("| corroboration | could we say anything about it | band AND coverage both required; a photometric null would not test a line claim |");
  md.push("");
  md.push("## Rows");
  for (const o of outcomes) {
    md.push(`### ${o.row.id}  \n_${o.row.label}_`);
    md.push("");
    md.push(`> ${o.row.text}`);
    md.push("");
    md.push(`posted ${o.row.postedUtc}${o.row.postedPrecisionNote ? ` (${o.row.postedPrecisionNote})` : ""}; post-cited ids: ${o.row.citedIds.length ? o.row.citedIds.join(", ") : "none"}; located by us: ${(o.row.locatedIds ?? []).join(", ") || "none"}.`);
    md.push("");
    md.push(`- **subject ${o.review.subject.tier}** -- ${o.review.subject.basis}`);
    md.push(`- **attribution ${o.review.attribution.tier}** -- ${o.review.attribution.basis}`);
    md.push(`- **recency ${o.review.recency.tier}${o.review.lagDays != null ? ` (lag ${o.review.lagDays} d)` : ""}** -- ${o.review.recency.basis}`);
    md.push(`- **band ${o.review.band.tier}** -- ${o.review.band.basis}; source of the number: ${o.bandSource}`);
    md.push(`- **our reach ${o.review.corroboration.tier}** -- ${o.review.corroboration.basis}${o.row.coord ? ` (position is an ${o.row.coord.source})` : ""}`);
    for (const p of o.primaries) {
      md.push(`  - [${p.via}] ${p.kind} ${p.id}: ${p.resolved ? `${p.venue ?? p.publisher ?? "venue unknown"}, ${String(p.publishedUtc).slice(0, 10)} -- ${p.title}` : `did not resolve (${p.reason ?? "transport"})`}`);
    }
    if (Object.keys(o.control.expected).length) {
      md.push(`  - control expectation ${JSON.stringify(o.control.expected)} -> **${o.control.passed ? "MET" : "MISSED: " + o.control.failed.join("; ")}**`);
      if (o.row.expectNote) md.push(`  - why that expectation: ${o.row.expectNote}`);
    }
    md.push("");
  }
  md.push("## Controls");
  const c = outcomes.map((o) => ({ row: o.row, ok: o.control.passed, failed: o.control.failed })).filter((x) => Object.keys(x.row.expect ?? {}).length);
  md.push(`${c.filter((x) => x.ok).length} of ${c.length} expectation-bearing rows behaved as declared. A negative control that fails is the interesting case: it means the rule cannot tell a wrong claim from a right one.`);
  md.push("");
  md.push("## What this does not support");
  md.push("Nothing here gates, anchors, or retracts anything: `safeToGate` is false on every row by construction. Reviewing somebody else's announcement does not make their result ours, and a metadata mismatch is not evidence about the sky. Where a resolver could not be reached, the report says UNVERIFIABLE rather than inventing a finding -- the same split the upstream live-probe uses between 'drifted' and 'unreachable'.");
  md.push("");
  writeFileSync(resolve(process.cwd(), "reports", "p91-claim-provenance.md"), md.join("\n"), "utf8");

  for (const o of outcomes) {
    console.log(`${o.row.kind.padEnd(22)} ${o.row.id.padEnd(36)} ${o.review.summary}`);
    if (!o.control.passed && Object.keys(o.control.expected).length) console.log(`   !! control MISSED: ${o.control.failed.join("; ")}`);
  }
  const missed = outcomes.filter((o) => !o.control.passed && Object.keys(o.control.expected).length).length;
  console.log(`\nVERDICT: ${missed ? `${missed} CONTROL(S) MISSED -- the rule layer and the fixture disagree` : "CONTROLS MET"} (mode ${offline ? "offline" : "live"}, ${outcomes.length} rows, safeToGate=false everywhere)`);
}

run().catch((e) => {
  console.error("p91 failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
