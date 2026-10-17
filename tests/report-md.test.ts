// Build-time Markdown-subset renderer guard (scripts/report-md.ts), which turns the committed
// reports/*.md into the static web/reports/ fragments the "Reports" view serves. Offline, deterministic.
// The load-bearing property is SAFETY: raw HTML in a report must be escaped inert, never emitted live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escHtml, slugify, mdToHtml, extractMeta } from "../scripts/report-md.ts";

test("escHtml neutralises every HTML-significant character", () => {
  assert.equal(escHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("SECURITY: raw HTML/script in the source is escaped inert, not emitted as a tag", () => {
  const html = mdToHtml(`# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>`);
  assert.ok(!html.includes("<script>"), "must not emit a live <script>");
  assert.ok(!html.includes("<img"), "must not emit a live <img>");
  assert.ok(html.includes("&lt;script&gt;"), "the tag text is escaped");
  assert.ok(html.includes("&lt;img"), "the img text is escaped");
});

test("headings map to h1..h6 with inline formatting applied", () => {
  const html = mdToHtml(`# H1 **bold**\n\n### H3 \`code\``);
  assert.match(html, /<h1>H1 <strong>bold<\/strong><\/h1>/);
  assert.match(html, /<h3>H3 <code>code<\/code><\/h3>/);
});

test("a pipe table renders thead/tbody and drops the separator row", () => {
  const md = `| metric | value |\n|---|---|\n| recall | 76.9% |\n| precision | 33.3% |`;
  const html = mdToHtml(md);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<thead><tr><th>metric<\/th><th>value<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>recall<\/td><td>76\.9%<\/td>/);
  assert.ok(!html.includes("---"), "the separator row must not appear as content");
});

test("fenced code preserves its contents verbatim and escaped", () => {
  const html = mdToHtml("```ts\nconst a = 1 < 2 && 'x';\n```");
  assert.match(html, /<pre><code>const a = 1 &lt; 2 &amp;&amp; &#39;x&#39;;<\/code><\/pre>/);
});

test("only http/https links become anchors; javascript: URLs stay inert text", () => {
  const ok = mdToHtml(`[NASA](https://exoplanetarchive.ipac.caltech.edu/)`);
  assert.match(ok, /<a href="https:\/\/exoplanetarchive\.ipac\.caltech\.edu\/" target="_blank" rel="noopener">NASA<\/a>/);
  const bad = mdToHtml(`[x](javascript:alert(1))`);
  assert.ok(!bad.includes("<a "), "a non-http scheme must not become a link");
});

test("unordered and ordered lists render li items", () => {
  const ul = mdToHtml(`- one\n- two`);
  assert.match(ul, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  const ol = mdToHtml(`1. first\n2. second`);
  assert.match(ol, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("soft-wrapped prose lines collapse into a single paragraph", () => {
  const html = mdToHtml(`one\ntwo\nthree`);
  assert.equal(html, "<p>one two three</p>");
});

test("slugify produces a URL-safe slug from a report filename", () => {
  assert.equal(slugify("p49-blind-test.md"), "p49-blind-test");
  assert.equal(slugify("P33 Scale ROC.md"), "p33-scale-roc");
  assert.equal(slugify("--weird!!name--.md"), "weird-name");
});

test("extractMeta pulls the H1 title, the Reproduce command, and a prose summary", () => {
  const md = [
    "# P49 formal blind test of the detector",
    "",
    "Reproduce: `npm run p49:blind-test -- --stars 30`",
    "",
    "A seeded coin planted one synthetic planet on some real curves.",
    "The gated detector then ran on every curve.",
    "",
    "| metric | value |",
    "|---|---|",
    "| recall | 76.9% |",
  ].join("\n");
  const m = extractMeta(md);
  assert.equal(m.title, "P49 formal blind test of the detector");
  assert.equal(m.reproduce, "npm run p49:blind-test -- --stars 30");
  assert.match(m.summary, /seeded coin planted one synthetic planet/);
  assert.ok(!m.summary.includes("|"), "the summary skips table rows");
});

test("extractMeta falls back safely on an empty/heading-less document", () => {
  const m = extractMeta("");
  assert.equal(m.title, "Research report");
  assert.equal(m.reproduce, "");
  assert.equal(m.summary, "");
});
