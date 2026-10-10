// Minimal process.env typing for the Worker build only.
//
// nodejs_compat (wrangler.toml) supplies process.env at runtime, populated from the
// Worker's vars + secrets -- that is how src/ai/llm.ts reads its chat API key on the
// edge. The Node build gets the full typing from @types/node instead; this global
// declaration is picked up only via tsconfig.worker.json (src/cf/**), so the two
// builds never collide.
declare const process: { env: Record<string, string | undefined> };
