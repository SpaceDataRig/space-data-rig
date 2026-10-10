// R2-backed ArtifactStore (Cloudflare runtime adapter).
//
// Mirrors the fs adapter (src/node/artifact-store.ts) key-for-key: slash-delimited
// keys map 1:1 to R2 object keys, so bundle write/verify/read code is identical on
// Node and Workers. Lives in the Worker typecheck set (imports only workers-types).

import type { ArtifactStore } from "../core/ports.ts";

export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: string | Uint8Array, contentType?: string): Promise<void> {
    await this.bucket.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  async getText(key: string): Promise<string | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return await obj.text();
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.bucket.head(key);
    return head != null;
  }
}
