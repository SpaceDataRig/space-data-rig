// audit-14 N3: a tiny, runtime-agnostic per-key in-flight SERIALIZER, factored out of the money path so its
// concurrency behaviour is testable offline instead of asserted by string-matching a handler. The bug it exists to
// close: the named-observation commission checks a burn-signature replay guard and only WRITES the guard after the
// on-chain anchoring -- many `await`s apart -- so two requests carrying the SAME signature can both pass the check
// and both spend SOL. Serialising by signature means a concurrent duplicate cannot start until the first settles.
//
// SEMANTICS (chain-and-rerun, NOT share): a second same-key caller waits for the first to finish, then runs its OWN
// function. That is deliberate for an HTTP handler: a Response body is single-use, so callers cannot share one
// Response, and re-running lets the second request re-read the now-written guard and honestly return "already used".
// (The Durable Object's commissionInFlight uses share-the-in-flight-promise semantics instead -- it returns a plain
// object, not a Response, and mirrors the established anchorInFlight idiom.) Distinct keys never block each other,
// and a rejected function still releases the key so a failure cannot wedge the lane.

/**
 * Run `fn` exclusively among other calls sharing `tail`+`key`. Any call already queued on the same key completes
 * first; the returned promise resolves with this call's own `fn` result. The key is dropped from `tail` once the
 * last queued call settles, so a later call starts fresh (the map does not grow unboundedly).
 */
export async function serializeByKey<T>(tail: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tail.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the previous settle, whether it resolved or rejected
  const gate = run.then(
    () => undefined,
    () => undefined,
  ); // an always-resolving void promise so the next waiter chains cleanly
  tail.set(key, gate);
  try {
    return await run;
  } finally {
    if (tail.get(key) === gate) tail.delete(key);
  }
}
