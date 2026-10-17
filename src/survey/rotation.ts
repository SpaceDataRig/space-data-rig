// Pure rotation-window helper (runtime-agnostic, Node-testable).
//
// audit-5 (audience-legibility): the autonomous cron rotates through a broad real target pool (known-planet
// re-validation rows + unconfirmed blind-TOI candidates) so the FINDINGS CATALOG grows across passes instead
// of overwriting the same brightest handful in place. This module owns ONLY the deterministic index selection;
// the caller (src/cf/workflow.ts) builds the actual pool and runs the 5-seat pipeline. Keeping the math here
// -- free of Workers imports -- is what lets tests/rotation.test.ts prove determinism, wrap and per-pass change
// on plain arrays, exactly the "drive the real predicate over real inputs, not a hand-built stub" discipline
// audit-4 demanded.

/**
 * Window of `targets` pool positions for a given survey `pass`, advancing a fixed stride each pass and
 * wrapping modulo the pool length. Returns an empty array for a degenerate pool/request; caps the window at
 * the pool size so a small pool never yields duplicate positions. Deterministic for a given
 * (poolLen, targets, pass) triple, and every distinct pass selects a shifted window while the pool is larger
 * than the per-pass request -- which is what makes the catalog accumulate new rows over successive runs.
 */
export function selectRotationWindow(poolLen: number, targets: number, pass: number): number[] {
  if (poolLen <= 0 || targets <= 0) return [];
  const count = Math.min(targets, poolLen);
  // fold `pass` into [0, poolLen) before scaling so a very large pass count can never overflow the modulo.
  const p = ((pass % poolLen) + poolLen) % poolLen;
  const start = (p * targets) % poolLen;
  const idx: number[] = [];
  for (let k = 0; k < count; k++) idx.push((start + k) % poolLen);
  return idx;
}

/**
 * Split a per-pass target budget across two sub-pools (known re-validation + blind TOI) and rotate EACH
 * independently by `pass`, so every window draws from BOTH pools. The contiguous merged-pool window only
 * reached the TOI band once the offset crossed the known length, so with a low/frozen cursor it kept
 * yielding "all known, zero blind" forever. Interleaving guarantees fresh UNCONFIRMED TOI candidates from
 * the first pass; each item keeps its own within-sub-pool index (the caller maps those to stable
 * findingIds, so no recorded row churns). Falls back to all-known when the TOI sub-pool is empty and caps
 * cleanly when either pool is smaller than its share.
 */
export function selectMixedWindow(knownLen: number, toiLen: number, targets: number, pass: number): { known: number[]; toi: number[] } {
  if (targets <= 0) return { known: [], toi: [] };
  const wantToi = toiLen > 0 ? Math.min(toiLen, Math.floor(targets / 2)) : 0;
  const wantKnown = targets - wantToi;
  return { known: selectRotationWindow(knownLen, wantKnown, pass), toi: selectRotationWindow(toiLen, wantToi, pass) };
}
