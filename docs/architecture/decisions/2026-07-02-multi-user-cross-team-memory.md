# ADR 0001 — Multi-user / cross-team memory & history

- **Status:** Proposed (awaiting Mark's direction on the reserved-commercial boundary — see §11)
- **Date:** 2026-07-02
- **Author:** Architect (Workstream 2)
- **Deciders:** Mark
- **Supersedes:** none
- **Related:** `docs/server-architecture-and-team-vision.md`, `docs/server-parity-map.md`, `docs/server-storage-boundary.md`, `docs/server.md`, `docs/api.md`, `docs/ip-boundary.md`, `docs/SESSION_ID_ARCHITECTURE.md`; PRs #2383 (server-beta phases 4–13), #3070/#3078/#3087/#3089/#3090; issues #3062, #3082, #3085, #3086.

> Scope note: this ADR is a **decision record**, not an implementation plan. It contains schema shapes (DDL, column lists) and module/function names, not code. Planner and Designer consume it. The migration section (§9) deliberately leaves empirical gaps open for Workstream 3 (recall validation) to close.

---

## 1. Context

Claude-mem began as a single-user, single-machine, local-first tool: lifecycle hooks capture tool-use events, an async worker calls an LLM and writes structured observations to a local SQLite file (`~/.claude-mem/claude-mem.db`), and a Chroma vector index makes them semantically searchable. Workstream 2's goal is to let a **team** share memory and history, not just one user across sessions.

A prior diagnosis flagged five gaps that appear to block team sharing, and — critically — flagged that a **server/team runtime already appears to be scaffolded**. The first job of this ADR is therefore not to design a multi-user architecture but to determine whether a supported one **already exists that we should extend**.

It does. This ADR's survey (§2) finds a substantial, shipped, tested multi-tenant runtime ("Hosted Server (Beta)", also called `server-beta`). The headline decision (§3) is to **extend it**, not build anew. The five gaps (§4–§8) turn out to be gaps **in the legacy worker path and in the seams between the two runtimes**, not gaps in the substrate. The prime constraint (§9) is that the extension must not regress single-user local mode.

### 1.1 The prime invariant (non-negotiable)

> **Local-first stays the default and keeps working with zero server, zero auth, zero network.**
> `CLAUDE_MEM_RUNTIME=worker` (the default; `src/shared/SettingsDefaultsManager.ts:162`) must remain a complete, offline, single-user product. Every decision below is additive and opt-in. A user who never sets `CLAUDE_MEM_RUNTIME=server` must observe zero behavioral change.

---

## 2. Survey — the existing runtime(s)

Claude-mem currently ships **two runtimes selected by `CLAUDE_MEM_RUNTIME`** (`src/services/hooks/runtime-selector.ts:39-46`; default `worker`), plus **three separate API-key stores** (a real source of the "no auth" confusion in the handoff).

### 2.1 Runtime A — legacy worker (default, local-first)

- **Storage:** local SQLite (`bun:sqlite`), authoritative. Tables `sdk_sessions`, `observations`, `session_summaries`, `user_prompts`, `pending_messages`, `observation_feedback` (`src/services/sqlite/schema.sql`). **All PKs are `INTEGER PRIMARY KEY AUTOINCREMENT`.** No user/author/tenant column anywhere.
- **Index:** Chroma, **derived**. Each observation field becomes one Chroma doc with an ID derived from the SQLite rowid: `` obs_${obs.id}_narrative ``, `` obs_${obs.id}_text ``, `` obs_${obs.id}_fact_${index}`` (`src/services/sync/ChromaSync.ts:191,199,207`). Metadata (`ChromaSync.ts:162-174`): `sqlite_id, doc_type, memory_session_id, project, merged_into_project, platform_source, created_at_epoch, type, title` (+ optional `subtitle, concepts, files_read, files_modified, field_type, fact_index`). **No author field.**
- **Recall:** semantic search queries Chroma → regex-parses doc IDs back to rowids in `deduplicateQueryResults()` (`ChromaSync.ts:978-1018`, `docId.match(/obs_(\d+)_/)`) → **rehydrates full rows from local SQLite** via `SessionStore.getObservationsByIds()` (`SessionStore.ts:1832-1907`, `SELECT o.* FROM observations o … WHERE o.id IN (…)`). Orchestrated by `SearchOrchestrator.executeWithFallback()` → `ChromaSearchStrategy` (`src/services/worker/search/…`).
- **Auth:** none by design (loopback, single user). Optional `better-auth` and a `sqlite-api-key-service` exist on this surface but are **not on any request-gating path** (see §2.3).

### 2.2 Runtime B — Hosted Server (Beta) / `server-beta` (opt-in, multi-tenant)

Shipped across PR #2383 (phases 4–13, ~13K LOC) and extended by #3070/#3078/#3087. This runtime **already solves the hard parts of the multi-user problem**:

- **Storage:** Postgres, authoritative (`src/storage/postgres/schema.ts`). Tenancy is `team → project`, pervasive: `team_id` + `project_id` on `observations`, `agent_events`, `server_sessions`, `observation_generation_jobs`, with composite FKs `(project_id, team_id) REFERENCES projects(id, team_id)` enforcing that no row can cross tenants. **All PKs are `TEXT` (application-generated `newId()` = `randomUUID()`, `src/storage/postgres/utils.ts:13-15`)** — globally unique by construction.
- **Index:** Chroma, derived, but **UUID-keyed** — doc ID = the Postgres observation UUID, metadata carries `projectId` + `teamId` (`src/sdk/index.ts:663 indexObservationsToChroma`). Recall hydrates **from Postgres by scope** (`getByIdForScope`), never from a teammate's local SQLite. (Note: the FTS path `PostgresObservationRepository.search()` is the primary server-beta recall; Chroma vector recall is layered on top.)
- **Async generation:** transactional outbox → BullMQ/Valkey → `ProviderObservationGenerator` (Claude/Gemini/OpenRouter), split into separate processes so provider latency never blocks HTTP, and horizontally scalable.
- **Identity triad:** every ingest carries `api_key_id × actor_id × request_id`, threaded through `IngestEventsService` → BullMQ payload → `processGeneratedResponse` → `audit_log`. Workers re-validate `payload.team_id` against the canonical row (defense in depth).
- **Auth:** `requirePostgresServerAuth` (`src/server/middleware/postgres-auth.ts`) hashes the incoming key (`Authorization: Bearer` canonical, `X-Api-Key` fallback), looks it up in Postgres `api_keys` by `sha256(key)`, checks `revoked_at`/`expires_at`/scopes, and populates `req.authContext = { userId, organizationId, teamId, projectId, scopes, apiKeyId, mode }` (`src/server/middleware/auth.ts:13-21`). Revocation is enforced per-request (no cache).
- **Paid-readiness (PR #3078), all default-OFF / fail-open:** `usage_events` + `meterRequests`; `rate_limit_counters` + `requireRateLimit` (429); `requireMonthlyQuota` (402); gated by `CLAUDE_MEM_USAGE_METERING`, `CLAUDE_MEM_RATE_LIMIT_PER_MIN`, `CLAUDE_MEM_MONTHLY_REQUEST_CAP`, `CLAUDE_MEM_MONTHLY_TOKEN_CAP` (`src/server/routes/v1/ServerV1PostgresRoutes.ts:175-187`).
- **Data deletion / right-to-erasure (PR #3087):** `DELETE /v1/memories/:id`, `DELETE /v1/projects/:projectId/memory`, team-scoped in the WHERE clause, cross-tenant returns 404 (not 403) to avoid existence leaks (`src/storage/postgres/data-deletion.ts`).
- **Remote recall (PR #3070):** `/v1/mcp` streamable-HTTP MCP server — the read-only, team/project-scoped link a user pastes into Claude Code.

### 2.3 The three API-key stores (the "no auth" confusion, resolved)

| # | Store | Backing DB | Surface | Consulted by request auth? |
|---|-------|-----------|---------|----------------------------|
| a | `better-auth` `apiKey()` + `organization({teams})` | **bun:sqlite** | worker `/api/auth/*` (`BetterAuthRoutes`, baseURL `:37777`) | **No** — scaffolded, never gates a route (`src/server/auth/auth.ts`, mounted only at `worker-service.ts:289`) |
| b | `sqlite-api-key-service` `AuthRepository` | **bun:sqlite** | worker `middleware/auth.ts verifyServerApiKey` | Worker `/v1` only |
| c | **Postgres `api_keys`** | **Postgres** | server-beta `/v1/*` via `requirePostgresServerAuth` | **Yes — this is the only one that matters for Hosted Server** |

Only store (c) authenticates the Hosted Server. `better-auth` (store a) holds the human/org identity model (`organization`, `teams`) but writes to a different database than the routes read, and **no code maps its org/team model onto the Postgres `teams`/`api_keys` model**. This is the documented cold-start gap (`docs/api.md:74-77`).

### 2.4 IP-boundary constraint (load-bearing)

`docs/ip-boundary.md` places the **substrate primitives** (core engine, server, storage adapters, REST schemas, MCP tools) under **Apache-2.0** — and they are already shipped. But it **reserves as commercial/private**: *"Team/org memory sync", "Magic Recall hosted cloud", "Admin dashboard", "Enterprise RBAC", "SSO/SAML/SCIM", "Enterprise audit log UI"*. The multi-user **substrate** is open; the multi-user **product layer** (federation UX, dashboard, org sign-in) is reserved. This ADR recommends substrate extensions only, and flags the product-layer pieces as Mark's business decision (§11).

---

## 3. Headline decision — EXTEND server-beta, do NOT build a new architecture

**Decision: Adopt the existing Hosted Server (Beta) / `server-beta` runtime as the canonical multi-user architecture and extend it. Reject building a new one, and reject retrofitting tenancy into the legacy worker+SQLite path.**

### Rationale (one paragraph)

A Postgres-backed, BullMQ-driven, API-key-authenticated, `team`/`project` tenant-scoped runtime with a full `api_key_id × actor_id × request_id` identity triad, per-request revocation, defense-in-depth tenant checks, audit chain, usage metering, quotas, data deletion, and a remote MCP recall link **already exists, has shipped, and is tested** (Docker E2E green in `docs/server-release-readiness.md`). It already resolves the substance of gaps #1 (shared Postgres store), #2 (UUID IDs), and #4 (auth/tenancy) **in its own path**. Building a second architecture would duplicate ~13K LOC and directly violate the anti-pattern guard the parity map enforces (`docs/server-parity-map.md` §"Anti-pattern guards"). The real remaining work is not architecture — it is (a) closing four seams the substrate left open (author-as-query-dimension, the three-store auth reconciliation, the shared-vs-per-tenant Chroma collection, and a privacy/visibility model), and (b) building a non-regressing migration bridge from local mode into team mode. The five "gaps" are therefore **finishing work on an existing architecture**, which is exactly the low-risk shape we want.

The remaining sections decide each seam.

---

## 4. Gap 1 — Source of truth (shared store vs authoritative-row replication)

**Problem.** In legacy mode, SQLite is authoritative and Chroma is a derived index; recall reconstructs full rows from **local** SQLite by rowid (`ChromaSearchStrategy` → `getObservationsByIds`). A teammate's Chroma-indexed observation therefore **cannot be reconstructed on another machine** — the authoritative row lives only on the author's disk.

**Options considered.**
- **(A) Shared authoritative store (server-beta Postgres).** Team-mode writes go to Postgres; Chroma is derived and UUID-keyed; recall hydrates from Postgres by scope. *Already implemented in Runtime B.*
- **(B) Replicate authoritative rows peer-to-peer / to a shared Chroma with full row payload in metadata.** Push whole observation rows into Chroma metadata (or a CRDT sync) so any machine can reconstruct without a central DB.
- **(C) Central Postgres + keep per-machine SQLite as a write-through cache.**

**Decision: (A).** Postgres is the authoritative shared store for team mode; Chroma stays a **derived** index in both runtimes; in team mode, hydration reads Postgres by UUID and **never** a teammate's local SQLite. Local mode keeps SQLite authoritative and unchanged.

**Consequences.**
- Good: reuses the shipped path; single source of truth; tenant scoping enforced at the DB with composite FKs; deletion/erasure already work.
- Good: Chroma remains disposable/rebuildable — never authoritative — in both runtimes, matching today's invariant.
- Bad: team mode requires running Postgres (+ Valkey for generation). That is the deployment cost of sharing; it is opt-in and does not touch local users.
- Bad: option (B) — appealing for zero-infra sharing — is rejected because Chroma metadata is not a durable system of record (the handoff notes chroma-mcp rejects null/empty metadata and dedups by ID; storing whole rows there is fragile), and CRDT sync is a far larger surface than extending the shipped server.

---

## 5. Gap 2 — Globally-unique / namespaced IDs

**Problem.** Legacy fragment IDs are `obs_<local_sqlite_rowid>_<field>`; every machine's rowid sequence restarts at 1, so two machines collide the moment their Chroma docs share a collection. Recall also hard-codes the `obs_<digits>_<field>` shape: `deduplicateQueryResults()` (`ChromaSync.ts:978-1018`) **silently drops UUID-shaped IDs**, and `src/sdk/index.ts:1103` documents that the server path had to bypass it for exactly this reason.

**Options considered.**
- **(A) UUIDs end-to-end in team mode (status quo of Runtime B).** `newId()` = `randomUUID()` for every server-owned row; Chroma doc ID = Postgres observation UUID. Collisions impossible.
- **(B) Retrofit an `install_id` namespace onto legacy rowids** so legacy docs become `obs_<install_id>_<rowid>_<field>` and could be pushed to a shared collection without a full server migration.
- **(C) Content-hash IDs** (`sha256(content)`), naturally global and dedup-friendly.

**Decision: (A) for the steady state; a one-time UUID assignment at migration (see §9), not rowid retrofitting.** Team mode is already UUID-native. Historical local rows get **fresh UUIDs** during backfill, with provenance preserved by `memory_items.legacy_observation_id` (`src/storage/sqlite/schema.ts:89`) — the bridge column the storage boundary already defined. We do **not** retrofit `install_id` onto the live legacy path (option B) because a local user who never joins a team never shares a collection, so there is nothing to namespace; and we do not adopt content-hash IDs (option C) because the substrate is already UUID-committed and dedup is already handled by `content_hash`/`generation_key` at the row level.

**Consequences.**
- Good: no new ID scheme; the collision class disappears in the runtime that shares.
- Good: `legacy_observation_id` gives an idempotent, re-runnable backfill target (partial unique index already specified in `docs/server-storage-boundary.md`).
- Bad / **WS3 flag**: the legacy `deduplicateQueryResults()` regex is a latent trap — any code path that lets a UUID doc reach it silently drops results. WS3 must confirm no runtime mixes the two ID shapes in one collection (see §10).

---

## 6. Gap 3 — Author / actor dimension (the sharpest gap)

**Problem.** "Attribute, filter, or scope by teammate" is impossible today because **actor identity is captured but never persisted as a queryable column on the memory row**:
- Legacy: no author column in SQLite tables *or* Chroma metadata (§2.1).
- Server-beta: the identity triad flows through `IngestEventsService`/`processGeneratedResponse` and is written to `audit_log` and stored on `api_keys.actor_id` — but the `observations` and `agent_events` **table rows carry no `actor_id`/`api_key_id`** (confirmed: `src/storage/postgres/schema.ts:162-179, 216-231`). Author is recoverable only by a multi-hop join `observation → created_by_job_id → generation_job → agent_event → audit_log`. It is **audit-only, not scope-able.**
- The server-beta Chroma metadata (`indexObservationsToChroma`) carries `projectId`+`teamId` but **not `actor_id`**, so semantic recall cannot filter by author via the Chroma `where` clause.

**Options considered.**
- **(A) Denormalize `actor_id` (and `api_key_id`) onto `observations` + `agent_events`, and add `actor_id` to Chroma doc metadata.** Author becomes a first-class, indexed, filterable column and a Chroma `where` dimension. Additive (nullable column + backfill from `audit_log`/job lineage).
- **(B) Keep author audit-only; compute attribution at read time via the join chain.** No schema change.
- **(C) Introduce a first-class `users`/`actors` table with FKs.** Heavier identity model.

**Decision: (A).** Add nullable `actor_id TEXT` (and `api_key_id TEXT` FK) to `observations` and `agent_events` in both the Postgres schema and the SQLite server-storage schema, backfill from the existing audit/job lineage, and extend `indexObservationsToChroma` metadata to include `actorId`. Keep the `actor_id` string convention already in use (`human:alice@org`, `system:ci-runner`, `system:local-hook-bootstrap`). Do **not** introduce a `users` table yet (option C) — `actor_id` as an opaque, provider-agnostic string is sufficient for attribution and scoping, and a relational identity model belongs with the reserved enterprise-RBAC work (§11).

**Shape (DDL, not implementation):**
```sql
-- src/storage/postgres/schema.ts (additive, nullable, backfilled)
ALTER TABLE observations ADD COLUMN actor_id  TEXT;   -- 'human:alice@org' | 'system:ci-...'
ALTER TABLE observations ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE agent_events ADD COLUMN actor_id  TEXT;
ALTER TABLE agent_events ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL;
CREATE INDEX idx_observations_actor ON observations (team_id, project_id, actor_id);
-- Chroma metadata (src/sdk/index.ts indexObservationsToChroma): add `actorId` to the doc metadata object.
```

**Consequences.**
- Good: unlocks "show me only Alice's memories", per-author ranking, trust labels, cost/attribution dashboards — all as `WHERE`/`where` filters instead of join chains. Directly enables the vision doc's "auto-attribution in surfaced context."
- Good: fully additive and nullable; local mode and existing rows are untouched until backfilled.
- Bad: two write paths must now stamp `actor_id` on the row (ingest + generation) — low effort since the value is already in scope (`opts.actorId`), just not persisted to the row.
- Bad: privacy coupling — once author is queryable, a privacy/visibility model (§8) becomes more urgent, not less.

---

## 7. Gap 4 — Auth / tenancy, and reconciling the three key stores

**Problem.** Chroma itself is unauthenticated (`CHROMA_API_KEY` empty, open deployment) and the auth story is fragmented across three stores (§2.3), with a cold-start hole (no way to mint a team's first Postgres key from a human session) and a **scope-vocabulary mismatch**: the local bootstrap mints keys with worker-era scopes `['events:write','sessions:write','observations:read','jobs:read']` (`src/services/hooks/server-bootstrap.ts:39-44`), but `/v1` memory routes gate on `memories:write`/`memories:read` or `'*'` (`ServerV1PostgresRoutes.ts:163,168`). A bootstrap key **does not satisfy the `/v1/memories*` routes.**

**Options considered.**
- **(A) Postgres `api_keys` is the single canonical transport-auth store; `better-auth` is the human/org identity layer that *mints* Postgres keys via an org→team bridge; retire/quarantine `sqlite-api-key-service` for server mode.**
- **(B) Make `better-auth` (bun:sqlite) canonical and point `requirePostgresServerAuth` at it.** Rejected: it is bun:sqlite, single-file, not the tenant-scoped Postgres model the whole substrate is built on.
- **(C) Leave all three; document which is which.** Rejected: this is the status quo that produced the confusion.

**Decision: (A).** Postgres `api_keys` remains the **sole request-auth store for the Hosted Server**. Reconcile as follows:
1. **Unify the scope vocabulary.** Either the bootstrap must mint `memories:read`/`memories:write` (aligning with `/v1`), or the `/v1` routes must accept the `events:*`/`observations:*` vocabulary. Recommend the former (bootstrap adopts `memories:*`) so there is one scope language on the canonical surface. *(Concrete correctness bug to fix as part of this arc.)*
2. **Bridge `better-auth` org/team → Postgres `teams`.** `authContext` already reserves `userId`/`organizationId` (`auth.ts:13-21`, currently always null) — that is the intended seam. A human signs in via `better-auth`; a mapping service creates/links a Postgres `teams` row and mints a scoped Postgres `api_keys` row. This closes cold-start.
3. **Chroma tenancy.** In team mode, Chroma must not be an open deployment: set `CHROMA_API_KEY`, and rely on the per-tenant `where` filter (`{ $and: [ {projectId}, {teamId} ] }`, already in `src/sdk/index.ts:1110-1118`) plus collection scoping (§8.1) so a compromised or mis-scoped query cannot cross tenants.

**Consequences.**
- Good: one canonical store; `better-auth` gets a real job (human/org identity) instead of being dead scaffolding.
- Good: the cold-start dashboard mint and the org→team bridge are exactly the reserved-commercial "admin dashboard / SSO" pieces — this decision draws the open/closed line cleanly (§11).
- Bad: the org→team bridge and dashboard sign-in are net-new and partly reserved-commercial; substrate can expose the mint API, but the UX is a separate (possibly closed) deliverable.
- Bad: fixing the scope mismatch is a behavior change to bootstrap; must be covered by tests to avoid regressing the local single-user bootstrap (which today lands in Postgres only when `CLAUDE_MEM_SERVER_DATABASE_URL` is set).

---

## 8. Gap 5 (part 1) — Shared-vs-private privacy model

**Problem.** Team sharing needs an explicit answer to "what is shared vs private," and a default. Today the only privacy primitive is the *concept* of `<private>` edge-stripping (vision doc §8.3/§15); there is no `visibility` column and no default policy.

**Options considered.**
- **(A) Per-observation `visibility` enum (`private` | `team` | `org`) + two-layer enforcement:** (i) `<private>` stripping at the hook/edge before content leaves the machine; (ii) a `visibility` column on `observations` + Chroma metadata, enforced in the query `where` scope.
- **(B) Tenant-scope only (today).** Everything in a `(team, project)` is visible to that tenant; privacy = don't write it. Simplest, but no personal-scratch story and no regulated-environment story.
- **(C) Per-key read filters** (a key can be restricted to its own `actor_id`'s rows). Flexible but pushes policy into key management.

**Decision: (A), with default = `team` in team mode and an opt-in default-private switch.** Add `visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('private','team','org'))` to `observations` (and mirror into Chroma metadata + the `where` scope). Keep edge `<private>` stripping as the belt-and-suspenders layer for content that must never leave the machine at all. Provide `CLAUDE_MEM_DEFAULT_VISIBILITY=private` for regulated/opt-in-to-share environments. Local mode ignores `visibility` entirely (single user).

**Consequences.**
- Good: preserves the "social search just works" value (default `team`) while giving regulated teams a default-private inversion.
- Good: `private` + `actor_id` (§6) together express "my personal scratch, scoped to me" without a separate store.
- Bad: **this is a UX decision as much as a data decision — default visibility, the sharing toggle, and how `<private>` is surfaced in the editor are Designer's call.** This ADR sets the data model and flags the UX (§10, handoff to Designer).
- Bad: `org` visibility presumes cross-team federation, which is reserved-commercial (§11); ship `private`/`team` first, leave `org` as a forward-compatible enum value.

---

## 9. Migration path (must not regress local mode)

The invariant (§1.1) drives a **strictly additive, opt-in** migration with four states a user can be in, and no forced transition:

1. **Local-only (default, unchanged).** `CLAUDE_MEM_RUNTIME=worker`. SQLite authoritative, Chroma derived, no auth, offline. Zero change. This is and remains the default.
2. **Opt-in to team mode.** User sets `CLAUDE_MEM_RUNTIME=server` (+ `CLAUDE_MEM_SERVER_URL`, `CLAUDE_MEM_SERVER_API_KEY`, `CLAUDE_MEM_SERVER_PROJECT_ID`). `runtime-selector.ts` already routes the hook path to `/v1/events`. New captures land in Postgres, UUID-keyed, tenant-scoped, actor-stamped (§6).
3. **One-time backfill of history into the team.** Wire the **already-documented, not-yet-wired** observation→`memory_items` translator (`docs/server-storage-boundary.md`): one `memory_items` row per legacy `observations` row, `legacy_observation_id` = the SQLite rowid, `id` = fresh `newId()`, then export to the team's Postgres via `/v1/memories` (or a bulk-import endpoint) with `team_id`/`project_id`/`actor_id` applied and Chroma re-indexed under UUID docs. Idempotent via the partial unique index on `legacy_observation_id`. Backfill is **explicit and opt-in** — a local user is never auto-uploaded.
4. **Team-native.** All captures and recall go through `/v1`; local SQLite becomes a personal cache / offline fallback.

**Known migration costs (must be surfaced to users, not hidden):**
- Several legacy read surfaces are **worker-only** today (`docs/server-parity-map.md`): the SQLite-shaped data-viewer routes, `timeline`, `decisions`, corpus/knowledge-agent features, and semantic **context injection** on `UserPromptSubmit` (server-beta has no `/v1/context/semantic` yet — `docs/server-release-readiness.md` deferred item #5). A user in team mode loses these until `/v1` parity is built. **This is the single biggest migration regression risk and overlaps heavily with WS3.**
- Issue #3082: the `search` MCP tool routes to worker `/api/search` even under server-beta and returns **0 observations** because it reads a frozen local SQLite. The tool surface is not runtime-aware. This must be fixed before team mode is usable via the `search` tool.
- Issue #3062: project identity is derived from the git root; re-homing a dir or `git init` on a parent collapses/orphans history. Whatever the team-mode `project_id` mapping is, it must be **stable across dir moves** (a per-directory project override / stable project key), or team history fragments the same way. This is a `projects` identity decision that team mode makes more acute.

---

## 10. Open questions handed to Workstream 3 (recall validation)

WS3 is empirically enumerating every place recall silently depends on the local DB. This ADR's migration section (§9) depends on that enumeration. Specific questions for WS3 to answer and feed back:

1. **Hydration dependency:** confirm that `SearchOrchestrator` → `ChromaSearchStrategy` → `getObservationsByIds` (and `HybridSearchStrategy`, `CorpusBuilder`) hydrate **only** from local SQLite, so a teammate's Chroma-indexed rowid cannot be reconstructed cross-machine. (Expected: yes — this is gap #1's mechanism.)
2. **ID-shape trap:** confirm `deduplicateQueryResults()` silently drops UUID-shaped doc IDs, and that no runtime ever mixes `obs_<rowid>_<field>` and UUID docs in a single Chroma collection. Enumerate every caller that could.
3. **Runtime-awareness of MCP tools:** enumerate which MCP tools (`search`, `timeline`, `get_observations`, `observation_search`, `session_start_context`, …) are runtime-aware vs. hard-wired to the worker `/api/*` SQLite path. #3082 is one instance; find the rest.
4. **Context injection:** confirm `UserPromptSubmit` semantic injection is worker-only and silently no-ops (or falls back to worker/local) under `CLAUDE_MEM_RUNTIME=server`. This determines whether team-mode users get injection at all.
5. **Which recall path each runtime actually uses:** server-beta primary recall is Postgres FTS (`PostgresObservationRepository.search`); Chroma vector recall is secondary. WS3 should measure which path fires for a real team-mode query, and whether FTS-only recall is acceptable until Chroma-in-team-mode is proven.
6. **Cross-project `merged_into_project` semantics** under team mode (relevant to #3062): does the read-side `WHERE o.project = ? OR o.merged_into_project = ?` have a Postgres equivalent?

Every "yes, recall silently depends on local SQLite here" WS3 finds becomes a line item in the §9 parity/backfill work.

---

## 11. Decisions needed from Mark before this becomes an implementation arc

1. **Open/closed boundary.** `docs/ip-boundary.md` reserves "Team/org memory sync", the admin dashboard, enterprise RBAC, and SSO as **commercial/private**. The substrate extensions in §4–§8 are Apache-2.0-appropriate and additive. But the **org→team bridge, cold-start dashboard mint, and any federation UX** sit on the reserved line. Decision: which pieces of Gap-4 reconciliation (§7) ship in the open repo vs. a private layer?
2. **Is team memory a product now, or substrate-hardening?** The substrate is shipped and tested; §4–§8 are finishing work. Do we green-light the finishing work (actor_id denormalization, visibility model, scope unification, Chroma auth) as an implementation arc now, or hold until WS3 validates recall (§10)? Recommendation: **fix the two correctness bugs immediately** (scope-vocabulary mismatch §7.1; `search`-tool runtime-awareness #3082 §9), and gate the larger schema/visibility work behind WS3's findings.
3. **Default visibility & the sharing UX** (§8) is a Designer decision. Approve handing §8's data model to Designer for the sharing/`<private>` UX spec?
4. **Packaging/PR mechanics** (per coordinator's constraint): this ADR is committed **locally only** — no push, no PR against `thedotmack/claude-mem`. Whether to later push to a fork / open a PR is deferred to Mark.

---

## 12. Consequences (summary)

**Positive.**
- Zero new architecture; we extend a shipped, tested substrate and stay inside the anti-pattern guard.
- The prime invariant holds: local-first is untouched and remains the default.
- Every schema change is additive and nullable; every behavior change is opt-in via env.
- The five "gaps" reduce to: 2 correctness bugs (fix now), 2 additive schema seams (actor_id §6, visibility §8), 1 auth reconciliation (§7), and 1 migration bridge (§9) — a tractable, mostly-additive arc.

**Negative / risks.**
- Team mode carries real deployment cost (Postgres + Valkey) and real feature regressions vs. legacy (worker-only viewer/timeline/corpus/context-injection) until `/v1` parity is built. WS3 sizes this.
- The auth reconciliation touches the reserved-commercial boundary; part of it may not live in the open repo.
- `actor_id` denormalization + visibility make privacy a live concern that must be designed (Designer), not just stored.

---

## 13. References (code, for Planner/Designer)

- Runtime selection / env: `src/services/hooks/runtime-selector.ts`, `src/shared/SettingsDefaultsManager.ts:161-171`, `src/server/runtime/ServerService.ts:860-868` (port = `37877 + (getuid ?? 77) % 100`; on Windows this resolves to `37954`).
- Legacy Chroma path: `src/services/sync/ChromaSync.ts` (IDs `:191/199/207`, metadata `:162-174`, dedup `:978-1018`); recall `src/services/worker/search/…`, hydration `src/services/sqlite/SessionStore.ts:1832-1907`.
- Server-beta storage: `src/storage/postgres/schema.ts` (observations `:216-231`, agent_events `:162-179`, api_keys `:112-125`); `src/storage/sqlite/schema.ts` (`memory_items` `:85-105`, `legacy_observation_id` `:89`).
- Server-beta auth/ingest/generation: `src/server/middleware/postgres-auth.ts`, `src/server/middleware/auth.ts:13-21`, `src/server/services/IngestEventsService.ts`, `src/server/generation/processGeneratedResponse.ts`, `src/server/routes/v1/ServerV1PostgresRoutes.ts`.
- better-auth (scaffolded, worker/bun:sqlite): `src/server/auth/auth.ts`, `src/server/auth/BetterAuthRoutes.ts`, `src/server/auth/sqlite-api-key-service.ts`.
- Server-beta Chroma (UUID-keyed): `src/sdk/index.ts:663 indexObservationsToChroma`, query `:1099-1124`.
- Docs: `docs/server-architecture-and-team-vision.md`, `docs/server-parity-map.md`, `docs/server-storage-boundary.md`, `docs/server.md`, `docs/api.md`, `docs/ip-boundary.md`.
