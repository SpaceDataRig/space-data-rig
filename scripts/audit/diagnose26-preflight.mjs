// Diagnosis run for the CI failure on e97c4fd: disable the GIT_DIR/GIT_WORK_TREE hermeticity fix in
// tests/x-post-preflight.test.ts and re-run only the F13 empty-window case. If it fails with the same message CI
// printed, the diagnosis is proven from the real failure mode rather than asserted. Restores the file afterwards.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const P = "tests/x-post-preflight.test.ts";
const orig = readFileSync(P, "utf8");
const patched = orig
  .replace("      GIT_DIR: join(dir, \".git\"),", "      // GIT_DIR removed for a one-shot diagnosis")
  .replace("      GIT_WORK_TREE: dir,", "      // GIT_WORK_TREE removed for a one-shot diagnosis");
if (patched === orig) throw new Error("the fix lines were not found; nothing was disabled, so the diagnosis proves nothing");
writeFileSync(P, patched, "utf8");
try {
  const r = spawnSync("node", ["--import", "tsx", "--test", P], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const counts = out.split("\n").filter((l) => /^[\u2139#]?\s*(tests|pass|fail)\s+\d/.test(l.replace(/^[\u2139#]\s*/, "")));
  const science = out.split("\n").filter((l) => /research\.json changed inside the science window/.test(l)).slice(0, 3);
  console.log("WITHOUT THE FIX:", counts.join(" | "));
  console.log("science-window lines seen:", science.length, science.map((s) => s.trim().slice(0, 120)));
} finally {
  writeFileSync(P, orig, "utf8");
  const back = readFileSync(P, "utf8") === orig;
  console.log("file restored:", back);
}
