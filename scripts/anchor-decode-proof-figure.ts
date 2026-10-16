// audit-3 on-chain proof figure -- the scienceHash-now-reaches-the-chain result, decoded from mainnet.
// All-text, ASCII only, deterministic; states only publicly-decoded facts (no DB claims). npm run figure:anchor-proof
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let texts = 0;
const T = (x: number, y: number, s: string, size = 15, fill = "#e8ecf7", weight = "400") => {
  texts++;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="ui-sans-serif,system-ui,Arial">${esc(s)}</text>`;
};
const W = 1200, H = 620;
const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#141b33" stroke="#26314f"/>`;

const bg = `<rect width="${W}" height="${H}" fill="#0b1020"/>`;
const head = T(28, 44, "scienceHash reaches the chain -- decoded from Solana mainnet, not our database", 21, "#e8ecf7", "800")
  + T(28, 70, "The third-round audit found the content address was computed but never actually written on-chain. After the fix + deploy, we re-read the real transactions.", 13, "#9fb0d6");

// Panel: legacy (pre-deploy) -- 3-field
let a = card(28, 100, 560, 250) + T(50, 130, "Before (pre-deploy anchors)", 17, "#ff6b6b", "800");
a += T(50, 162, "sdr:1 | finding | bundleHash", 14, "#e8ecf7", "600");
a += T(50, 186, "3 fields -- no content address on the chain.", 12.5, "#9fb0d6");
a += T(50, 224, "F-HAT-P-11-b", 13, "#e8ecf7", "700");
a += T(220, 224, "3 fields", 13, "#ff6b6b", "800");
a += T(340, 224, "Oct 12", 12, "#9fb0d6");
a += T(50, 252, "F-pi-Men-c", 13, "#e8ecf7", "700");
a += T(220, 252, "3 fields", 13, "#ff6b6b", "800");
a += T(340, 252, "Oct 12", 12, "#9fb0d6");
a += T(50, 280, "F-KELT-9-b", 13, "#e8ecf7", "700");
a += T(220, 280, "3 fields", 13, "#ff6b6b", "800");
a += T(340, 280, "Oct 12", 12, "#9fb0d6");
a += T(50, 316, "Immutable history -- these stay 3-field by design, and that is correct.", 12, "#9fb0d6");

// Panel: post-deploy -- 4-field
let b = card(612, 100, 560, 250) + T(634, 130, "After (first post-deploy anchors)", 17, "#37d39b", "800");
b += T(634, 162, "sdr:1 | finding | bundleHash | scienceHash", 14, "#e8ecf7", "600");
b += T(634, 186, "4 fields -- the content address is now on-chain.", 12.5, "#9fb0d6");
b += T(634, 224, "F-HR-858-b", 13, "#e8ecf7", "700");
b += T(804, 224, "4 fields", 13, "#37d39b", "800");
b += T(924, 224, "Oct 16 02:16", 12, "#9fb0d6");
b += T(634, 252, "F-HR-858-d", 13, "#e8ecf7", "700");
b += T(804, 252, "4 fields", 13, "#37d39b", "800");
b += T(924, 252, "Oct 16 02:18", 12, "#9fb0d6");
b += T(634, 280, "F-WASP-189-b", 13, "#e8ecf7", "700");
b += T(804, 280, "4 fields", 13, "#37d39b", "800");
b += T(924, 280, "Oct 16 02:21", 12, "#9fb0d6");
b += T(634, 316, "bundleHash still at position 2 -> verification unaffected (match).", 12, "#9fb0d6");

// Footer: method
let f = card(28, 372, 1144, 210) + T(50, 402, "How this is verified (no admin token, no spend)", 17, "#5aa9ff", "800");
f += T(50, 436, "1  Read the public /api/ledger to list anchored rows and their transaction signatures.", 13, "#e8ecf7", "400");
f += T(50, 464, "2  Re-read each transaction straight from the Solana mainnet RPC (jsonParsed), decode the SPL Memo string.", 13, "#e8ecf7", "400");
f += T(50, 492, "3  Count the pipe-delimited fields; cross-check position 2 equals the stored bundleHash.", 13, "#e8ecf7", "400");
f += T(50, 520, "4  The chain itself is the source of truth -- a database field is not proof of what was written on-chain.", 13, "#e8ecf7", "400");
f += T(50, 556, "Reproduce it:  npm run p9:decode-memo  (read-only)  //  spacedatarig.app", 13, "#9fb0d6", "600");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  + bg + head + a + b + f + `</svg>\n`;
import { writeFileSync } from "node:fs";
writeFileSync("web/anchor-decode-proof.svg", svg);
const nonascii = (svg.match(/[^\x00-\x7F]/g) || []).length;
console.log(`wrote web/anchor-decode-proof.svg bytes=${Buffer.byteLength(svg)} textNodes=${texts} nonASCII=${nonascii}`);
if (nonascii !== 0) { console.error("NON-ASCII PRESENT"); process.exitCode = 1; }
