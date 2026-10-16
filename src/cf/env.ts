// Cloudflare Workers bindings for the Space Data Rig edge app.
//
// Mirrors wrangler.toml. Values (CODE_VERSION, SOLANA_RPC, ...) arrive via [vars];
// secrets (OPENAI_API_KEY, SOLANA_KEYPAIR, ...) arrive via `wrangler secret put`.
// The global types (Fetcher, DurableObjectNamespace, R2Bucket, Workflow) come from
// @cloudflare/workers-types.

import type { RunParams } from "./run-types.ts";
import type { RigStateDO } from "./rig-state.do.ts";

export interface Env {
  /** Static frontend assets (index.html, app.js, styles.css, space.js, vendor/three.js). */
  ASSETS: Fetcher;
  /** Authoritative rig state + real-time WebSocket fan-out. */
  RIG_STATE: DurableObjectNamespace<RigStateDO>;
  /** Reproducible bundle artifacts (SVG plots, manifest.json, HASH.txt). */
  RIG_ARTIFACTS: R2Bucket;
  /** Durable, CPU-budgeted pipeline run. */
  RIG_RUN: Workflow<RunParams>;

  // ---- non-secret vars (wrangler.toml [vars]) ----
  CODE_VERSION?: string;
  /** public fallback RPC(s), comma-separated; the private endpoint is a secret. */
  SOLANA_RPC_FALLBACKS?: string;
  DISCUSSION_MODE?: string;
  /** "1" enables the token-free TESS-SPOC public S3 photometry tier (off by default). */
  MAST_S3?: string;
  /**
   * "1" enables pixel-level false-positive vetting in the critic for REAL photometry runs
   * (in-transit photocenter displacement). Off by default: with it off the run path and
   * its bundle hash are byte-for-byte unchanged.
   */
  VET?: string;
  /**
   * "1" enables the per-sector ROBUST depth estimator for REAL multi-sector SPOC photometry: instead
   * of trusting the single best-fit box depth, it characterises each sector locally and takes the
   * robust MEDIAN depth (p12/p14 measured this beats a naive long fold for long periods). OFF by
   * default: with it unset the scout step and the whole run path -- and the bundle hash -- are
   * byte-for-byte unchanged. Enabling it changes reported depth for long-period targets, so it is a
   * deliberate, deployed-in-a-safe-window decision, never flipped silently.
   */
  PERSECTOR?: string;
  /**
   * "1" opts the critic into RECOVERY gating (benchmark self-test): the verdict is anchored on the
   * period error vs the known truth. DEFAULT off = BLIND, the honest protocol -- the verdict is
   * driven only by evidence and the truth period is a post-hoc, non-gating cross-check; a blind
   * signal with no catalog match is capped at needs-more-data, never auto-accepted as a discovery.
   */
  RECOVERY_GATING?: string;
  /**
   * Autonomous-research knobs. All default OFF so a deploy with the cron trigger
   * present still does nothing until these are set explicitly.
   *   AUTO_RESEARCH        "1" lets the cron schedule start an autonomous run; any
   *                        other value (the default) makes the scheduled handler a
   *                        no-op.
   *   AUTO_RESEARCH_TARGETS targets per autonomous run (clamped 1..8, default 3).
   *   AUTO_RESEARCH_TMAG    brightness cut for autonomous runs (default 10).
   *   AUTO_ANCHOR           "off" (default) | "dry" (memo preview, no spend) | "live"
   *                        (real mainnet anchor, only within AUTO_ANCHOR_DAILY_CAP).
   *   AUTO_ANCHOR_DAILY_CAP max LIVE anchors per UTC day from the fee wallet; 0 (the
   *                        default) means live mode still spends nothing.
   */
  AUTO_RESEARCH?: string;
  AUTO_RESEARCH_TARGETS?: string;
  AUTO_RESEARCH_TMAG?: string;
  AUTO_ANCHOR?: string;
  AUTO_ANCHOR_DAILY_CAP?: string;
  /**
   * Named-observation anchoring gate, mirroring AUTO_ANCHOR but for the commissioned sdr:observe:1 records.
   *   OBSERVE_ANCHOR = "off" (default) -> a valid $SDR burn seals the record but NEVER anchors it (no spend).
   *   OBSERVE_ANCHOR = "dry"           -> previews the observe memo (dryRun); no fee payer touched, no SOL spent.
   *   OBSERVE_ANCHOR = "live"          -> real mainnet anchor, only while the per-UTC-day count stays under
   *                                        OBSERVE_ANCHOR_DAILY_CAP (default 0, so "live" spends nothing until
   *                                        a cap is set; the literal "unlimited" removes the ceiling). Inert by
   *                                        default: an operator flips it to enable.
   */
  OBSERVE_ANCHOR?: string;
  OBSERVE_ANCHOR_DAILY_CAP?: string;

  // ---- optional secrets (wrangler secret put) ----
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  DISCUSSION_MODEL?: string;
  /** second-provider chat key (xAI Grok, OpenAI-compatible); runs alongside the primary. */
  GROK_API_KEY?: string;
  XAI_API_KEY?: string;
  GROK_BASE_URL?: string;
  GROK_MODEL?: string;
  /** private (first-choice) Solana mainnet RPC URL, e.g. an Alchemy endpoint. */
  SOLANA_RPC?: string;
  /** mainnet fee-payer secret key as a JSON byte array (web3 v2). */
  SOLANA_KEYPAIR?: string;
  /**
   * Admin bearer token gating the state-changing endpoints (/api/run, /api/anchor/*).
   * DENY-BY-DEFAULT (audit-10 #7): unset/empty CLOSES those mutations (every request 401s),
   * so this code can never ship leaving run/anchor open. Set it with `wrangler secret put
   * ADMIN_TOKEN`; from then on a mutating request must carry `Authorization: Bearer <token>`
   * and match exactly (constant-time). The autonomous cron does NOT use these routes, so it is
   * unaffected; only the dashboard's manual run/anchor buttons need the token.
   */
  ADMIN_TOKEN?: string;
}
