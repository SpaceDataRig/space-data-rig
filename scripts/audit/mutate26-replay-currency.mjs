// round-26 drill for R26-20: prove the replay-manifest currency gate is not a tautology. The gate asserts the committed
// web/replay-manifest.json equals a fresh deterministic rebuild. Right now they match (no drift), which is what we want --
// but "it passes because nothing changed" is not the same as "it would fail if something changed". This tampers the
// committed bytes (flip one hex char of the replay hash), runs the gate, and requires it to go RED naming the mismatch,
// then restores and requires byte-identity + 3/3. It mutates a tracked served file, so it always restores, including on
// an assertion throw.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const P = "web/replay-manifest.json";
const orig = readFileSync(P, "utf8");
const m = JSON.parse(orig);
if (typeof m.replayHash !== "string" || m.replayHash.length !== 64) throw new Error("no 64-hex replayHash to tamper; the drill would prove nothing");

function run() {
  const r = spawnSync("node", ["--import", "tsx", "--test", "tests/replay-manifest-currency.test.ts"], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = Number((out.match(/pass\s+(\d+)/) || [0, -1])[1]);
  const fail = Number((out.match(/fail\s+(\d+)/) || [0, -1])[1]);
  const namesMismatch = /is behind a rebuild/.test(out) || /replay-manifest\.json is behind/.test(out);
  return { code: r.status, pass, fail, namesMismatch };
}

const tamper = orig.replace(m.replayHash, m.replayHash.endsWith("a") ? m.replayHash.slice(0, -1) + "b" : m.replayHash.slice(0, -1) + "a");
if (tamper === orig) throw new Error("tamper produced identical bytes");
try {
  writeFileSync(P, tamper, "utf8");
  console.log("TAMPERED:", JSON.stringify(run()), "(expected fail>=1 and namesMismatch=true)");
} finally {
  writeFileSync(P, orig, "utf8");
}
console.log("RESTORED:", JSON.stringify(run()));
console.log("byte-identical again:", readFileSync(P, "utf8") === orig);
