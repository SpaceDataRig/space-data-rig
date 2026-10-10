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
}
