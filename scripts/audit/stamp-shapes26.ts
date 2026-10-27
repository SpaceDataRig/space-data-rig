// round-26: where does generatedAt actually live in each artifact? The gate reads two shapes (meta.* and top-level
// flat); round-25 concluded "both shapes are handled" and that conclusion was itself an undercount, because p91 writes
// a complete hashed stamp under a THIRD key. Anything this scan finds outside the two read shapes is a report whose
// provenance exists but can never be checked -- and the published count cannot tell that apart from "no stamp at all".
import { readFileSync, readdirSync } from "node:fs";
import { stampFromMeta } from "../report-freshness.ts";

const files = readdirSync("reports").filter((f) => f.endsWith(".json"));
const shapes: { readable: string[]; thirdKey: string[]; none: string[] } = { readable: [], thirdKey: [], none: [] };
for (const f of files) {
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(`reports/${f}`, "utf8")); } catch { continue; }
  const readable = !!stampFromMeta((doc as { meta?: unknown })?.meta ?? doc);
  // find every object in the document that carries a generatedAt, nesting deep enough to catch real shapes
  const holders: string[] = [];
  const walk = (o: unknown, path: string, depth: number): void => {
    if (!o || typeof o !== "object" || depth > 3) return;
    const rec = o as Record<string, unknown>;
    if (typeof rec.generatedAt === "string" && rec.generatedAt) holders.push(path || "(top)");
    for (const [k, v] of Object.entries(rec)) if (v && typeof v === "object") walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(doc, "", 0);
  if (readable) shapes.readable.push(`${f} ${holders.join(",")}`);
  else if (holders.length) shapes.thirdKey.push(`${f} -- generatedAt at ${holders.join(", ")} (NOT where the gate looks)`);
  else shapes.none.push(f);
}
console.log(`artifacts scanned: ${files.length}`);
console.log(`\nREADABLE by the gate (${shapes.readable.length})`);
console.log(`\nSTAMPED BUT INVISIBLE (${shapes.thirdKey.length}):`);
for (const x of shapes.thirdKey) console.log("   " + x);
console.log(`\nNO generatedAt anywhere (${shapes.none.length})`);
