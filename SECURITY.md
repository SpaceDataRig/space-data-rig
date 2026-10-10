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
- RPC endpoints configured for anchoring embed provider API keys in their URL
  path by design (hosted providers). The codebase treats every user-visible
  error string, event-log entry and ledger field for these URLs as required to
  be host-only redacted. Any path where a full URL (with key) can reach an
  error message, HTTP response, or stored event is a vulnerability.
- Never commit `.env`, `out/` (contains the local fee-payer keypair), or
  `state/`. These paths are gitignored; accidental inclusion should be treated
  as a security incident and the leaked credential rotated immediately.
