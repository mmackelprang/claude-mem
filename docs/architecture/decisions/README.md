# Architecture Decision Records (ADRs)

This directory holds architecture decision records — durable, cross-PR decisions about data models, API shapes, service boundaries, and cross-cutting abstractions. ADRs are consumed by Planner (implementation) and Designer (UX implications); most single-PR work does not need one.

Naming: `YYYY-MM-DD-<topic>.md`. Status is one of `Proposed`, `Accepted`, `Superseded`.

| ADR | Date | Status | Topic |
|-----|------|--------|-------|
| [0001](./2026-07-02-multi-user-cross-team-memory.md) | 2026-07-02 | Proposed | Multi-user / cross-team memory & history — extend the Hosted Server (Beta) runtime; close the author, auth, privacy, and migration seams. |
| [0002](./2026-07-14-upstream-v13.11.0-fork-merge.md) | 2026-07-14 | Accepted | Merging upstream v13.11.0 into the personal fork — single merge (not rebase), fork-only topology, per-file conflict resolution rules, and WS2 non-regression gates. |

## Related long-form architecture docs

- `../../server-architecture-and-team-vision.md` — the shipped server-beta substrate (phases 4–13) and team vision.
- `../../server-parity-map.md` — legacy `/api/*` → server-beta `/v1/*` route parity.
- `../../server-storage-boundary.md` — the additive server-owned tables and the observation→memory_items translation.
- `../../ip-boundary.md` — open-core (Apache-2.0) vs. reserved-commercial boundary.
