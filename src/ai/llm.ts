// Optional LLM reasoning layer for the multi-seat discussion.
//
// Provider-agnostic: it speaks the OpenAI-compatible Chat Completions protocol, so it
// targets DeepSeek out of the box and any other OpenAI-compatible endpoint (OpenAI,
// Moonshot, a local server) purely through environment variables. It has nothing to do
// with OpenRig or Claude Code -- those are the separate production agent runtime under
// openrig/. Here we only need a chat model to add reasoning lines to the dashboard.
//
// When no API key is present, llmConfigured() is false and callers use the data-grounded
// narrator instead (see discussion.ts), so the dashboard is always honest and populated.
// The key is read from the environment only: never stored, logged, or written into any
// bundle, artifact, or on-chain record.
//
// A SECOND provider can be wired at the same time so more than one model writes into the
// discussion (see listProviders). Grok (xAI) is OpenAI-compatible, so it needs only its
// own key + base + model, alongside (not instead of) the primary DeepSeek/OpenAI model:
//
//   OPENAI_API_KEY   (or DEEPSEEK_API_KEY)   primary key
//   OPENAI_BASE_URL  default https://api.deepseek.com/v1
//   OPENAI_MODEL     default deepseek-chat
//
//   GROK_API_KEY     (or XAI_API_KEY)         second-provider key
//   GROK_BASE_URL    default https://api.x.ai/v1
//   GROK_MODEL       default grok-4.7

export interface LlmCallOptions {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Explicit credentials, injected by callers that hold runtime bindings (the Cloudflare
 *  Worker passes its env secrets straight in). When absent, falls back to process.env --
 *  read defensively because process may not exist on every runtime/path. `name` is an
 *  optional human-readable provider label; defaults to the model id. */
export interface LlmCred {
  key?: string;
  baseUrl?: string;
  model?: string;
  name?: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const GROK_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const GROK_DEFAULT_MODEL = "grok-4.7";

function penv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}

/** Resolve one provider from an explicit cred, falling back to process.env. */
function resolveCred(c?: LlmCred): { key: string; base: string; model: string; name: string } {
  const env = penv();
  const key = c?.key || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || "";
  const base = (c?.baseUrl || env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = c?.model || env.OPENAI_MODEL || env.DISCUSSION_MODEL || DEFAULT_MODEL;
  return { key, base, model, name: c?.name || model };
}

/**
 * Every configured chat model, primary first, so the discussion can carry a caveat from
 * each. Reads process.env on the Node path; the Worker passes explicit creds instead (it
 * cannot see secrets through process.env under nodejs_compat v1). De-duplicated by
 * base+model so the same endpoint is not asked twice. Returns [] when nothing is wired.
 */
export function listProviders(creds?: LlmCred | LlmCred[]): { key: string; base: string; model: string; name: string }[] {
  const explicit = creds == null ? [] : Array.isArray(creds) ? creds : [creds];
  if (explicit.length > 0) {
    return explicit
      .map((c) => resolveCred(c))
      .filter((p) => p.key.length > 0);
  }
  // No explicit creds (Node): build from the environment. Primary provider, then Grok.
  const env = penv();
  const out: { key: string; base: string; model: string; name: string }[] = [];
  const primaryKey = env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || "";
  if (primaryKey) {
    out.push({
      key: primaryKey,
      base: (env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model: env.OPENAI_MODEL || env.DISCUSSION_MODEL || DEFAULT_MODEL,
      name: env.OPENAI_MODEL || env.DISCUSSION_MODEL || DEFAULT_MODEL,
    });
  }
  const grokKey = env.GROK_API_KEY || env.XAI_API_KEY || "";
  if (grokKey) {
    out.push({
      key: grokKey,
      base: (env.GROK_BASE_URL || GROK_DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model: env.GROK_MODEL || GROK_DEFAULT_MODEL,
      name: env.GROK_MODEL || GROK_DEFAULT_MODEL,
    });
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.base}|${p.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "unknown-host";
  }
}

/** True when a chat model is reachable via an API key. */
export function llmConfigured(c?: LlmCred): boolean {
  return resolveCred(c).key.length > 0;
}

export type DiscussionMode = "live-llm" | "grounded";

/** Which mode the war-room runs in. Surfaced in the UI so viewers always know whether
 *  they are watching live model output or grounded narration of the real numbers. */
export function discussionMode(c?: LlmCred): DiscussionMode {
  return llmConfigured(c) ? "live-llm" : "grounded";
}

/** A human-readable label for the wired provider(s)/model(s) (or "grounded"). */
export function llmProviderLabel(c?: LlmCred): string {
  const providers = listProviders(c && (c.key || c.baseUrl || c.model) ? c : undefined);
  if (providers.length === 0) return "grounded (data-driven)";
  return providers.map((p) => `${p.model} @ ${p.base}`).join(", ");
}

/**
 * Single-shot chat completion for ONE specific provider. Returns null when unconfigured,
 * on a non-2xx response, on timeout/abort, or on parse failure -- callers then fall back
 * to grounded text, so a missing or failing model never breaks the run or the dashboard.
 * Failures are logged sanitized (host + status only; never the key or the full URL).
 */
export async function completeWithProvider(
  p: { key: string; base: string; model: string },
  system: string,
  user: string,
  o: LlmCallOptions = {},
): Promise<string | null> {
  if (!p.key) return null;
  const controller = new AbortController();
  // 45s default: reasoning models (e.g. grok-4.x) spend many hidden tokens before they
  // emit the visible answer and can take 15-30s, so a short abort would silently drop
  // them. This is I/O wait, not CPU, so it is safe within a Worker request.
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 45000);
  try {
    const r = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: o.model ?? p.model,
        max_tokens: o.maxTokens ?? 320,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) {
      console.warn(`llm: HTTP ${r.status} from ${hostOf(p.base)}`);
      return null;
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (e) {
    console.warn(`llm: request to ${hostOf(p.base)} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-shot chat completion against the primary (single) provider -- kept for the
 * one-model call path and tests. Multi-provider callers use completeWithProvider per
 * resolved provider (see discussion.ts). Returns null when unconfigured or on any error.
 */
export async function complete(system: string, user: string, o: LlmCallOptions = {}, c?: LlmCred): Promise<string | null> {
  const r0 = resolveCred(c);
  if (!r0.key) return null;
  return completeWithProvider(r0, system, user, o);
}
