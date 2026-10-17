// Blind-candidate live-data fixture capture (READ-ONLY: no token, no spend, no writes to the rig).
//
// WHY. After the survey rotation was unfrozen, the live catalog began producing origin="blind-toi" rows for real
// -- a mix of SURVIVING candidates (verdict "needs-more-data", held for human follow-up) and critic-REJECTED rows
// (verdict "rejected", i.e. noise). The X digest's blind tier and the silence heartbeat must report only the
// surviving ones; counting rejected dips would overstate "candidates awaiting follow-up". That predicate is exactly
// the kind that a hand-built stub test can miss, so -- following scripts/capture-live-fixtures.ts -- this snapshots
// the REAL blind rows into a committed fixture that tests/live-blind-digest.test.ts drives composeDigest against.
//
// Re-run any time (especially after a deploy) to refresh from live:
//   npm run fixtures:capture-blind
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.RIG_LIVE_BASE || "https://spacedatarig.app";
const UA = { "user-agent": "Mozilla/5.0 (compatible; space-data-rig fixture-capture)", "cache-control": "no-store" };

interface LiveFinding {
  id?: string;
  targetId?: string;
  verdict?: string;
  origin?: string;
  createdAt?: string;
  discoveryClaim?: boolean;
  candidate?: { periodDays?: number };
  crossmatch?: { matchedKnownPlanet?: boolean };
  signature?: string;
}

async function getJson(path: string, tries = 5): Promise<any> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await new Promise((res) => setTimeout(res, 800));
    }
  }
  throw new Error(`fetch ${path} failed after retries: ${lastErr}`);
}

async function main(): Promise<void> {
  const state = await getJson("/api/state");
  const findings: LiveFinding[] = Array.isArray(state?.findings) ? state.findings : [];
  const candidates = findings
    .filter((f) => f && f.origin === "blind-toi")
    .map((f) => ({
      targetId: f.targetId ?? "",
      verdict: f.verdict ?? "",
      origin: "blind-toi" as const,
      createdAt: f.createdAt ?? "",
      periodDays: f.candidate?.periodDays ?? null,
      matchedKnownPlanet: f.crossmatch?.matchedKnownPlanet === true,
      discoveryClaim: f.discoveryClaim === true,
      anchored: Boolean(f.signature),
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const surviving = candidates.filter((c) => c.verdict !== "rejected").length;
  const fixture = {
    capturedAt: new Date().toISOString(),
    base: BASE,
    note: "Real origin=blind-toi rows from /api/state. digest/heartbeat must count only verdict!=='rejected'.",
    total: candidates.length,
    surviving,
    rejected: candidates.length - surviving,
    candidates,
  };
  mkdirSync("tests/fixtures", { recursive: true });
  writeFileSync("tests/fixtures/live-blind-candidates.json", JSON.stringify(fixture, null, 2) + "\n", "utf8");
  console.log(`captured ${candidates.length} blind rows (surviving ${surviving}, rejected ${candidates.length - surviving}) -> tests/fixtures/live-blind-candidates.json`);
  if (candidates.length === 0) {
    console.error("WARNING: no blind candidates on live yet; the fixture is empty and the test would be vacuous.");
    process.exitCode = 1;
  }
}

// Only run when invoked directly (never on import).
if (/capture-blind-fixtures(\.ts)?$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error(`capture-blind: fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
