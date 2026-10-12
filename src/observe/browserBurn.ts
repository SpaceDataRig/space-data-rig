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

interface WalletProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(opts?: unknown): Promise<{ publicKey: { toBase58(): string } | null } | undefined>;
  signAndSendTransaction(tx: Transaction, opts?: unknown): Promise<{ signature: string } | string>;
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

  const sent = await provider.signAndSendTransaction(tx, { skipPreflight: false });
  const signature = typeof sent === "string" ? sent : sent.signature;
  await conn.confirmTransaction(signature, "finalized");

  return { signature, payer: ownerB58, ata: ata.toBase58() };
}
