// fs-backed ArtifactStore (Node runtime adapter).
//
// Rooted at a directory (e.g. <repo>/out); slash-delimited keys map to nested paths
// under the root, mirroring the R2 key layout exactly so verify/read code is shared.
// Node-only: it imports node:fs, so it lives outside the Worker typecheck set and the
// shared core stays binding-free.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ArtifactStore } from "../core/ports.ts";

const decoder = new TextDecoder();

export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    const root = resolve(this.root);
    const p = resolve(root, ...key.split("/"));
    // Defense in depth: callers already sanitize names (safeName + allowlist), but a
    // key with traversal segments must never resolve outside the store root.
    if (p !== root && !p.startsWith(root + sep)) {
      throw new Error(`artifact key escapes store root: ${key}`);
    }
    return p;
  }

  async put(key: string, body: string | Uint8Array): Promise<void> {
    const p = this.abs(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.abs(key));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async getText(key: string): Promise<string | null> {
    const b = await this.get(key);
    return b == null ? null : decoder.decode(b);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.abs(key));
      return true;
    } catch {
      return false;
    }
  }
}
