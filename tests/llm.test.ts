// Multi-provider LLM layer tests: provider resolution from env, per-model review-lens
// assignment, and buildDiscussion layering one labeled turn per configured model.
// No live network (fetch is mocked). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { listProviders, llmProviderLabel } from "../src/ai/llm.ts";
import { buildDiscussion, lensForProvider } from "../src/ai/discussion.ts";
import type { Finding } from "../src/core/types.ts";

const sampleFinding = (): Finding =>
  ({
    id: "F-TEST-1",
    targetId: "TEST STAR",
    verdict: "accepted",
    verdictReason: "Recovers the injected signal cleanly.",
    createdAt: "2026-10-10T00:00:00.000Z",
    recoveryConfidence: 0.9,
    crossmatch: { matchedKnownPlanet: true, knownPlanetName: "Test b", knownPeriodDays: 3.3, periodDeltaPct: 0.4 },
    ephemeris: { t0Bjd: 2458000, periodDays: 3.3, nextTransitsBjd: [2458003.3, 2458006.6] },
    narration: { headline: "Test planet recovered.", explainer: "" },
    bundleHash: "abcdef0123456789",
    candidate: {
      targetId: "TEST STAR", periodDays: 3.3, epochBjd: 2458000, durationHours: 2.5,
      depthPpt: 7, depthFrac: 0.007, snr: 40, power: 100, nPointsInTransit: 12,
    },
  }) as unknown as Finding;

// ---- provider resolution (mutates process.env, restored after) ----

const LLM_ENV = ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "DISCUSSION_MODEL", "GROK_API_KEY", "XAI_API_KEY", "GROK_BASE_URL", "GROK_MODEL"];
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of LLM_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return fn(); } finally { for (const k of LLM_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("listProviders: no keys -> empty, grounded label", () => {
  withEnv({}, () => {
    assert.deepEqual(listProviders(), []);
    assert.equal(llmProviderLabel(), "grounded (data-driven)");
  });
});

test("listProviders: DeepSeek only -> primary with defaults", () => {
  withEnv({ DEEPSEEK_API_KEY: "sk-x" }, () => {
    const p = listProviders();
    assert.equal(p.length, 1);
    assert.equal(p[0].base, "https://api.deepseek.com/v1");
    assert.equal(p[0].model, "deepseek-chat");
  });
});

test("listProviders: Grok alongside DeepSeek -> two providers, Grok gets its own defaults", () => {
  withEnv({ DEEPSEEK_API_KEY: "sk-x", GROK_API_KEY: "xai-y" }, () => {
    const p = listProviders();
    assert.equal(p.length, 2);
    assert.equal(p[0].model, "deepseek-chat");
    assert.equal(p[1].base, "https://api.x.ai/v1");
    assert.equal(p[1].model, "grok-4.7");
    assert.equal(llmProviderLabel(), "deepseek-chat @ https://api.deepseek.com/v1, grok-4.7 @ https://api.x.ai/v1");
  });
});

test("listProviders: dedupes identical base+model", () => {
  withEnv({ OPENAI_API_KEY: "a", OPENAI_BASE_URL: "https://api.x.ai/v1", OPENAI_MODEL: "grok-4.7", GROK_API_KEY: "b", GROK_BASE_URL: "https://api.x.ai/v1", GROK_MODEL: "grok-4.7" }, () => {
    assert.equal(listProviders().length, 1);
  });
});

// ---- per-model review lens assignment (pure) ----

test("lensForProvider maps DeepSeek to statistical and Grok to red-team regardless of order", () => {
  assert.equal(lensForProvider({ base: "https://api.deepseek.com/v1", model: "deepseek-chat" }, 0).role, "Statistical critic");
  assert.equal(lensForProvider({ base: "https://api.x.ai/v1", model: "grok-4.7" }, 1).role, "Red-team reviewer");
  // Grok first in the list still gets the red-team lens (matched by family, not position).
  assert.equal(lensForProvider({ base: "https://api.x.ai/v1", model: "grok-4.7" }, 0).role, "Red-team reviewer");
  // Unrecognised model falls back to positional lenses (distinct per index).
  assert.equal(lensForProvider({ base: "https://other/v1", model: "m1" }, 0).role, "Statistical critic");
  assert.equal(lensForProvider({ base: "https://other/v1", model: "m1" }, 1).role, "Red-team reviewer");
});

// ---- buildDiscussion multi-model caveat layering (mocked fetch) ----

test("buildDiscussion adds one labeled caveat per configured model", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    const model = JSON.parse(String(init?.body)).model as string;
    return new Response(JSON.stringify({ choices: [{ message: { content: `caveat from ${model}` } }] }), { status: 200 });
  }) as never;
  try {
    const creds = [
      { key: "k1", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", name: "deepseek-chat" },
      { key: "k2", baseUrl: "https://api.x.ai/v1", model: "grok-4.7", name: "grok-4.7" },
    ];
    const turns = await buildDiscussion(sampleFinding(), creds);
    const caveats = turns.filter((t) => t.model);
    assert.equal(caveats.length, 2, "expected one turn per model");
    assert.deepEqual(caveats.map((t) => t.model).sort(), ["deepseek-chat", "grok-4.7"]);
    // each model got a DIFFERENT lens: distinct role prefix + distinct tone
    const ds = caveats.find((t) => t.model === "deepseek-chat")!;
    const grok = caveats.find((t) => t.model === "grok-4.7")!;
    assert.ok(ds.text.startsWith("[Statistical critic]"), ds.text);
    assert.ok(grok.text.startsWith("[Red-team reviewer]"), grok.text);
    assert.equal(ds.tone, "challenge");
    assert.equal(grok.tone, "hedge");
    // caveats sit before the final reporter summary
    assert.equal(turns[turns.length - 1].seat, "reporter");
  } finally {
    globalThis.fetch = orig;
  }
});

test("buildDiscussion stays grounded when no provider is configured", async () => {
  withEnv({}, async () => {
    const turns = await buildDiscussion(sampleFinding());
    assert.ok(turns.every((t) => !t.model), "grounded turns carry no model label");
    assert.ok(turns.length >= 5);
  });
});

test("buildDiscussion drops a failing model but keeps the working one", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    const model = JSON.parse(String(init?.body)).model as string;
    if (model === "grok-4.7") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as never;
  try {
    const turns = await buildDiscussion(sampleFinding(), [
      { key: "k1", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", name: "deepseek-chat" },
      { key: "k2", baseUrl: "https://api.x.ai/v1", model: "grok-4.7", name: "grok-4.7" },
    ]);
    const caveats = turns.filter((t) => t.model);
    assert.equal(caveats.length, 1);
    assert.equal(caveats[0].model, "deepseek-chat");
  } finally {
    globalThis.fetch = orig;
  }
});
