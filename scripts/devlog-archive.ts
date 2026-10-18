// Archive a long-form summary that was pushed to the public feed, so devlog/ holds the SAME BYTES the feed holds.
//
// WHY a script and not a pasted copy: devlog/ exists to make a public post auditable against the commits it
// describes. If the archived text is re-typed it can drift from what was dispatched -- a softened number, a dropped
// hedge -- and then the archive is worse than useless, because it looks authoritative. Composing the file from the
// exact bytes that were handed to the dispatcher removes that failure mode.
//
// The pushed text is normalised the same way the dispatcher normalises it (CRLF -> LF, trailing newlines trimmed),
// because that is what actually went out; on a Windows checkout the working copy of a text file is CRLF while the
// bytes sent were LF.
//
// Usage:
//   npx tsx scripts/devlog-archive.ts --text-file <pushed.txt> --evidence-file <header.md> --out devlog/<slug>.md
//
// --evidence-file is plain markdown written by hand: the dispatch status, the Actions run, the posted tweet id, the
// job-log line proving it went out, and the pre-flight result. This script only appends the verbatim text below it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function arg(name: string, dflt = ""): string {
  const argv = process.argv;
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

function read(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  } catch (e) {
    console.error(`devlog-archive: cannot read ${what} at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const textFile = arg("text-file");
const evidenceFile = arg("evidence-file");
const out = arg("out");
if (!textFile || !evidenceFile || !out) {
  console.error("devlog-archive: --text-file, --evidence-file and --out are all required");
  process.exit(1);
}

const text = read(textFile, "the pushed text");
const evidence = read(evidenceFile, "the evidence header");
if (!text) {
  console.error("devlog-archive: the pushed text is empty; nothing to archive");
  process.exit(1);
}
// A fence inside the text would terminate the block early and silently truncate the archive.
if (text.includes("```")) {
  console.error("devlog-archive: the pushed text contains a code fence; refusing to archive it inside one");
  process.exit(1);
}
// The archive is a repository file, and the text it holds was already refused by post-x-text.ts if it carried a
// non-ASCII byte -- so a non-ASCII byte HERE means the archive is not holding the pushed text.
const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 126);
if (nonAscii.length > 0) {
  console.error(`devlog-archive: the pushed text has ${nonAscii.length} non-ASCII character(s); it cannot be what was posted`);
  process.exit(1);
}

const dir = dirname(out);
if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
const md = `${evidence}\n\n## Text as pushed\n\n\`\`\`\n${text}\n\`\`\`\n`;
writeFileSync(out, md, "utf8");
console.log(`devlog-archive: wrote ${out} (${md.length} bytes; pushed text ${text.length} chars, ${text.split("\n").length} line(s))`);
