// Normalize an exported Solana secret key into the JSON byte-array format that the
// SOLANA_KEYPAIR Worker secret expects (64 bytes, web3 v2 Keypair.fromSecretKey).
//
// Accepts either:
//   - a base58-encoded 64-byte secret key (Phantom: Settings > Security > Show Secret Key,
//     or Solflare export)
//   - a JSON array of 64 numbers (solana-keygen id.json format)
// read from a LOCAL UNTRACKED file passed as argv[2]. The normalized array is written to
// stdout so it can be piped straight into wrangler without ever touching the shell
// history or the chat log:
//
//   tsx scripts/wallet-import.ts out/my-wallet.txt | npx wrangler secret put SOLANA_KEYPAIR
//
// Treat the stdout as secret material: pipe it, do not echo it. The source file should be
// deleted (or kept untracked) after the secret is uploaded.

import { readFileSync } from "node:fs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Standard big-number base58 decode (leading '1' chars become leading zero bytes). */
function base58Decode(input: string): Uint8Array {
  const digits: number[] = [0]; // little-endian base-256 accumulator
  for (const ch of input) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 character: ${ch}`);
    let carry = idx;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { digits.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) out[zeros + i] = digits[digits.length - 1 - i];
  return out;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/wallet-import.ts <file-with-base58-or-json-array>");
  process.exit(2);
}
const raw = readFileSync(path, "utf8").trim();
const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw) as number[]) : base58Decode(raw);
if (bytes.length !== 64) {
  console.error(`expected a 64-byte secret key, got ${bytes.length} bytes (Phantom: Settings > Security > Show Secret Key; solana-keygen: id.json)`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(Array.from(bytes)));
