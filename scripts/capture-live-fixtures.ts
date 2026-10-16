// audit-4 live-data regression fixture capture (READ-ONLY: no token, no spend, no writes to the rig).
//
// WHY THIS EXISTS. The fourth-round audit caught two fixes that were correct, unit-tested, and deployed,
// yet never fired on real data:
//   - the scienceHash dedup: hashScience() folded findingId/targetId/artifacts/dataProvenance into the
//     content address, so byte-identical science under different finding ids could never collide;
//   - the legacy-card relabel: a strict `<` date boundary excluded the very cards it was written for.
// Both slipped through because their tests asserted the FUNCTION on hand-built stubs, not the PREDICATE on
// the live records. This tool closes that gap at the root: it snapshots the real public /api/state findings
// and the real stored bundle manifests into committed fixtures, so tests/live-data-regression.test.ts drives
// the actual render/dedup predicates over production-shaped bytes offline (no network in `npm test`).
//
// Re-run any time -- especially right after a deploy -- to refresh the fixtures from live and to print the
// scienceHash each captured manifest produces under the CURRENT code (a before/after you can eyeball):
//   npm run fixtures:capture
import { writeFileSync, mkdirSync } from "node:fs";
import { hashScience, type BundleManifest } from "../src/bundle/bundle.ts";

const BASE = process.env.RIG_LIVE_BASE || "https://spacedatarig.app";
const UA = { "user-agent": "Mozilla/5.0 (compatible; space-data-rig fixture-capture)" };

interface LiveFinding {
  id: string;
  targetId: string;
  createdAt?: string;
  verdict?: string;
  verdictReason?: string;
  bundleHash?: string;
  narration?: { headline?: string; explainer?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The public site sits behind Cloudflare and this dev box's TLS handshake is intermittent, so retry a
// network-level failure a few times before giving up (an HTTP status is NOT retried -- it is a real answer).
async function getJson(path: string, tries = 5): Promise<any> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers: UA });
      if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
      return (await r.json()) as any;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (lastErr.includes("HTTP ")) throw new Error(lastErr); // a real status: do not retry
      await sleep(1200 * (i + 1));
    }
  }
  throw new Error(`${path} -> ${lastErr} (after ${tries} tries)`);
}

async function main(): Promise<void> {
  mkdirSync("tests/fixtures", { recursive: true });

  // 1) The live findings, trimmed to exactly the fields the projection predicates read. Capturing the real
  //    createdAt + stored headline is the whole point: the relabel boundary bug is invisible without them.
  const state = await getJson("/api/state");
  const findings: LiveFinding[] = ((state.findings ?? []) as any[]).map((f) => ({
    id: f.id,
    targetId: f.targetId,
    createdAt: f.createdAt,
    verdict: f.verdict,
    verdictReason: f.verdictReason,
    bundleHash: f.bundleHash,
    narration: f.narration ? { headline: f.narration.headline, explainer: f.narration.explainer } : undefined,
  }));
  writeFileSync(
    "tests/fixtures/live-findings.json",
    JSON.stringify({ capturedAt: new Date().toISOString(), base: BASE, findings }, null, 2) + "\n",
  );
  console.log(`captured ${findings.length} live findings -> tests/fixtures/live-findings.json`);

  // 2) The real stored manifests for the identical-science trio the audit named (fall back to the most
  //    recent anchored rows if that trio has rotated out). These are the bytes the dedup predicate must
  //    collapse to one content address -- a hand-built stub can never prove that.
  const ledger = await getJson("/api/ledger");
  const anchored = ((ledger.ledger ?? []) as any[]).filter((e) => e.status === "anchored");
  const want = ["F-HR-858-b", "F-HR-858-c", "F-HR-858-d"];
  const ids = want.filter((id) => anchored.some((e) => e.findingId === id));
  const pick = ids.length ? ids : anchored.slice(-3).map((e) => e.findingId as string);
  const bundles: { findingId: string; manifest: BundleManifest }[] = [];
  for (const id of pick) {
    try {
      const manifest = (await getJson(`/api/bundles/${encodeURIComponent(id)}/manifest`)) as BundleManifest;
      bundles.push({ findingId: id, manifest });
    } catch (e) {
      console.log(`  skip ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  writeFileSync(
    "tests/fixtures/live-manifests.json",
    JSON.stringify({ capturedAt: new Date().toISOString(), base: BASE, bundles }, null, 2) + "\n",
  );
  console.log(`captured ${bundles.length} live manifests -> tests/fixtures/live-manifests.json`);

  // 3) Print the scienceHash each captured manifest yields under the CURRENT hashScience(). Before the fix
  //    these differ per finding (dedup dead); after, identical science collapses to one address (dedup live).
  const seen = new Map<string, string[]>();
  for (const b of bundles) {
    const sci = await hashScience(b.manifest);
    console.log(`  ${b.findingId.padEnd(14)} scienceHash=${sci.slice(0, 16)}...  targetId="${b.manifest.targetId}"`);
    seen.set(sci, [...(seen.get(sci) ?? []), b.findingId]);
  }
  console.log(`\ndistinct scienceHash values: ${seen.size} across ${bundles.length} manifests`);
  for (const [sci, ids2] of seen) console.log(`  ${sci.slice(0, 16)}... <- ${ids2.join(", ")}`);
}

main().catch((e) => {
  console.error(`[capture-live-fixtures] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
