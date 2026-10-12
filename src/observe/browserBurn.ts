// BROWSER BURN HELPER for naming an observation (the client half of the x402 paid path).
//
// Bundled by esbuild into web/vendor/solana-burn.js and loaded by the front-end. It builds a Token-2022 Burn of
// EXACTLY 10,000 $SDR (1e10 base units, 6 decimals) from the user's OWN associated token account, has their
// wallet (Phantom) sign + submit it, waits for FINALITY, and returns the transaction SIGNATURE. It never talks
// to our API and produces nothing the server trusts -- the edge independently RE-READS this signature from the
// chain and re-verifies the burn (see burnVerify.ts) before it runs the search or anchors anything.
//
// Why hand-encode the Burn instead of @solana/spl-token: keeps the browser bundle to a single dependency
// (@solana/web3.js). The Token-2022 Burn instruction is discriminant byte 8 followed by a u64 little-endian
// amount, accounts [ATA, mint, owner-signer] -- identical layout to the legacy SPL Burn.
//
// NOTE: this file lives under src/ so it is covered by `typecheck:all`; it therefore avoids DOM globals
// (uses `globalThis`) and BigInt literals (1e10 fits exactly in a double; bytes are split by division).

import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

/** The $SDR mint (verified on mainnet): Token-2022, 6 decimals, no mint/freeze authority. */
export const SDR_MINT = "FvSE99EkoiTY8Wv34V2RpWVNxnrLe7o9gyKnd4HddtjQ";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** The exact cost of one observation in atomic base units: 10000 * 10^6. */
export const BURN_AMOUNT_RAW = 10000000000;

/** u64 little-endian bytes for a value that fits exactly in a JS double (< 2^53). */
function u64Le(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58-encode bytes (bitcoin/Solana alphabet). Inlined instead of pulling a bs58 package into the browser
 * bundle: keeps solana-burn.js at exactly one dependency. Pure integer arithmetic on values < 2^31 per step,
 * so no BigInt and double-safe for transaction-sized inputs.
 */
function bs58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < zeros; i++) out += B58_ALPHABET[0];
  for (let j = digits.length - 1; j >= 0; j--) out += B58_ALPHABET[digits[j]];
  return out;
}

/** Wrap a thrown wallet error so the UI shows the provider's numeric code -- Phantom codes like -32603 or the
 * undocumented 8100002 distinguish "you declined" from "send/simulate failed" from a version mismatch. */
function walletError(e: unknown): Error {
  const err = e as { code?: number | string; message?: string };
  const code = err && err.code !== undefined ? ` (wallet error code ${err.code})` : "";
  const msg = err && err.message ? err.message : String(e);
  if (/reject|denied|cancel|abort/i.test(msg)) {
    return new Error("you declined the burn in your wallet - nothing was spent");
  }
  return new Error("wallet could not sign and send the burn" + code + ": " + msg + " - if this transaction did not land on-chain, nothing was burned");
}

interface WalletProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(opts?: unknown): Promise<{ publicKey: { toBase58(): string } | null } | undefined>;
  request?(req: { method: string; params: unknown }): Promise<{ signature?: string } | string>;
  signAndSendTransaction?(tx: Transaction, opts?: unknown): Promise<{ signature: string } | string>;
}

/** Resolve the injected Solana provider (Phantom preferred), or null if none is present. */
function getProvider(): WalletProvider | null {
  const g = globalThis as unknown as { solana?: WalletProvider & { phantom?: WalletProvider } };
  const s = g.solana;
  if (!s) return null;
  return s.phantom ?? s;
}

export interface BurnResult {
  signature: string;
  payer: string;
  ata: string;
}

/** The $SDR associated token account for `owner` under the Token-2022 program (async PDA derivation). */
async function deriveAta(owner: PublicKey): Promise<PublicKey> {
  const tokenProgram = new PublicKey(TOKEN_2022_PROGRAM_ID);
  const mint = new PublicKey(SDR_MINT);
  const ataProgram = new PublicKey(ATA_PROGRAM_ID);
  const [ata] = await PublicKey.findProgramAddress(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ataProgram,
  );
  return ata;
}

