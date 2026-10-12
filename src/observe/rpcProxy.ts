// READ-ONLY RPC PROXY for the in-page burn helper (browser -> our edge -> mainnet).
//
// Why this exists: public Solana RPC endpoints (api.mainnet-beta.solana.com) return HTTP 403 for browser
// requests carrying an unknown `Origin` header -- a browser cannot attach the header but the RPC layer sees
// it, so direct client-side chain reads fail inside web3.js as opaque errors (v3 wraps them as SolanaError
// #8100002 with statusCode=403). The fix is NOT to fight the Origin rule: route the READS through our own
// Worker. Server-to-server fetch has no Origin, and the proxy can use the operator's private RPC (env
// SOLANA_RPC) with fallbacks, without ever exposing the endpoint or its key to the browser.
//
// Security boundary: ONLY whitelisted read methods are forwarded, only single JSON-RPC objects (no batches),
// and the payload size is capped by the caller. Notably `sendTransaction` is deliberately absent -- this is
// not a relay for anyone's transactions; the wallet itself signs and submits the burn via its own infra.
// On-chain verification of the burn still happens independently server-side (see burnVerify.ts).

/** JSON-RPC methods the browser helper is allowed to read through the proxy. Everything else is refused. */
export const RPC_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  "getHealth",
  "getVersion",
  "getSlot",
  "getLatestBlockhash",
  "getBalance",
  "getTokenAccountBalance",
  "getTokenLargestAccounts",
  "getSignatureStatuses",
  "getFeeForMessage",
]);

/** Minimal fetch shape so tests can inject a stub and both runtimes' globals satisfy it. */
export type RpcFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcProxyResult {
  status: number;
  /** JSON-RPC response body when status is 200. */
  json?: unknown;
  /** Plain reason when the request was refused or every endpoint failed. */
  error?: string;
}

/**
 * Validate a raw JSON-RPC request body against the allowlist and forward it to the first endpoint that
 * answers, in order (private RPC first, public fallbacks after -- supplied by the caller via endpointList).
 * Never throws: every failure path comes back as a plain RpcProxyResult the routes can serialize.
 */
export async function handleBrowserRpcProxy(
  rawBody: string,
  endpoints: string[],
  fetchImpl: RpcFetch,
): Promise<RpcProxyResult> {
  if (endpoints.length === 0) return { status: 503, error: "no RPC endpoint configured on this server" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, error: "request body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, error: "expected a single JSON-RPC request object (no batches)" };
  }
  const req = parsed as { method?: unknown; id?: unknown; params?: unknown };
  if (typeof req.method !== "string" || !RPC_READ_ALLOWLIST.has(req.method)) {
    return { status: 403, error: "method not allowed: this endpoint only proxies read-only RPC calls" };
  }

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: req.id ?? 1,
    method: req.method,
    params: req.params ?? [],
  });

  for (const url of endpoints) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      if (!res.ok) continue;
      return { status: 200, json: await res.json() };
    } catch {
      // endpoint unreachable / malformed reply -- try the next one, report honestly if none survive
    }
  }
  return { status: 502, error: "every configured RPC endpoint failed to answer this read" };
}
