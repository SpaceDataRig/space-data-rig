// P86 REPORT LIBRARY: distil the committed reports/*.md into browsable static web assets.
//
// The reports under reports/ are NOT reachable from the Cloudflare edge (only web/ is served as a
// static-asset root), so -- exactly like scripts/p38-research-bundle.ts distils reports/*.json into
// web/research.json -- this reads the human-written reports at build time and writes:
//   web/reports/index.json      a small manifest (id, slug, title, reproduce, summary) the UI lists
//   web/reports/<slug>.html     one rendered HTML fragment per report, lazy-fetched on click
// The frontend (web/app.js, "reports" view) fetches the index, shows the list, and injects the chosen
// fragment. This performs NO new analysis and touches no worker/DO/pipeline/bundle-hash/money path;
// it only re-renders text the repository already publishes, so the dashboard can never drift from it.
//
// Usage: npm run p86:report-library   (writes web/reports/)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { slugify, mdToHtml, extractMeta } from "./report-md.ts";

const REPORTS_DIR = "reports";
const OUT_DIR = join("web", "reports");

/** Numeric P-phase prefix for stable ordering (p33 -> 33); anything unprefixed sorts last. */
function pnum(id: string): number {
  const m = /^p(\d+)/i.exec(id);
  return m ? Number(m[1]) : 9999;
}

function main(): void {
  if (!existsSync(REPORTS_DIR)) {
    console.error(`p86: no ${REPORTS_DIR}/ directory found (run from the repo root).`);
    process.exit(1);
  }
  const files = readdirSync(REPORTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort();
  if (!files.length) {
    console.error(`p86: no reports/*.md found; nothing to do.`);
    process.exit(1);
  }

  // Clean rebuild so a renamed/removed report cannot leave a stale fragment behind. Scoped strictly
  // to the generated web/reports/ directory (a build artifact), never anything else.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const reports: { id: string; slug: string; title: string; reproduce: string; summary: string; p: number }[] = [];
  for (const f of files) {
    const md = readFileSync(join(REPORTS_DIR, f), "utf8");
    const id = f.replace(/\.md$/i, "");
    const slug = slugify(f) || id.toLowerCase();
    const meta = extractMeta(md);
    const html = mdToHtml(md);
    writeFileSync(join(OUT_DIR, `${slug}.html`), html, "utf8");
    reports.push({ id, slug, title: meta.title, reproduce: meta.reproduce, summary: meta.summary, p: pnum(id) });
  }

  reports.sort((a, b) => a.p - b.p || a.id.localeCompare(b.id));

  const index = {
    schema: "sdr-reports/1",
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/p86-report-library.ts (from committed reports/*.md)",
    note:
      "Human-readable research reports, rendered from the committed reports/ directory. These characterise " +
      "the pipeline's operating point and cross-checks on real public TESS data with positive controls -- " +
      "measurements and method checks, not claims of new planets.",
    count: reports.length,
    reports: reports.map(({ id, slug, title, reproduce, summary }) => ({ id, slug, title, reproduce, summary })),
  };
  writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`p86: wrote ${reports.length} report fragments + index.json to ${OUT_DIR.replace(/\\/g, "/")}/`);
}

main();
