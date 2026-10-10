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
//   OPENAI_API_KEY   (or DEEPSEEK_API_KEY)   your key
//   OPENAI_BASE_URL  default https://api.deepseek.com/v1
//   OPENAI_MODEL     default deepseek-chat

export interface LlmCallOptions {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Explicit credentials, injected by callers that hold runtime bindings (the Cloudflare
 *  Worker passes its env secrets straight in). When absent, falls back to process.env --
 *  read defensively because process may not exist on every runtime/path. */
export interface LlmCred {
  key?: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

function penv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}

function resolveCred(c?: LlmCred): { key: string; base: string; model: string } {
  const env = penv();
  const key = c?.key || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || "";
  const base = (c?.baseUrl || env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = c?.model || env.OPENAI_MODEL || env.DISCUSSION_MODEL || DEFAULT_MODEL;
  return { key, base, model };
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

/** A human-readable label for the wired provider/model (or "grounded"). */
export function llmProviderLabel(c?: LlmCred): string {
  const r = resolveCred(c);
  return llmConfigured(c) ? `${r.model} @ ${r.base}` : "grounded (data-driven)";
}

/**
 * Single-shot chat completion. Returns null when unconfigured, on a non-2xx response,
 * on timeout/abort, or on parse failure -- callers then fall back to grounded text, so a
 * missing or failing model never breaks the run or the dashboard. Failures are logged
 * sanitized (host + status only; never the key or the full URL).
 */
export async function complete(system: string, user: string, o: LlmCallOptions = {}, c?: LlmCred): Promise<string | null> {
  const r0 = resolveCred(c);
  if (!r0.key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 20000);
  try {
    const r = await fetch(`${r0.base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${r0.key}` },
      body: JSON.stringify({
        model: o.model ?? r0.model,
        max_tokens: o.maxTokens ?? 320,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) {
      console.warn(`llm: HTTP ${r.status} from ${hostOf(r0.base)}`);
      return null;
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (e) {
    console.warn(`llm: request to ${hostOf(r0.base)} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