/**
 * Build, sign and send a Token-2022 Burn of exactly BURN_AMOUNT_RAW $SDR from the connected wallet's ATA.
 * Throws with a plain, honest message if there is no wallet, the wallet declines, or the balance is short --
 * in every throw case NOTHING was burned and NOTHING is charged. On success the tx is confirmed `finalized`
 * so the server's on-chain read cannot race a still-propagating transaction.
 */
export async function burnForObservation(rpcUrl: string): Promise<BurnResult> {
  const provider = getProvider();
  if (!provider) throw new Error("no Solana wallet detected (install Phantom to commission an observation)");

  const conn = new Connection(rpcUrl, "confirmed");

  let ownerB58: string;
  if (provider.publicKey) {
    ownerB58 = provider.publicKey.toBase58();
  } else {
    const res = await provider.connect();
    if (!res || !res.publicKey) throw new Error("wallet connection was not authorized");
    ownerB58 = res.publicKey.toBase58();
  }
  const owner = new PublicKey(ownerB58);

  const mint = new PublicKey(SDR_MINT);
  const tokenProgram = new PublicKey(TOKEN_2022_PROGRAM_ID);
  const ata = await deriveAta(owner);

  const bal = await conn.getTokenAccountBalance(ata);
  const held = Number(bal.value.amount);
  if (!Number.isFinite(held) || held < BURN_AMOUNT_RAW) {
    throw new Error(`this wallet holds ${held} base units of $SDR; commissioning burns exactly ${BURN_AMOUNT_RAW} (10,000 $SDR)`);
  }

  // Token-2022 Burn: discriminant 8 + u64 LE amount; accounts [ATA(w), mint(w), owner(signer)].
  const data = new Uint8Array(1 + 8);
  data[0] = 8;
  data.set(u64Le(BURN_AMOUNT_RAW), 1);
  const ix = new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  // Send path matters more than it looks. This bundle builds a web3.js v3 Transaction, whose sign()/serialize()
  // are ASYNC; handing Phantom the raw OBJECT relies on v1's synchronous contract and is fragile. The
  // documented low-level path passes a STRING and lets the wallet deserialize with its own web3.js copy. Two
  // string shapes exist in the wild and Phantom versions disagree about which they accept:
  //   (a) the FULL UNSIGNED WIRE: empty signature table + message. This is what Phantom actually deserializes --
  //       verified live against spacedatarig.app: passing only (b) makes Phantom throw
  //       "Transaction message version 2 deserialization is not supported" (its VersionedTransaction reader
  //       misaligns on the bare message and reads a version header out of account bytes).
  //   (b) the BARE MESSAGE (serializeMessage, still SYNC in v3) -- the shape Phantom's docs example shows.
  // We send (a) first; only if the wallet complains about DESERIALIZATION (before ever prompting the user) do
  // we retry (b). Any other error (decline, simulate-fail) surfaces immediately -- no repeated popups, and if
  // nothing lands on-chain nothing is burned.
  const unsignedWire = await tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const bareMessage = tx.serializeMessage();
  const forms: { label: string; bytes: Uint8Array }[] = [
    { label: "unsigned-wire", bytes: unsignedWire },
    { label: "bare-message", bytes: bareMessage },
  ];
  let signature: string | undefined;
  try {
    if (typeof provider.request === "function") {
      let lastErr: unknown;
      for (let i = 0; i < forms.length; i++) {
        try {
          const sent = await provider.request({ method: "signAndSendTransaction", params: { message: bs58Encode(forms[i].bytes) } });
          signature = typeof sent === "string" ? sent : sent.signature;
          break;
        } catch (e) {
          lastErr = e;
          const m = String((e as Error)?.message ?? e);
          const isDeserializeComplaint = /deserializ|message version/i.test(m);
          if (!isDeserializeComplaint || i === forms.length - 1) throw e;
        }
      }
      if (!signature && lastErr) throw lastErr;
    } else if (typeof provider.signAndSendTransaction === "function") {
      const sent = await provider.signAndSendTransaction(tx, { skipPreflight: false });
      signature = typeof sent === "string" ? sent : sent.signature;
    } else {
      throw new Error("the detected wallet does not expose signAndSendTransaction or a request() interface");
    }
  } catch (e) {
    throw walletError(e);
  }
  if (!signature) throw new Error("the wallet reported success but returned no transaction signature");
  await conn.confirmTransaction(signature, "finalized");

  return { signature, payer: ownerB58, ata: ata.toBase58() };
}
