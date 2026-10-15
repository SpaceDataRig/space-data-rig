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
- Those mutating endpoints support an OPT-IN admin gate (audit finding, 2026-10):
  set `ADMIN_TOKEN` (`wrangler secret put ADMIN_TOKEN` on the edge, or in `.env`
  for the Node server) and every `POST /api/run` / `POST /api/anchor/*` must then
  carry `Authorization: Bearer <token>` (constant-time compared) or get a 401.
  When `ADMIN_TOKEN` is unset the endpoints stay open so a deployment is never
  silently broken by this code -- operators close the hole by setting the secret.
  Read endpoints and the public dashboard are unaffected; the autonomous cron path
  runs inside the Worker and does not call these HTTP routes, so it keeps working.
- In addition to the admin gate, `POST /api/run` and `POST /api/anchor/*` now carry a
  coarse per-client rate limiter (fixed window, keyed on `cf-connecting-ip`), returning
  `429` with a `retryAfterSec` once a single client exceeds the window (audit finding #8).
  It is deliberately an abuse brake, not a precise distributed quota -- each Worker isolate
  keeps its own counters and it fails OPEN so a limiter fault never locks the operator out.
  It does not change any verdict, bundle hash, or the money logic; the real protection for
  the fee wallet remains setting `ADMIN_TOKEN`.
- RPC endpoints configured for anchoring embed provider API keys in their URL
  path by design (hosted providers). The codebase treats every user-visible
  error string, event-log entry and ledger field for these URLs as required to
  be host-only redacted. Any path where a full URL (with key) can reach an
  error message, HTTP response, or stored event is a vulnerability.
- Never commit `.env`, `out/` (contains the local fee-payer keypair), or
  `state/`. These paths are gitignored; accidental inclusion should be treated
  as a security incident and the leaked credential rotated immediately.
