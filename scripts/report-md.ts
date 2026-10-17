// A tiny, dependency-free Markdown-subset renderer used at BUILD TIME to turn the committed
// reports/*.md into static HTML fragments under web/reports/ (see scripts/p86-report-library.ts).
//
// WHY: the reports live under reports/, which the Cloudflare edge does NOT serve (only web/ is a
// static-asset root). Exactly like scripts/p38-research-bundle.ts distils reports/*.json into
// web/research.json, this distils the human-written reports into browsable web assets so the
// dashboard can show the full research record without any new edge route or worker code.
//
// SAFETY: the source text is HTML-escaped FIRST (every & < > " ' becomes an entity), and the
// renderer only ever re-introduces a fixed whitelist of tags it generates itself (h1-h6, p,
// ul/ol/li, table, pre/code, strong/em, and <a> for http/https links only). Any raw HTML in a
// report is therefore inert. This is a build tool over trusted, committed input -- not a runtime
// sanitizer for untrusted user content -- but it is written to fail safe regardless.

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape the five HTML-significant characters. Applied before any tag is introduced. */
export function escHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENT[c]);
}

/** Filename -> URL/DOM-safe slug: "p49-blind-test.md" -> "p49-blind-test". */
export function slugify(name: string): string {
  return String(name ?? "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Split a Markdown table row into trimmed cell strings (leading/trailing pipes are optional). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** True when a line is a Markdown table separator like |---|:--:|. */
function isTableSeparator(line: string): boolean {
  return line.includes("-") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);
}

// Inline formatting over an ALREADY-ESCAPED string. Code spans are split out first so bold/italic/
// link rules can never touch their contents; only http/https links are turned into anchors.
function inline(escaped: string): string {
  const parts = escaped.split(/(`[^`]+`)/g); // keep the `code` delimiters as their own segments
  return parts
    .map((p) => {
      if (p.length >= 2 && p.startsWith("`") && p.endsWith("`")) return `<code>${p.slice(1, -1)}</code>`;
      let s = p;
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    })
    .join("");
}

/**
 * Render a Markdown-subset document to an HTML fragment string. Supported: ATX headings (#..######),
 * paragraphs (soft-wrapped lines joined), fenced code (```), pipe tables with a separator row,
 * unordered (- * +) and ordered (1.) lists, and inline `code`, **bold**, *italic*, [text](http...).
 * Anything unrecognised falls through to a paragraph, so unknown syntax degrades safely to text.
 */
export function mdToHtml(md: string): string {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(escHtml(para.join(" ")))}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");

    // fenced code block
    if (/^```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].replace(/\s+$/, ""))) {
        buf.push(lines[i]);
        i++;
      }
      i++; // step over the closing fence (or EOF)
      out.push(`<pre><code>${escHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // blank line closes the current paragraph
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    // ATX heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const n = h[1].length;
      out.push(`<h${n}>${inline(escHtml(h[2].trim()))}</h${n}>`);
      i++;
      continue;
    }

    // pipe table: a row containing | immediately followed by a separator row
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(splitRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${header.map((c) => `<th>${inline(escHtml(c))}</th>`).join("")}</tr></thead>`;
      const tbody = body.length
        ? `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(escHtml(c))}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      out.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${inline(escHtml(it.trim()))}</li>`).join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${inline(escHtml(it.trim()))}</li>`).join("")}</ol>`);
      continue;
    }

    // ordinary prose line: accumulate into the open paragraph
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}

export interface ReportMeta {
  title: string;
  reproduce: string;
  summary: string;
}

/** Strip inline Markdown markers to plain text (for the short summary/preview only). */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/**
 * Pull the display metadata out of a report: the first ATX H1 as the title, the `Reproduce:` command
 * if present, and the first prose paragraph after the title (tables/headings/code skipped) as a
 * short plain-text summary. Never throws; falls back to sensible empties.
 */
export function extractMeta(md: string): ReportMeta {
  const text = String(md ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  let title = "";
  for (const l of lines) {
    const h = /^#\s+(.*)$/.exec(l.trim());
    if (h) {
      title = stripInline(h[1].trim());
      break;
    }
  }

  let reproduce = "";
  const r = /Reproduce:\s*`([^`]+)`/.exec(text);
  if (r) reproduce = r[1].trim();

  // first prose paragraph strictly after the H1
  const buf: string[] = [];
  let seenTitle = false;
  for (const l of lines) {
    const t = l.trim();
    if (!seenTitle) {
      if (/^#\s+/.test(t)) seenTitle = true;
      continue;
    }
    if (!t) {
      if (buf.length) break;
      continue;
    }
    if (/^#/.test(t) || /^[|`>]/.test(t) || /^\s*[-*+]\s+/.test(t) || /^\s*\d+\.\s+/.test(t)) {
      if (buf.length) break;
      continue;
    }
    if (/^Reproduce:/i.test(t)) continue;
    buf.push(t);
  }
  let summary = stripInline(buf.join(" ")).replace(/\s+/g, " ").trim();
  if (summary.length > 240) summary = summary.slice(0, 237).replace(/\s+\S*$/, "") + "...";

  return { title: title || "Research report", reproduce, summary };
}
