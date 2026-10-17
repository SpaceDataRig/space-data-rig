// P87 FIGURES MANIFEST: inventory the committed web/*.svg so the dashboard "Gallery" view can show them.
//
// The Gallery view (web/app.js, ensureGallery) lazy-fetches /figures.json and renders one card per
// figure. Exactly like scripts/p86-report-library.ts (reports) and scripts/p38-research-bundle.ts
// (metrics), this only lists files the repository ALREADY publishes under web/ -- it performs no
// analysis, hardcodes no numbers, and touches no worker/DO/pipeline/bundle-hash/money path. Titles are
// derived mechanically from each filename, so the manifest can never claim more than the figures show.
//
// Usage: npm run p87:figures-manifest   (writes web/figures.json)

import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_DIR = "web";
const OUT_FILE = join(WEB_DIR, "figures.json");

// Filename tokens that read better in full caps (instrument / statistics acronyms).
const ACRONYMS = new Set(["fp", "fn", "tp", "tn", "pdm", "roc", "psf", "bls", "toi", "llm", "snr", "fap", "tess", "mast", "nasa", "2x2"]);

// A few canonical figures are surfaced first; everything else follows alphabetically. This is purely
// a presentation order -- renaming or removing any of these simply falls back to alphabetical.
const FEATURED = ["results-figure", "transit-example", "milestone-figure"];

/** "audit5-rotating-survey-figure" -> "Audit5 Rotating Survey" (a trailing "figure" token is dropped). */
function titleFromSlug(slug: string): string {
  const tokens = slug.split("-").filter(Boolean);
  if (tokens.length > 1 && tokens[tokens.length - 1].toLowerCase() === "figure") tokens.pop();
  const words = tokens.map((t) => (ACRONYMS.has(t.toLowerCase()) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()));
  return words.join(" ") || slug;
}

function main(): void {
  if (!existsSync(WEB_DIR)) {
    console.error(`p87: no ${WEB_DIR}/ directory found (run from the repo root).`);
    process.exit(1);
  }
  const slugs = readdirSync(WEB_DIR)
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .map((f) => f.replace(/\.svg$/i, ""));
  if (!slugs.length) {
    console.error(`p87: no web/*.svg found; nothing to do.`);
    process.exit(1);
  }

  const rank = (slug: string): number => {
    const i = FEATURED.indexOf(slug);
    return i === -1 ? FEATURED.length : i;
  };
  slugs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const figures = slugs.map((slug) => ({ src: `${slug}.svg`, title: titleFromSlug(slug) }));

  const manifest = {
    schema: "sdr-figures/1",
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/p87-figures-manifest.ts (from committed web/*.svg)",
    note:
      "Every figure the rig has published, inventoried from the committed web/ directory. Titles are " +
      "derived mechanically from each filename; each card links to the SVG exactly as deployed.",
    count: figures.length,
    figures,
  };
  writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`p87: wrote ${figures.length} figures to ${OUT_FILE.replace(/\\/g, "/")}`);
}

main();
