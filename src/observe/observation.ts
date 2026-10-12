// OBSERVATION ENVELOPE CONTRACT (named-observation feature).
//
// A commissioned "named observation" must NOT be able to buy a different scientific answer. So the science
// bundle produced for the chosen TIC is byte-for-byte identical to what the rig would emit for that target
// anyway -- the dedication and payment details live in a SEPARATE, additive observation envelope that we
// hash and anchor under its own memo namespace (sdr:observe:1). The envelope commits to BOTH the (sanitized)
// dedication and the science bundle hash, so the public on-chain record provably ties "this dedication, this
// payment" to "exactly this reproducible result" -- including a null result ("no transit detected").
//
// This module is the trust boundary: validateObservation refuses any record that dares to carry a discovery
// claim, and refuses a payment that is not the exact $SDR burn. PURE + OFFLINE (no worker import, no chain).

import { canonicalJson, sha256Hex } from "../bundle/bundle.ts";
import { OBSERVATION_COST_RAW, SDR_MINT, X402_NETWORK } from "./paymentPolicy.ts";
import { sanitizeDedication } from "./dedication.ts";

export const OBSERVATION_SCHEMA = "sdr-observation/1";

export type ObservationStatus =
  | "awaiting-payment"
  | "paid-verifying"
  | "queued"
  | "running"
  | "sealed"
  | "anchored"
  | "rejected";

const STATUSES: ObservationStatus[] = [
  "awaiting-payment",
  "paid-verifying",
  "queued",
  "running",
  "sealed",
  "anchored",
  "rejected",
];

export interface ObservationRecord {
  schema: typeof OBSERVATION_SCHEMA;
  observationId: string;
  createdAt: string; // ISO timestamp
  /** the target star; sector may be null until the pipeline resolves which TESS sector(s) cover it */
  tic: number;
  sector: number | null;
  /** the SANITIZED dedication text actually sealed (never the raw user input) */
  dedication: string;
  payment: {
    network: typeof X402_NETWORK;
    mint: string;
    amountRaw: string; // atomic units, decimal string
    scheme: "burn";
    txSignature: string | null; // null until a verified burn is observed
    verified: boolean;
  };
  science: {
    bundleHash: string | null; // null until the run is sealed
    verdict: string | null; // e.g. "accepted" | "needs-more-data" | "rejected" | "no-transit"
  };
  anchor: {
    memo: string | null;
    signature: string | null;
  };
  status: ObservationStatus;
  /** honesty invariant: a named observation is NEVER a discovery claim */
  discoveryClaim: false;
}

export type ObservationValidation =
  | { ok: true; record: ObservationRecord }
  | { ok: false; errors: string[] };

/**
 * The hash that binds a dedication to a science result. Computed over a canonical object so it is
 * reproducible; this is what goes into the sdr:observe:1 memo. Async because sha256Hex uses WebCrypto.
 */
export function observeEnvelopeHash(dedication: string, bundleHash: string): Promise<string> {
  return sha256Hex(canonicalJson({ dedication, bundleHash }));
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/**
 * Validate an unknown blob against the observation contract. The load-bearing rules: schema must match,
 * discoveryClaim MUST be false, the payment must name the exact $SDR mint + exact cost + burn scheme, and
 * the dedication must already be the sanitized form (re-sanitizing it must be a no-op).
 */
export function validateObservation(obj: unknown): ObservationValidation {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null) return { ok: false, errors: ["observation is not an object"] };
  const r = obj as Record<string, unknown>;

  if (r.schema !== OBSERVATION_SCHEMA) errors.push(`schema must be "${OBSERVATION_SCHEMA}"`);
  if (!isNonEmptyString(r.observationId)) errors.push("observationId must be a non-empty string");
  if (!isNonEmptyString(r.createdAt)) errors.push("createdAt must be a non-empty string");
  if (typeof r.tic !== "number" || !Number.isFinite(r.tic) || r.tic <= 0) errors.push("tic must be a positive finite number");
  if (!(r.sector === null || (typeof r.sector === "number" && Number.isFinite(r.sector)))) errors.push("sector must be a number or null");

  if (r.discoveryClaim !== false) errors.push(`discoveryClaim MUST be false (got ${JSON.stringify(r.discoveryClaim)})`);

  if (!isNonEmptyString(r.dedication)) {
    errors.push("dedication must be a non-empty string");
  } else {
    // the sealed dedication must already satisfy the sanitizer (no raw/unsanitized text stored)
    const resan = sanitizeDedication(r.dedication);
    if (!resan.ok) errors.push("dedication does not satisfy the sanitizer policy");
    else if (resan.value !== r.dedication) errors.push("dedication is not in normalized (sanitized) form");
  }

  const pay = r.payment as Record<string, unknown> | undefined;
  if (!pay || typeof pay !== "object") {
    errors.push("payment object missing");
  } else {
    if (pay.network !== X402_NETWORK) errors.push(`payment.network must be "${X402_NETWORK}"`);
    if (pay.mint !== SDR_MINT) errors.push("payment.mint must be the $SDR mint");
    if (pay.scheme !== "burn") errors.push('payment.scheme must be "burn"');
    if (typeof pay.amountRaw !== "string" || pay.amountRaw !== OBSERVATION_COST_RAW.toString()) {
      errors.push(`payment.amountRaw must be exactly "${OBSERVATION_COST_RAW.toString()}"`);
    }
    if (typeof pay.verified !== "boolean") errors.push("payment.verified must be a boolean");
    if (!(pay.txSignature === null || isNonEmptyString(pay.txSignature))) errors.push("payment.txSignature must be a string or null");
  }

  const sci = r.science as Record<string, unknown> | undefined;
  if (!sci || typeof sci !== "object") {
    errors.push("science object missing");
  } else {
    if (!(sci.bundleHash === null || isNonEmptyString(sci.bundleHash))) errors.push("science.bundleHash must be a string or null");
    if (!(sci.verdict === null || isNonEmptyString(sci.verdict))) errors.push("science.verdict must be a string or null");
  }

  const anchor = r.anchor as Record<string, unknown> | undefined;
  if (!anchor || typeof anchor !== "object") {
    errors.push("anchor object missing");
  } else {
    if (!(anchor.memo === null || isNonEmptyString(anchor.memo))) errors.push("anchor.memo must be a string or null");
    if (!(anchor.signature === null || isNonEmptyString(anchor.signature))) errors.push("anchor.signature must be a string or null");
  }

  if (typeof r.status !== "string" || !STATUSES.includes(r.status as ObservationStatus)) {
    errors.push(`status must be one of: ${STATUSES.join(", ")}`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: obj as ObservationRecord };
}
