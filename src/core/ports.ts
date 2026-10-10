// Runtime-agnostic IO ports for the pipeline core.
//
// The shared compute (detection, simulation, critic, reporter, bundle hashing) must
// run unchanged on BOTH the Node server and Cloudflare Workers. To keep it free of
// node:fs and @cloudflare/workers-types, every side-effecting capability is expressed
// as a tiny interface here and supplied by a per-runtime adapter:
//   - Node:    an fs-backed ArtifactStore (src/node/artifact-store.ts)
//   - Workers: an R2-backed ArtifactStore (src/cf/artifact-store.ts)

/** Content-addressed blob store for reproducible bundle artifacts. */
export interface ArtifactStore {
  /** Write bytes (or UTF-8 text) under a slash-delimited key, e.g. "bundles/F-x/folded.svg". */
  put(key: string, body: string | Uint8Array, contentType?: string): Promise<void>;
  /** Read bytes, or null when the key is absent. */
  get(key: string): Promise<Uint8Array | null>;
  /** Read UTF-8 text, or null when the key is absent. */
  getText(key: string): Promise<string | null>;
  /** True when the key exists. */
  exists(key: string): Promise<boolean>;
}
