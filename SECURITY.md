# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| latest `main` | yes |

## Reporting a vulnerability

Please report security issues privately via the
[security advisories page](https://github.com/SpaceDataRig/space-data-rig/security/advisories/new)
of this repository, or by opening a private direct message to a repository
maintainer on GitHub. **Do not file public issues for vulnerabilities.**

We aim to acknowledge reports within 72 hours and ship fixes (with credit, if
you wish) before any public disclosure.

## Scope notes for this project

- The public API at `spacedatarig.app` spends real Solana mainnet fees when
  anchoring. Endpoints that trigger chain actions or pipeline runs
  (`POST /api/anchor/:id`, `POST /api/run`) are the highest-value targets;
  reports about abuse paths, missing rate limits, or state-machine lockups there
  are especially welcome.
- The mutating endpoints are now DENY-BY-DEFAULT (audit-10 #7): when `ADMIN_TOKEN` is
  unset/empty, every `POST /api/run` / `POST /api/anchor/*` returns `401` -- the code can no
  longer be deployed leaving them open. The operator ENABLES mutations by setting the secret
  (`wrangler secret put ADMIN_TOKEN` on the edge, or `ADMIN_TOKEN` in `.env` for the Node
  server); from then on each request must carry `Authorization: Bearer <token>` (constant-time
  compared). Read endpoints and the public dashboard are unaffected; the autonomous cron path
  runs inside the Worker and does not call these HTTP routes, so it keeps working. A deployment
  must set `ADMIN_TOKEN` before the dashboard's Run / Anchor actions will succeed.
- In addition to the admin gate, `POST /api/run` and `POST /api/anchor/*` carry a coarse
  per-client rate limiter (fixed window, keyed on `cf-connecting-ip`), returning `429` with a
  `retryAfterSec` once a single client exceeds the window (audit finding #8). It is deliberately an
  abuse brake, not a precise distributed quota -- each Worker isolate keeps its own counters and it
  fails OPEN so a limiter fault never locks the operator out; the durable counter path is the
  Durable Object / Cloudflare edge rate-limiting rule, left as an operational option.
- Mainnet anchors are now SERIALIZED PER FINDING inside the Durable Object (audit-10 #7). A DO
  handles requests concurrently, and the ledger idempotency check is separated from the on-chain
  spend by awaits, so two rapid calls for the same finding (double-click / retry / script) could
  previously both pass the guard and pay SOL twice. An in-flight lock makes a concurrent same-finding
  call await the first anchor's outcome; combined with the ledger's already-anchored guard, a given
  bundle hash is paid at most once. None of this changes any verdict, bundle hash, or the money logic.
- RPC endpoints configured for anchoring embed provider API keys in their URL
  path by design (hosted providers). The codebase treats every user-visible
  error string, event-log entry and ledger field for these URLs as required to
  be host-only redacted. Any path where a full URL (with key) can reach an
  error message, HTTP response, or stored event is a vulnerability.
- Never commit `.env`, `out/` (contains the local fee-payer keypair), or
  `state/`. These paths are gitignored; accidental inclusion should be treated
  as a security incident and the leaked credential rotated immediately.
