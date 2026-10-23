// P86 REPORT LIBRARY: distil the committed reports/*.md into browsable static web assets.
//
// The reports under reports/ are NOT reachable from the Cloudflare edge (only web/ is served as a
// static-asset root), so -- exactly like scripts/p38-research-bundle.ts distils reports/*.json into
// web/research.json -- this reads the human-written reports at build time and writes:
//   web/reports/index.json      a small manifest (id, slug, title, reproduce, summary, freshness) the UI lists
//   web/reports/<slug>.html     one rendered HTML fragment per report, lazy-fetched on click
// The frontend (web/app.js, "reports" view) fetches the index, shows the list, and injects the chosen
// fragment. This performs NO new analysis and touches no worker/DO/pipeline/bundle-hash/money path;
// it only re-renders text the repository already publishes, so the dashboard can never drift from it.
//
// FRESHNESS GATE (audit-6 #2): before publishing, each report is checked against the inputs its numbers
// were derived from (see scripts/report-freshness.ts). A report whose checkpoint/source changed AFTER it
// was generated is HARD-STALE: p86 stamps its fragment with a red banner, flags it in index.json, and (by
// default) exits non-zero so the deploy step refuses to publish stale numbers on the public site. This is
// the guard against "the fix landed and the report was re-run, but the published page still shows the old
// figure" -- the exact P81 "contradictions (4)" staleness the auditor caught. Pass --allow-stale to build
// anyway (marks red, exit 0) when you are intentionally shipping a still-being-refreshed report.
//
// Usage: npm run p86:report-library [-- --allow-stale]   (writes web/reports/)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mdToHtml, extractMeta, escHtml } from "./report-md.ts";
import {
  type FreshnessStamp,
  type FreshnessVerdict,
  buildStamp,
  stampFromMeta,
  evaluateAgainst,
  newestInputMs,
  reportMs,
  gitLastCommitIso,
  gitTrackedPaths,
} from "./report-freshness.ts";

const REPORTS_DIR = "reports";
const OUT_DIR = join("web", "reports");
const ALLOW_STALE = process.argv.includes("--allow-stale");

// Is a report's recorded input a file ANY checkout can produce? Answers from one `git ls-files` rather than
// one subprocess per path, and stays silent (undefined, so nothing is disqualified) when git cannot answer:
// "unknown" must not be published as "unverifiable", any more than "untracked" may be published as verified.
const TRACKED = gitTrackedPaths();
const isTracked = TRACKED ? (p: string) => TRACKED.has(p.split(/[\\/]/).join("/")) : undefined;

// Tracked source files a report's numbers depend on, used only as the git-provenance fallback for
// inputs that are NOT recorded as a hashed checkpoint (network reports, or legacy reports predating
// stamping). Keyed by report id. The RA-unit fix lived in src/data/toiDispositions.ts, so every report
// whose Gaia cone/blend census uses host coordinates lists it here.
const SOURCE_DEPS: Record<string, string[]> = {
  "p59-offtarget-subset": ["src/data/toiDispositions.ts", "src/data/gaiaDilution.ts", "scripts/p59-offtarget-subset.ts"],
  "p81-triceratops-lite": ["src/data/toiDispositions.ts", "src/data/gaiaDilution.ts", "scripts/p81-triceratops-lite.ts"],
  "p82-scaled": ["src/data/toiDispositions.ts", "src/data/gaiaDilution.ts", "src/detect/centroidFtest.ts", "scripts/p82-scaled-validation.ts"],
  "p84-centroid-diagnosis": ["src/detect/centroidFtest.ts", "scripts/p84-centroid-diagnosis.ts"],
  "p85-contaminant-fit": ["src/detect/centroidFtest.ts", "scripts/p85-contaminant-fit.ts"],
  "p88-independent-corroboration": ["src/data/toiDispositions.ts", "src/data/gaiaDilution.ts", "src/data/gaiaRv.ts", "scripts/p88-independent-corroboration.ts"],
  "p89-multiepoch-di": ["src/data/toiDispositions.ts", "src/detect/psfDiffImaging.ts", "scripts/p89-multiepoch-di.ts"],
  // The two external-benchmark studies in reports/crosscheck/. Once their generators stamp the artifact with hashed
  // inputs the gate re-hashes those; these SOURCE_DEPS are the git-provenance fallback for the window before a
  // re-run, so editing the Python harness at least shows up as a newer-than-report soft note rather than nothing.
  "crosscheck/benchmark-vs-field": ["scripts/benchmark_vs_field.py", "scripts/cross_pipeline.py"],
  "crosscheck/cross-pipeline": ["scripts/cross_pipeline.py"],
};

