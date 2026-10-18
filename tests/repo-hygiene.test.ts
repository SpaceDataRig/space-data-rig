// Repository hygiene gate: the single rule the project may not break, enforced where breaking it is loud.
//
// WHY THIS FILE EXISTS (audit b4, 2026-10-18). Everything user-facing in this repository is published in
// English -- docs, code comments, feed text, the web frontend. That was policed only by a scratch script
// under out/, which is .gitignored: CI never ran it, and a fresh clone could not reproduce the check. The
// gap is not hypothetical -- while writing the HANDOFF pitfall for this very audit, two Chinese characters
// were typed into HANDOFF.md and survived only because someone re-read the diff by eye. A rule with no
// gate is a preference.
//
// Two properties, both cheap and both structural:
//  1. NO CJK / kana / Hangul / fullwidth forms anywhere in the human-readable source of the repo. Latin
//     scripts cannot be flagged automatically (an English sentence and a French one look alike to a
//     regex), but a stray non-English ideograph is what actually leaks when an assistant or a translated
//     snippet is pasted into a doc, and it is exactly what a scanner can prove absent.
//  2. NO private key material. Deliberately narrow -- a PEM private-key header -- because the honest
//     alternatives (64-hex, long base58) collide with real content here: reports/ legitimately quotes
//     transaction hashes and public keys. A secret scanner that fires on legitimate science data gets
//     turned off, so this one checks only the shape that has no legitimate use in this repository.
//
// Deterministic and offline: it reads files and asserts. No network, no clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directories that are either third-party, generated, or explicitly never published.
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "out", "dist", "state", "coverage", ".next"]);

// Only scan things a human could plausibly have written prose into.
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".cjs", ".mjs", ".json", ".md", ".yml", ".yaml", ".html", ".css", ".scss",
  ".toml", ".txt", ".sh", ".ps1", ".example",
]);

// CJK ideographs, kana, Hangul, and the fullwidth punctuation that only appears beside them.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffff]/;

const PRIVATE_KEY_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function listFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(join(dir, entry.name), into);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    // dotfiles like .gitignore / .env.example carry no extension worth checking twice, but .env.example is
    // the template a human copies, so include extension-less dotfiles explicitly.
    if (!TEXT_EXT.has(ext) && !entry.name.startsWith(".")) continue;
    into.push(join(dir, entry.name));
  }
  return into;
}

function scan(): { files: number; cjk: string[]; pem: string[] } {
  const out = { files: 0, cjk: [] as string[], pem: [] as string[] };
  for (const f of listFiles(root)) {
    let body: string;
    try {
      if (statSync(f).size > 4 * 1024 * 1024) continue; // a vendored monster is not prose
      body = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    out.files++;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const rel = f.slice(root.length + 1).split(/[\\/]/).join("/");
      if (CJK.test(lines[i])) out.cjk.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 100)}`);
      if (PRIVATE_KEY_PEM.test(lines[i])) out.pem.push(`${rel}:${i + 1}`);
    }
  }
  return out;
}

const found = scan();

test(`the repository holds ${found.files} human-readable files, so the scan is not vacuous`, () => {
  // A gate that silently scans nothing is worse than no gate: it reports green forever. The floor is well
  // below the real count and only fails if the walk itself broke (denylist typo, path separator, cwd shift).
  assert.ok(found.files > 200, `only ${found.files} files scanned -- the walker is broken, not the repo`);
});

test("no user-facing file contains CJK, kana, Hangul or fullwidth forms", () => {
  assert.deepEqual(found.cjk, [], "every published surface of this project is English");
});

test("no private key material is committed", () => {
  assert.deepEqual(found.pem, [], "PEM private keys have no legitimate use in this repository");
});

test("the scan catches the leak it was written for, instead of passing by accident", () => {
  // Self-check: prove the detector actually fires on the failure mode. Without this, a regex that never
  // matches anything would still make the two assertions above green.
  const sample = "// a comment about \u516c\u5171 keys\n";
  assert.ok(CJK.test(sample), "the CJK class must match a real ideograph");
  assert.ok(!CJK.test("// an ordinary English comment about public keys\n"), "and must not match prose");
  // Assembled, not literal: on its first run this gate scanned its own fixture and reported it as committed
  // key material -- correct behaviour for a scanner, and a hole if this file were exempted instead.
  const head = (label: string) => ["-----BEGIN", label + "-----"].join(" ");
  assert.ok(PRIVATE_KEY_PEM.test(head("PRIVATE KEY")), "the PEM shape must match");
  assert.ok(!PRIVATE_KEY_PEM.test(head("PUBLIC KEY")), "public keys are not secrets");
});
