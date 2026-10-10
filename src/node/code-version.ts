// Node-only provenance helper: read the rig's code version from package.json.
// Moved out of bundle.ts so the bundle core never touches node:fs. On Workers the
// equivalent value arrives as the CODE_VERSION var (see src/cf/env.ts).

import { readFileSync } from "node:fs";

/** name@version from package.json, or a safe fallback. */
export function readCodeVersion(pkgPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string; name?: string };
    return `${pkg.name ?? "space-data-rig"}@${pkg.version ?? "0.0.0"}`;
  } catch {
    return "space-data-rig@0.0.0";
  }
}
