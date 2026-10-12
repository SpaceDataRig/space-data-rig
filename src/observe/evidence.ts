// OBSERVATION EVIDENCE (named-observation feature, the verifier half).
//
// Proves a sealed observation WITHOUT trusting our own storage: given an envelope hash (or the burn tx signature
// that commissioned it) it reads the stored record, RE-COMPUTES the envelope hash from the dedication + the science
// bundle hash and checks it still matches (tamper-evidence), and independently verifies the sdr:observe:1 anchor
// on-chain via an injected verifier (the route passes one that walks the RPC endpoints). The chain verifier itself
// lives at the edge/Node boundary, so this module stays pure and shared by both runtimes.
//
// Runtime-agnostic: only touches the ArtifactStore port + pure hashing + an injected verify callback.

import type { ArtifactStore } from "../core/ports.ts";
import type { VerifyResult } from "../solana/anchor-core.ts";
import { explorerUrl } from "../solana/anchor-core.ts";
import { observeEnvelopeHash } from "./observation.ts";

export interface ObservationEvidence {
  ok: boolean;
  status: number;
  reason?: string;
  envelopeHash?: string;
  record?: Record<string, unknown>;
  anchor?: { memo?: string; signature?: string; slot?: number; explorerUrl?: string } | null;
  verify?: VerifyResult | null;
  recomputedHash?: string;
  integrityMatches?: boolean;
  explorerUrl?: string;
}

const recordKey = (h: string) => `observations/${h}/record.json`;
const anchorKey = (h: string) => `observations/${h}/anchor.json`;
const sigKey = (s: string) => `observations/by-sig/${s}.json`;

/** Resolve an envelope hash from either a supplied hash or the burn signature that spent it. */
async function resolveEnvelopeHash(store: ArtifactStore, q: { hash?: string; sig?: string }): Promise<string | null> {
  if (q.hash) return q.hash.trim();
  if (q.sig) {
    const text = await store.getText(sigKey(q.sig.trim()));
    if (text) {
      try {
        const rec = JSON.parse(text) as { envelopeHash?: string };
        return rec.envelopeHash ?? null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Assemble + verify the evidence for one observation. `verify` is the injected on-chain checker
 * (signature, envelopeHash) -> VerifyResult; the caller supplies it from its runtime's RPC endpoints.
 */
export async function buildObservationEvidence(
  store: ArtifactStore,
  q: { hash?: string; sig?: string },
  verify: (anchorSignature: string, envelopeHash: string) => Promise<VerifyResult>,
): Promise<ObservationEvidence> {
  const hash = await resolveEnvelopeHash(store, q);
  if (!hash) {
    return {
      ok: false,
      status: 404,
      reason: q.sig
        ? "no sealed observation found for that burn signature"
        : "an observation envelope hash, or the burn transaction signature that commissioned it, is required",
    };
  }

  const recText = await store.getText(recordKey(hash));
  if (!recText) return { ok: false, status: 404, reason: "no sealed observation record for this hash", envelopeHash: hash };
  let parsed: unknown;
  try {
    parsed = JSON.parse(recText);
  } catch {
    return { ok: false, status: 500, reason: "stored observation record is corrupt", envelopeHash: hash };
  }
  const record = (parsed as { record?: Record<string, unknown> }).record ?? (parsed as Record<string, unknown>);

  // Integrity: re-derive the envelope hash from the SAME dedication + science bundle hash and require a match.
  let recomputedHash: string | undefined;
  let integrityMatches = false;
  const dedication = typeof record.dedication === "string" ? record.dedication : null;
  const science = record.science as { bundleHash?: unknown } | undefined;
  const bundleHash = science && typeof science.bundleHash === "string" ? science.bundleHash : null;
  if (dedication && bundleHash) {
    recomputedHash = await observeEnvelopeHash(dedication, bundleHash);
    integrityMatches = recomputedHash === hash;
  }

  let anchor: ObservationEvidence["anchor"] = null;
  const anchorText = await store.getText(anchorKey(hash));
  if (anchorText) {
    try {
      anchor = JSON.parse(anchorText);
    } catch {
      /* anchor file corrupt: fall through, chain check is still authoritative via record.anchor */
    }
  }

  const recAnchor = record.anchor as { signature?: unknown } | undefined;
  const anchorSig = (anchor && typeof anchor.signature === "string" ? anchor.signature : null) ?? (recAnchor && typeof recAnchor.signature === "string" ? recAnchor.signature : null);

  let verifyResult: VerifyResult | null = null;
  if (anchorSig) verifyResult = await verify(anchorSig, hash);

  const onChainOk = !!(verifyResult && verifyResult.ok);
  return {
    ok: integrityMatches && (onChainOk || !anchorSig),
    status: 200,
    envelopeHash: hash,
    record,
    anchor,
    verify: verifyResult,
    recomputedHash,
    integrityMatches,
    explorerUrl: anchorSig ? explorerUrl(anchorSig) : undefined,
  };
}
