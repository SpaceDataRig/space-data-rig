# Governance

This document describes how Space Data Rig is maintained and how decisions are
made. It is written to be honest about the current state of the project rather than
to appear larger than it is.

## Maintenance model

Space Data Rig is currently maintained by a single human owner, working closely with
an autonomous AI coding agent that drafts, tests, and commits changes under the
owner's direction and review. There is no hidden cast of contributors.

- **Owner** -- sets direction, reviews and approves changes, and is accountable for
  the code, the running production service, and any spend.
- **AI coding agent** -- a tool, not a person. Changes it authors are made through an
  explicitly-labelled automated identity (commits are co-signed and it is stated
  plainly here and in `CONTRIBUTING.md`). We do not create additional accounts or
  identities to imply more human contributors than there are; doing so would be a
  misrepresentation and violates our code of conduct.
- **Community contributors** -- anyone is welcome; see `CONTRIBUTING.md`. When a real
  person contributes, they commit or author pull requests under their own account,
  and this governance applies to them on the same terms.

We consider a transparent single-maintainer + agent model with strong automated
checks to be a legitimate, auditable structure. Maturity is demonstrated by verifiable
engineering (reproducible results, CI, a test suite, tagged releases, provenance),
not by headcount.

## Decision making

Technical and product decisions are made by the owner, informed by open discussion in
issues and pull requests. Decisions that change what the system reports to the outside
world -- detection thresholds, what counts as an accepted finding, on-chain anchoring,
or anything on the money path -- require an explicit, recorded decision and a passing
check set (`typecheck:all` plus the full test suite) before they ship, in line with the
project's measure-before-gate rule.

## Roles and progression

- **Contributor** -- anyone with a merged pull request.
- **Reviewer** -- a recurring, trusted contributor who may be asked to review changes;
  earned through sustained, quality contributions.
- **Maintainer** -- commit and release authority; currently the owner. Maintainer
  responsibilities may be extended to proven contributors over time, documented here.

## Working in the open

Roadmap, known limitations, and honest results -- including negative results -- are
kept in the open (`README.md`, `CHANGELOG.md`, and the research notes). External
review is actively encouraged: the pipeline is built so that any reported finding is
reproducible from public data and a hash-sealed bundle, so third parties can verify
our claims independently rather than take them on trust.

## Amendments

Changes to this governance document are made by pull request and reviewed like any
other change.
