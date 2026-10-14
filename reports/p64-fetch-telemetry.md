# P64 fetch telemetry: is the concurrent+cached multi-sector helper worth using broadly?

Reproduce: `npm run p64:fetch-telemetry -- --hosts 8 --maxsectors 4 --concurrency 4`

Over **8** real TOI hosts (<= 4 sectors each), the helper was swept twice. The cold
pass made 24 byte requests (17 downloads, ~1062ms each, 7714ms wall).
The warm pass reused the same keys and hit cache 24/24 = 100% of requests,
finishing in 77ms vs 7714ms cold. Cumulative estimated download time avoided: 32922ms
(cache hits x measured mean miss latency -- a byte-level estimate, since concurrent fetches overlap).

**VERDICT: WARM-CACHE-FREE: a repeat sweep served 100% of byte requests from cache (misses 0, 77ms vs 7714ms cold) -- the per-key cache makes multi-study re-fetch effectively free, which is the measured case for using the helper broadly in research before any production decision.**

The measured cost is DOWNLOAD, and the per-key cache removes it on repeat -- the evidence-backed case for
using the helper across research studies first. Promotion toward production is a SEPARATE, gated decision
this script does not make. safeToGate false, discoveryClaim false; nothing anchored.