/** Numeric P-phase prefix for stable ordering (p33 -> 33); anything unprefixed sorts last. */
function pnum(id: string): number {
  const m = /^p(\d+)/i.exec(id);
  return m ? Number(m[1]) : 9999;
}

/** Extract the generator script path from a meta.generatedBy string like "scripts/p84-...ts --probe report". */
function generatorScript(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const g = (meta as Record<string, unknown>).generatedBy;
  if (typeof g !== "string") return null;
  const m = /(scripts\/[\w.\-/]+\.ts)/.exec(g);
  return m ? m[1] : null;
}

/** Read a report's JSON meta (flat top-level for p88/p89, nested under `meta` otherwise). */
function readReportJson(id: string): { meta: unknown; stamp: FreshnessStamp | null } | null {
  const p = join(REPORTS_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const meta = obj && typeof obj.meta === "object" && obj.meta ? obj.meta : obj;
  return { meta, stamp: stampFromMeta(meta) };
}

function freshnessFor(id: string): { stamp: FreshnessStamp | null; verdict: FreshnessVerdict } {
  const mdPath = join(REPORTS_DIR, `${id}.md`);
  const deps = SOURCE_DEPS[id] ?? [];
  const { meta, stamp } = readReportJson(id) ?? { meta: null, stamp: null };
  const dataInputs = stamp?.inputs.map((i) => i.path) ?? [];
  const genScript = generatorScript(meta);
  const provenancePaths = Array.from(new Set([...dataInputs, ...deps, ...(genScript ? [genScript] : [])]));
  const rmMs = reportMs(mdPath, stamp, (p) => (existsSync(p) ? gitLastCommitIso(p) : null));
  const inputNewestMs = newestInputMs(provenancePaths.filter((p) => existsSync(p) || deps.includes(p)));
  const verdict = evaluateAgainst(stamp, { reportMs: rmMs, inputNewestMs, tracked: isTracked });
  return { stamp, verdict };
}

const STALE_BANNER = (reasons: string[]): string =>
  `<div class="report-stale-banner" style="border:2px solid #b00020;background:#fff0f1;color:#7a0016;padding:10px 14px;margin:0 0 16px;border-radius:6px;font-weight:600">` +
  `STALE / OUT OF DATE: this report's numbers may predate a change to the inputs they were computed from. ` +
  `Do not quote until re-run. ` +
  (reasons.length ? `<ul style="margin:6px 0 0;padding-left:20px;font-weight:400">${reasons.map((r) => `<li>${escHtml(r)}</li>`).join("")}</ul>` : "") +
  `</div>`;

/**
 * SOFT amber note for a report the gate could not machine-check -- deliberately NOT the red stale banner and
 * deliberately NOT a build failure. These numbers are not known to be wrong; they are unaudited, because the
 * artifact records no input checksum to re-hash. Before this note existed the honest reason string computed by
 * evaluateAgainst ("stamped but records no input checkpoint to re-verify") was dropped on the floor: it reached
 * neither index.json nor the fragment, so a reader -- and the aggregate "N stamped" count -- could not tell a
 * re-hashed report from one carrying only a timestamp.
 */
const PROVENANCE_NOTE = (reasons: string[]): string =>
  `<div class="report-provenance-note" style="border:1px solid #8a6d00;background:#fffbe6;color:#5c4a00;padding:8px 12px;margin:0 0 16px;border-radius:6px">` +
  `PROVENANCE NOT MACHINE-VERIFIABLE: this report records no input checksums the freshness gate can re-hash, ` +
  `so its numbers have not been checked against the data they were computed from. That is a statement about the ` +
  `audit trail, not a claim that the figures are wrong. ` +
  (reasons.length ? `<ul style="margin:6px 0 0;padding-left:20px">${reasons.map((r) => `<li>${escHtml(r)}</li>`).join("")}</ul>` : "") +
  `</div>`;

/**
 * A report whose stamp WAS re-hashed, but not completely (audit b2, 2026-10-18). Its generator recorded
 * checksums over inputs that are not present on this checkout -- typically a gitignored working file such as
 * `out/scaled/centroid.jsonl`, which exists only on the machine that ran the report. Something was genuinely
 * re-hashed and matched, so this is not the amber "unaudited" note; but the reader must be able to see that
 * the check did not cover every input the numbers were derived from, and that on a fresh clone even the
 * partial check could not run at all. Naming the missing paths is what makes the claim re-checkable elsewhere.
 */
const PARTIAL_NOTE = (rehashed: number, reasons: string[]): string =>
  `<div class="report-provenance-note" style="border:1px solid #4a6d00;background:#f6fbef;color:#33500f;padding:8px 12px;margin:0 0 16px;border-radius:6px">` +
  `PROVENANCE PARTLY RE-VERIFIED: the freshness gate re-hashed ${rehashed} recorded input checksum${rehashed === 1 ? "" : "s"} and every one still matches, but could not` +
  (reasons.length ? ` cover everything the run recorded: ` : ` cover every input the run recorded. `) +
  (reasons.length ? `<ul style="margin:6px 0 0;padding-left:20px">${reasons.map((r) => `<li>${escHtml(r)}</li>`).join("")}</ul>` : "") +
  `</div>`;

function main(): void {
  if (!existsSync(REPORTS_DIR)) {
    console.error(`p86: no ${REPORTS_DIR}/ directory found (run from the repo root).`);
    process.exit(1);
  }
  // Enumerate the top-level reports AND the reports/crosscheck/ subdirectory (external audit R1). The crosscheck
  // reports -- the LEO-Vetter benchmark and the separate-Python cross-pipeline -- are exactly the EXTERNAL numbers a
  // scientist would cite, yet they lived entirely OUTSIDE this gate: p86 never scanned the subdir, so they were never
  // stamped, never re-hashed, and never shown on the site. Pages are written FLAT with a "crosscheck-" prefixed slug
  // so they cannot collide with a top-level report and route as ordinary /reports/<slug>.html static assets.
  const sources: { id: string; mdAbs: string }[] = [];
  for (const f of readdirSync(REPORTS_DIR).filter((f) => f.toLowerCase().endsWith(".md")).sort()) {
    sources.push({ id: f.replace(/\.md$/i, ""), mdAbs: join(REPORTS_DIR, f) });
  }
  const CROSSCHECK_DIR = join(REPORTS_DIR, "crosscheck");
  if (existsSync(CROSSCHECK_DIR)) {
    for (const f of readdirSync(CROSSCHECK_DIR).filter((f) => f.toLowerCase().endsWith(".md")).sort()) {
      sources.push({ id: `crosscheck/${f.replace(/\.md$/i, "")}`, mdAbs: join(CROSSCHECK_DIR, f) });
    }
  }
  if (!sources.length) {
    console.error(`p86: no reports/*.md found; nothing to do.`);
    process.exit(1);
  }

  // Clean rebuild so a renamed/removed report cannot leave a stale fragment behind. Scoped strictly
  // to the generated web/reports/ directory (a build artifact), never anything else.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const reports: { id: string; slug: string; title: string; reproduce: string; summary: string; p: number; fresh: boolean; stamped: boolean; verified: boolean; rehashed: number; reproducible: number; unverifiableInputs: number; untrackedInputs: number }[] = [];
  const staleIds: string[] = [];
  let stampedCount = 0;
  let verifiedCount = 0;
  let fullCount = 0;

  for (const s of sources) {
    const md = readFileSync(s.mdAbs, "utf8");
    const id = s.id;
    const slug = id.split("/").join("-");
    const meta = extractMeta(md);
    const { verdict } = freshnessFor(id);
    if (verdict.stamped) stampedCount++;
    if (verdict.verified) verifiedCount++;
    let html = mdToHtml(md);
    if (verdict.stale) {
      staleIds.push(id);
      html = STALE_BANNER(verdict.reasons) + "\n" + html;
      console.error(`p86: STALE ${id} -- ${verdict.reasons.join("; ")}`);
    } else if (!verdict.verified) {
      // Not blocking (that would fail the build for every legacy report), but no longer invisible.
      html = PROVENANCE_NOTE(verdict.reasons) + "\n" + html;
    } else if (verdict.unverifiableInputs > 0 || verdict.untrackedInputs > 0) {
      // Re-hashed and matched, but not every input the run recorded could be re-hashed here, or the ones that
      // matched are gitignored working files that exist only on the author's machine.
      html = PARTIAL_NOTE(verdict.rehashed, verdict.reasons.filter((r) => /not present to re-verify|not tracked in the repository/.test(r))) + "\n" + html;
    }
    if (verdict.verified && verdict.unverifiableInputs === 0 && verdict.untrackedInputs === 0) fullCount++;
    writeFileSync(join(OUT_DIR, `${slug}.html`), html, "utf8");
    reports.push({
      id, slug, title: meta.title, reproduce: meta.reproduce, summary: meta.summary, p: pnum(id),
      fresh: !verdict.stale, stamped: verdict.stamped, verified: verdict.verified,
      rehashed: verdict.rehashed, reproducible: verdict.reproducible,
      unverifiableInputs: verdict.unverifiableInputs, untrackedInputs: verdict.untrackedInputs,
    });
  }

  reports.sort((a, b) => a.p - b.p || a.id.localeCompare(b.id));

  const publishStamp = buildStamp([]);
  const index = {
    schema: "sdr-reports/1",
    generatedAt: publishStamp.generatedAt,
    // WHY "builtAtGitSha" AND NOT "gitSha" (audit-6 follow-up). This is a STATIC artifact: p86 runs, its
    // output is committed, and that commit is then deployed. The HEAD recorded here is therefore, by
    // construction, the commit BEFORE the one that ships this file -- it can never equal /health.gitSha,
    // which is injected at deploy time. Naming the field plainly "gitSha" invited exactly that false
    // mismatch (an auditor comparing the two would read a benign one-commit lag as "the published report
    // library came from a different tree than the deployed worker"). The authoritative deployed revision
    // is /health.gitSha; whether a report may be quoted is decided by its own input sha256 stamp under
    // freshness/, never by this build-provenance field.
    builtAtGitSha: publishStamp.gitSha,
    shaNote:
      "builtAtGitSha is the working-tree HEAD when this static library was built, so it always trails the " +
      "deployed revision by the one commit that carries this file. Use /health.gitSha for the deployed " +
      "revision and freshness.stale for whether any report here is out of date.",
    generatedBy: "scripts/p86-report-library.ts (from committed reports/*.md)",
    note:
      "Human-readable research reports, rendered from the committed reports/ directory. These characterise " +
      "the pipeline's operating point and cross-checks on real public TESS data with positive controls -- " +
      "measurements and method checks, not claims of new planets. Each entry carries a freshness flag from " +
      "the report-freshness gate; stale reports are marked red both here and in their fragment. " +
      "Three levels, and they are not interchangeable: `stamped` means only that a report carries a " +
      "generatedAt timestamp; `verified` means the gate re-hashed at least one recorded input checksum " +
      "against a file TRACKED IN THIS REPOSITORY and found it unchanged -- so a stranger cloning the repo can " +
      "re-run the same check; `fullyVerified` means every recorded input was tracked, present and matching. " +
      "Quote `fullyVerified` as the machine-checked count. A report can be re-hashed on the workstation that " +
      "built it and still not be verifiable by anyone else: `untrackedInputs` counts checksums over gitignored " +
      "working files (they matched here, but no clone has those bytes), and `unverifiableInputs` counts paths " +
      "that are absent here entirely. Both are named on the report page, so exactly what is missing is visible.",
    count: reports.length,
    freshness: {
      stamped: stampedCount,
      verified: verifiedCount,
      fullyVerified: fullCount,
      // audit-14 N6: make the unaudited mass a first-class number instead of something inferred by subtracting
      // `stamped` from `total`. A report with no stamp still reads `fresh: true` because the gate cannot detect
      // staleness in something it has no checksum to re-hash -- that is "not known stale", NOT "verified current".
      // `unattested` names how many reports are in that state, so the aggregate can never be read as "all fresh".
      unattested: reports.length - stampedCount,
      total: reports.length,
      stale: staleIds,
    },
    reports: reports.map(({ id, slug, title, reproduce, summary, fresh, stamped, verified, rehashed, reproducible, unverifiableInputs, untrackedInputs }) => ({
      id, slug, title, reproduce, summary, fresh, stamped, verified, rehashed, reproducible, unverifiableInputs, untrackedInputs,
    })),
  };
  writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(
    `p86: wrote ${reports.length} report fragments + index.json to ${OUT_DIR.replace(/\\/g, "/")}/ ` +
      `(${fullCount} fully verified, ${verifiedCount} verified, ${stampedCount} stamped, ${staleIds.length} stale).`,
  );

  if (staleIds.length && !ALLOW_STALE) {
    console.error(`p86: refusing to publish ${staleIds.length} stale report(s): ${staleIds.join(", ")}. Re-run them (or pass --allow-stale to ship marked-red).`);
    process.exit(1);
  }
}

main();
