// OBSERVATION COMPUTE (named-observation feature, Phase B -- the real backend, runtime-agnostic).
//
// This is what makes "Name an Observation" actually DO something: given a star (TIC) and a dedication, it
//   1. sanitizes the dedication (same policy as the front-end, enforced server-side),
//   2. resolves which TESS sector(s) observed that TIC (MAST invoke, best-effort) and downloads REAL
//      TESS-SPOC PDCSAP photometry from the token-free public bucket,
//   3. runs the SAME blind, deterministic detection gate the science pipeline uses (BLS + Stage-2 depth
//      screen), and
//   4. seals an observation envelope that binds the dedication to that reproducible result, and builds the
//      sdr:observe:1 memo that WOULD be anchored.
//
// It costs only public-data fetch + CPU -- NO payment is taken and NO transaction is anchored here. Payment
// (the $SDR burn) gates the on-chain ANCHOR, not the compute: running the search is free and open; writing
// the immutable on-chain record is the commissioned step. The verdict is produced by the blind gate and is
// identical to what the rig emits for that star for anyone else -- paying cannot change it.
//
// Dependency-injected fetch keeps it testable + shared by the Worker (edge) and Node (dev) runtimes.

import { fetchSpocLightCurve } from "../data/mastS3.ts";
import { bls } from "../detect/bls.ts";
import { classifyDepthRegime } from "../candidate/falsePositive.ts";
import { downsampleBinned } from "../detect/significance.ts";
import { canonicalJson, sha256Hex } from "../bundle/bundle.ts";
import { buildObserveMemo } from "../solana/anchor-core.ts";
import { sanitizeDedication } from "./dedication.ts";
import { OBSERVATION_SCHEMA, observeEnvelopeHash, validateObservation, type ObservationRecord } from "./observation.ts";
import { OBSERVATION_COST_RAW, SDR_MINT, X402_NETWORK } from "./paymentPolicy.ts";

// CPU guard for the edge: a 2-min-cadence 27-day SPOC curve is ~19k points; bin to <= this before BLS so a
// single synchronous request stays well inside the Worker CPU budget. Binning preserves transit depth.
const OBSERVE_MAX_POINTS = 4000;
const MAST_INVOKE = "https://mast.stsci.edu/api/v0/invoke";

export interface ObserveInput {
  tic: number;
  sector?: number | null;
  dedication: string;
}

export interface ObserveDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ObserveScience {
  sector: number | null;
  points: number;
  spanDays: number;
  periodDays: number;
  depthPpm: number;
  snr: number;
  regime: string;
  verdict: string;
  lightCurveSource: string;
}

export type ObserveOutcome =
  | { ok: true; record: ObservationRecord; memo: string; envelopeHash: string; science: ObserveScience }
  | { ok: false; status: number; error: string; errors?: string[] };

/**
 * Best-effort TIC -> observed-sector resolution via the MAST TESS sector service. Returns a de-duplicated,
 * ascending sector list, or [] on any failure (network, auth, unknown schema) so the caller can fall back to
 * a user-supplied sector. The SPOC download then tries these in order and keeps the first that has a product.
 */
export async function resolveSectorsForTic(tic: number, deps: ObserveDeps = {}): Promise<number[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const request = JSON.stringify({ service: "Mast.Catalogs.Tic.Sector", version: "v0", args: { tic_id: tic } });
    const res = await doFetch(MAST_INVOKE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request }).toString(),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(j?.data) ? j.data : [];
    const secs = rows.map((r) => Number(r.sector ?? r.Sector ?? r.sector_number)).filter((n) => Number.isFinite(n) && n > 0);
    return [...new Set(secs)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Run the full named-observation compute for one request. Never throws; returns a typed outcome. */
export async function computeObservation(input: ObserveInput, deps: ObserveDeps = {}): Promise<ObserveOutcome> {
  const tic = input.tic;
  if (!Number.isInteger(tic) || tic <= 0) return { ok: false, status: 400, error: "tic must be a positive integer" };

  const ded = sanitizeDedication(input.dedication);
  if (!ded.ok) return { ok: false, status: 400, error: "dedication rejected", errors: ded.errors };

  let sectors: number[] = [];
  if (input.sector != null && Number.isFinite(input.sector) && input.sector > 0) sectors = [Math.trunc(input.sector)];
  else sectors = await resolveSectorsForTic(tic, deps);
  if (!sectors.length) return { ok: false, status: 422, error: "could not resolve a TESS sector for this TIC; add a sector or pick a known star" };

  const targetId = `TIC ${tic}`;
  let lc: Awaited<ReturnType<typeof fetchSpocLightCurve>> = null;
  let usedSector: number | null = null;
  for (const s of sectors.slice(0, 6)) {
    const got = await fetchSpocLightCurve(tic, [s], targetId, { fetchImpl: deps.fetchImpl });
    if (got && got.points.length) { lc = got; usedSector = s; break; }
  }
  if (!lc) return { ok: false, status: 404, error: "no usable TESS-SPOC photometry for this target in the resolved sector(s)" };

  const work = downsampleBinned(lc, OBSERVE_MAX_POINTS);
  const det = bls(work);
  const depthPpm = det.depth * 1e6;
  const regime = classifyDepthRegime(depthPpm);
  const significant = det.snr >= 7 && regime.planetPlausible && depthPpm >= 200;
  const verdict = significant ? "candidate-significant" : "no-transit";
  const spanDays = work.points.length > 1 ? work.points[work.points.length - 1].time - work.points[0].time : 0;

  const scienceResult = {
    target: targetId,
    sector: usedSector,
    points: work.points.length,
    spanDays: Math.round(spanDays * 100) / 100,
    periodDays: det.periodDays,
    depthPpm,
    snr: det.snr,
    verdict,
    discoveryClaim: false,
    lightCurveSource: lc.source ?? "TESS-SPOC PDCSAP (REAL photometry)",
  };
  const bundleHash = await sha256Hex(canonicalJson(scienceResult));
  const obsId = `OBS-${tic}`;

  const record: ObservationRecord = {
    schema: OBSERVATION_SCHEMA,
    observationId: obsId,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    tic,
    sector: usedSector,
    dedication: ded.value,
    payment: { network: X402_NETWORK, mint: SDR_MINT, amountRaw: OBSERVATION_COST_RAW.toString(), scheme: "burn", txSignature: null, verified: false },
    science: { bundleHash, verdict },
    anchor: { memo: null, signature: null },
    status: "awaiting-payment",
    discoveryClaim: false,
  };
  const v = validateObservation(record);
  if (!v.ok) return { ok: false, status: 500, error: "internal: observation envelope failed validation", errors: v.errors };

  const envelopeHash = await observeEnvelopeHash(ded.value, bundleHash);
  const memo = buildObserveMemo(obsId, envelopeHash);

  return {
    ok: true,
    record,
    memo,
    envelopeHash,
    science: {
      sector: usedSector,
      points: work.points.length,
      spanDays,
      periodDays: det.periodDays,
      depthPpm,
      snr: det.snr,
      regime: regime.regime,
      verdict,
      lightCurveSource: scienceResult.lightCurveSource,
    },
  };
}
