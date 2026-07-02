# Roadmap — Distributed-team onboarding for claude-mem

- **Status:** Proposed (roadmap; extends ADR 0001, does not supersede it)
- **Date:** 2026-07-02
- **Author:** Architect (Workstream 2)
- **Deciders:** Mark
- **Extends:** `docs/architecture/decisions/2026-07-02-multi-user-cross-team-memory.md` (ADR 0001)
- **Related:** `docs/bug-fixes/3082-search-server-runtime-routing.md`, `docs/bug-fixes/serverbeta-scope-vocabulary-reconciliation.md` (Phase 0); `docs/server-architecture-and-team-vision.md`, `docs/server-storage-boundary.md`, `docs/migration-worker-to-server.md`, `docs/docker.md`, `docs/ip-boundary.md`, `docs/server-parity-map.md`, `docs/server-release-readiness.md`.

> **Scope.** This is a *roadmap / design doc*, not an implementation plan and not an ADR (it decides no new architecture — ADR 0001 already decided "extend server-beta"). It sequences the implementation arc that turns ADR 0001's decisions into "how Mark includes his **remote** teammates" without regressing his personal local-first mode. It contains hosting recipes, onboarding steps, schema deltas (shapes, not code), and a phased PR sequence. No production code. Planner picks up the per-phase plans; Designer picks up the flagged UX (§4.2, §9).

---

## 0. The one-sentence framing

ADR 0001 decided *what* the multi-user architecture is (extend the shipped `server-beta` Postgres/BullMQ/api_keys runtime; keep local-first as the untouched default). **This roadmap decides *how Mark onboards remote teammates onto it*** — where the server runs so people who are **not on his LAN** can reach it, what a teammate does on day 1, how his local history migrates in without a forced cutover, and in what PR-sized order the four remaining seams land. The through-line is a single non-regression invariant (§9): Mark's personal `CLAUDE_MEM_RUNTIME=worker` + local SQLite + LAN Chroma at `appserver.lan` path stays **byte-for-byte unchanged**, because none of these phases touch the worker path.

---

## 1. The reachability problem (why this roadmap exists at all)

Mark's personal setup is local-first: authoritative SQLite at `~/.claude-mem/claude-mem.db`, a LAN Chroma index at `appserver.lan` (`192.168.86.167`, DHCP, LAN-only). That box is **not routable from the public internet** and his teammates are **remote** (not on his LAN). So the shipped `server-beta` runtime — which already solves tenancy, auth, and shared storage (ADR 0001 §2.2) — has nowhere a remote teammate can reach it. The first deliverable is therefore not schema; it is **where the server lives**.

The server-beta runtime is a **four-service stack** (all already shipped; see `docs/docker.md`):

| Service | Role | Stateful? | Notes |
|---|---|---|---|
| Node/Express server | `/v1/*` ingest + recall + `/v1/mcp` | no | the only thing teammates' clients talk to |
| Postgres | authoritative store (ADR 0001 §4, decision A) | **yes** | tenant scoping via composite FKs `(project_id, team_id)` |
| Valkey/Redis | BullMQ queue for async generation | semi | can be ephemeral; jobs re-drivable |
| Chroma | derived vector index (ADR 0001 §5) | rebuildable | needed for §5 vector recall; not authoritative |

"Onboard a remote team" = *stand this stack up somewhere reachable, then point teammates at it.*

---

## 2. Deliverable 1 — Hosting options for a remote team

Four concrete shapes. His LAN box (`appserver.lan`) is not reachable as-is; H3 is the only option that keeps data on that hardware.

### H1 — Self-host on a VPS / cloud VM (RECOMMENDED steady state)
One small VM (2 vCPU / 4 GB is ample at team scale — recall is interactive, single-digit QPS peak; the CPU cost is Chroma embedding, not query volume) running the four-service `docker-compose` stack from `docs/docker.md`, TLS-terminated by Caddy/nginx, on public DNS (`https://mem.<mark-domain>`). Teammates hit `https://mem.<mark-domain>/v1/mcp`.
- **Reachability:** public internet — every remote teammate can reach it. Best.
- **Auth surface:** public endpoint, so it *must* be TLS + gated by the Postgres `api_keys` middleware (`requirePostgresServerAuth`) — which is exactly what server-beta already enforces per-request. Set `CHROMA_API_KEY` so Chroma isn't an open deployment (ADR 0001 §7.3).
- **Ops burden:** one box — Mark patches, backs up Postgres, renews TLS. Lowest for the value delivered.
- **Data residency:** Mark chooses provider + region outright.

### H2 — Managed cloud primitives + small app host
Managed Postgres (Neon/Supabase/RDS) + managed Redis (Upstash/ElastiCache) + a container host (Fly.io/Render/Railway) for the Node server + Chroma.
- **Reachability:** public — good.
- **Auth surface:** same api_keys gate; more network edges (three vendors) to secure.
- **Ops burden:** lowest for the *stateful* tier (managed backups/HA/PITR), at higher $ and multi-vendor complexity. Chroma still needs a home (its own container, or Chroma Cloud).
- **Data residency:** spread across providers — a governance cost if that matters.

### H3 — Expose his existing `appserver` box over a mesh VPN (BEST zero-cost pilot)
Keep the server on Mark's hardware; put Mark + each remote teammate on a **Tailscale/WireGuard tailnet**; teammates reach the box at its stable tailnet name (`appserver` / a `100.x` address), not its DHCP LAN IP. The four-service stack runs on the box; teammates' clients point at `http://appserver:37877/v1/mcp` over the tailnet.
- **Reachability:** tailnet members only — a private perimeter with **zero public attack surface**.
- **Auth surface:** smallest — network-gated by the tailnet *and* the api_keys gate (defense in depth). TLS optional inside the tailnet.
- **Ops burden:** Mark runs Tailscale on the box + each teammate installs the client once. DHCP no longer matters (tailnet name is stable), but the box must be always-on and team uptime is coupled to Mark's home power/uplink.
- **Data residency:** stays on Mark's own hardware/home. Maximum privacy, zero marginal $.

### H4 — Managed hosted cloud ("Magic Recall") — RESERVED-COMMERCIAL
The turnkey SaaS. Explicitly reserved per `docs/ip-boundary.md` ("Magic Recall hosted cloud"). Named only to mark the boundary; not a self-host path Mark builds in the open.

### Recommendation
**Pilot on H3, run steady-state on H1.** H3 (Tailscale-exposed `appserver`) is the fastest way to validate the *entire* remote-team path — real remote teammates, real writes into shared Postgres, real cross-machine recall — at **zero marginal cost and zero public exposure**, reusing the hardware Mark already owns. It is not the steady state because it pins team availability to a home box on a residential uplink. Once the path is proven, **H1** (single VPS, one `docker-compose`, TLS via Caddy) gives public reachability with the smallest ops surface and clean data-residency control. H2 is the upgrade path only if/when the stateful tier's backups/HA become worth the multi-vendor cost.

---

## 3. Deliverable 2 — Day-1 onboarding walkthrough for a remote teammate

Two roles: **Mark (host/admin)** and **teammate (remote)**. Two teammate tiers: **consume-only** (works with shipped code today) and **contribute** (needs Phase 0 + a write-capable key mint).

### 3.1 Mark (once, per team)
1. Stand up the stack (H1 or H3).
2. Create the `teams` row + `projects` row in Postgres (a `team → project` tenant; ADR 0001 §2.2). *Cold-start note:* today the first key is minted by the local bootstrap (`src/services/hooks/server-bootstrap.ts`) or the CLI; a human-driven "create team + first key" flow is the org→team bridge (Phase 5, §7).
3. For each teammate, mint a scoped key.

### 3.2 Teammate — consume-only (SHIPPED TODAY, PR #3070)
- Mark runs `POST /v1/keys` → returns a **read-only** (`['memories:read']`) key **and** a paste-ready connect command (`connectCommand: mcpConnectCommand(mcpUrl, raw)`, `ServerV1PostgresRoutes.ts:203-234`). The raw key is shown once.
- Teammate pastes the `claude mcp add …` command Mark sends. Their Claude Code gains the read-only recall MCP tools over `/v1/mcp` (streamable-HTTP), scoped to `(team_id, project_id)`.
- **They install nothing else.** They can recall team memory immediately. This is the shipped, tested PR #3070 path.

### 3.3 Teammate — contribute (needs Phase 0 + write-capable mint)
Set four env vars (names confirmed in `src/shared/SettingsDefaultsManager.ts:81-83,166-168`):
```
CLAUDE_MEM_RUNTIME=server
CLAUDE_MEM_SERVER_URL=https://mem.<mark-domain>      # or http://appserver:37877 on the tailnet
CLAUDE_MEM_SERVER_API_KEY=<write-capable key>
CLAUDE_MEM_SERVER_PROJECT_ID=<project uuid>
```
Their hooks now POST captures to `/v1/events`; generation runs server-side; their observations land in **shared Postgres**, UUID-keyed, tenant-scoped, actor-stamped. **Two prerequisites this roadmap must deliver:**
- **Phase 0 scope fix** — today the bootstrap mints `events:*`/`observations:*` scopes that satisfy *none* of the `/v1` routes (`403`); the fix mints `memories:*` (see `docs/bug-fixes/serverbeta-scope-vocabulary-reconciliation.md`). Without it a contribute-tier key is dead.
- **A write-capable mint** — `POST /v1/keys` mints read-only only (`scopes: ['memories:read']`, hard-coded `:221,229`). Contributing teammates need `memories:read,memories:write`. This is a small, additive endpoint delta in Phase 3 (§7), guarded by the same "you must already have write to mint a lesser key" escalation rule.

### 3.4 What a teammate sees (visibility model)
- **Tenant floor:** every read is scoped by the api_keys row + `requirePostgresServerAuth` to `(team_id, project_id)`. A composite FK guarantees no row crosses tenants. This is enforced today.
- **Author dimension (Phase 1):** once `actor_id` is denormalized (§4.1), Mark can filter "show me only Alice's memories" as a `WHERE`/`where` clause instead of a five-hop audit join.
- **Visibility dimension (Phase 2):** with the `visibility` enum, a teammate sees `visibility IN ('team','org')` within the tenant; a `private` row (someone's personal scratch) is filtered unless they are its author. Default write visibility = `team`.

### 3.5 How a teammate's writes are attributed (author field)
Every contribute-tier write is stamped `actor_id` (convention `human:alice@org`, already in use) + `api_key_id`, denormalized onto the observation row (ADR 0001 §6) and mirrored into Chroma `actorId` metadata. The value is already in scope at ingest (`opts.actorId`) — Phase 1 persists it to the row instead of only to `audit_log`.

---

## 4. Deliverable 4 — The additive seams (schema / metadata)

*(Deliverable 3, migration, is §6; sequenced after the seams it depends on.)* These restate ADR 0001 §6 and §8 as the concrete, additive schema delta. All columns are nullable-or-defaulted and backfilled; local mode ignores them entirely.

### 4.1 Author seam (ADR 0001 §6)
```sql
-- src/storage/postgres/schema.ts + src/storage/sqlite/schema.ts (server-storage), additive
ALTER TABLE observations ADD COLUMN actor_id  TEXT;   -- 'human:alice@org' | 'system:ci-...'
ALTER TABLE observations ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE agent_events ADD COLUMN actor_id  TEXT;
ALTER TABLE agent_events ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL;
CREATE INDEX idx_observations_actor ON observations (team_id, project_id, actor_id);
-- Chroma: add `actorId` to the metadata object in indexObservationsToChroma (src/sdk/index.ts:663).
```
Backfill from the existing `observation → created_by_job_id → generation_job → agent_event → audit_log` lineage. Two write paths stamp it (ingest + generation) — both already have the value.

### 4.2 Visibility seam (ADR 0001 §8) — data model here, UX is Designer's
```sql
ALTER TABLE observations
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team'
  CHECK (visibility IN ('private','team','org'));
-- Mirror `visibility` into Chroma metadata + the recall `where` scope.
```
- Enforcement is **two-layer**: (i) edge `<private>` stripping at the hook, before content leaves the machine (belt-and-suspenders — some content must *never* be transmitted); (ii) the `visibility` column, enforced in the query `where`.
- Default `team` in team mode; `CLAUDE_MEM_DEFAULT_VISIBILITY=private` inverts it for regulated/opt-in-to-share teams.
- `org` is a **forward-compatible enum value only** — it presumes cross-team federation, which is reserved-commercial (§7 Phase 5). Ship `private`/`team`; leave `org` inert.
- **Flag to Designer:** default visibility, the per-capture sharing toggle, and how `<private>` surfaces in the editor are UX decisions this roadmap does **not** make (ADR 0001 §8, §10).

---

## 5. Deliverable 5 — Vector recall in team mode (the sharp finding)

**Empirical state (verified against `main`), reconciling the "FTS-only" constraint with the shipped code:**

| Surface | What it calls | Recall type |
|---|---|---|
| Write path (server generation) | `indexObservationsToChroma` (`src/sdk/index.ts:1048`) | Chroma index **already written**, UUID-keyed, `projectId`+`teamId` metadata |
| SDK `client.search()` (`src/sdk/index.ts:1078+`) | `ChromaMcpManager.callTool('chroma_query_documents', …)` with `where:{$and:[{projectId},{teamId}]}`, hydrate via `getByIdForScope` | **Chroma vector — proven**, deliberately bypasses the buggy `deduplicateQueryResults()` |
| HTTP `POST /v1/search` (`ServerV1PostgresRoutes.ts:945`) | `PostgresObservationRepository.search()` | **Postgres FTS only** |
| `/v1/mcp` RecallBackend (`ServerV1PostgresRoutes.ts:1047`) | `PostgresObservationRepository.search()` | **Postgres FTS only** |

So: **team observations are already being embedded into Chroma at write time, and a proven per-tenant Chroma vector-read path already exists in the SDK — but neither remote-facing read surface (`/v1/search`, `/v1/mcp`) calls it.** Every remote teammate gets FTS-only recall today. The vector capability is *built and wired on the write side and the SDK read side; unwired on the remote read surface.*

### Build-vs-reuse decision: **REUSE.**
The work is **wiring, not building.** Route `/v1/search` and the `RecallBackend.search`/`.context` through the already-proven Chroma path (`chromaSync` query with `$and:[{projectId},{teamId}]`, extended with `{actorId}` (Phase 1) and `{visibility}` (Phase 2) once those land), hydrating via `getByIdForScope`. Keep `PostgresObservationRepository.search()` (FTS) as the **graceful fallback** — the code already treats Chroma loss as *degraded, not catastrophic* (`sdk/index.ts:1040-1052` comment). No new ID scheme, no new embedding pipeline.

### The one real infra decision for Mark: **Chroma-wired vs pgvector**
- **Chroma (wire-only):** already indexed on write, already proven on SDK read → Phase 4 is pure wiring. Cost: a **third stateful service** in every self-host (Postgres + Valkey + Chroma), a separate `CHROMA_API_KEY` perimeter, and a Chroma **embedding function that must stay consistent** between index-time and query-time.
- **pgvector (collapse into Postgres):** one fewer service, one backup, tenant scoping via the *same* composite-FK rows Mark already runs, no separate Chroma auth perimeter. Cost: re-implement the embedding write + ANN query (throw away the wired Chroma path) — more code, simpler ops.
- **Recommendation:** ship **Chroma-wired-into-`/v1` first** (fastest close of the FTS-only gap, reuses proven code, unblocks the whole team-recall value), and treat **pgvector as a fast-follow ops-simplification** for self-hosters who don't want a third stateful service. This is the biggest technical decision in the arc (§10) because it sets the ops shape of every self-host.

---

## 6. Deliverable 3 — SQLite→Postgres migration / replication (additive, reversible)

Extends ADR 0001 §9. Four states, **no forced transition**, local SQLite never mutated or deleted:

1. **Local-only (default, unchanged).** `RUNTIME=worker`. SQLite authoritative, LAN Chroma derived, no auth, offline. **This is Mark's personal mode — zero change.**
2. **Opt-in team mode.** Set the four env vars (§3.3). New captures land in shared Postgres, UUID-keyed, actor-stamped. Local SQLite still exists as a personal cache / offline fallback.
3. **One-time history backfill (explicit opt-in).** Wire the documented-but-unwired `observations → memory_items` translator (`docs/server-storage-boundary.md`): one `memory_items` row per legacy `observations` row, `legacy_observation_id` = the SQLite rowid, `id` = fresh `newId()`, exported to the team's Postgres with `team_id`/`project_id`/`actor_id`/`visibility` applied, then Chroma re-indexed under UUID docs. **Idempotent** via the partial unique index on `legacy_observation_id`. A local user is *never* auto-uploaded.
4. **Team-native.** Captures + recall go through `/v1`; local SQLite is a read cache / offline fallback.

**Reversibility.** Because state 1's SQLite is never mutated, re-pointing `CLAUDE_MEM_RUNTIME` back to `worker` returns the user to a fully-working local-first install. The backfill is a *copy up*, not a *move*.

**Backfill throughput / open gap.** There is **no bulk-import endpoint** today — only single-row `POST /v1/memories` (`ServerV1PostgresRoutes.ts:911`, a "compat alias"). Looping it at ~20–50 rows/s is tolerable for a solo user's low-thousands of observations (minutes), but a heavy history (6-figure rows) argues for a **bulk `/v1/memories:import` endpoint** (Phase 3 open item, §7 / §10).

**Known migration regressions (must be surfaced, not hidden — ADR 0001 §9):** several read surfaces are worker-only today — the SQLite-shaped data-viewer routes, `timeline`, `decisions`, corpus/knowledge-agent, and semantic **context injection** on `UserPromptSubmit` (no `/v1/context/semantic` yet). A team-native user loses these until `/v1` parity is built. **This is the single biggest migration regression risk** and is why full team-native (state 4) should trail behind, not lead. Also `#3062`: team-mode `project_id` must be **stable across dir moves** or team history fragments the same way the local git-root heuristic does.

---

## 7. Deliverable 6+7 — Auth reconciliation & the phased, PR-sized sequence

Auth reconciliation (ADR 0001 §7) threads through the phases rather than standing alone: Postgres `api_keys` is the sole request-auth store; Phase 0 unifies the scope vocabulary; Phase 3 adds the write-capable mint; Phase 5 adds the `better-auth` org/team → Postgres `teams` bridge (cold-start) and Chroma tenancy (`CHROMA_API_KEY`, or moot under pgvector).

### The sequence

| Phase | Deliverable | Depends on | Additive/opt-in? | IP boundary |
|---|---|---|---|---|
| **0** | **Correctness bugs (already planned, in flight).** (a) scope-vocabulary reconciliation → bootstrap mints `memories:*`; (b) `#3082` `search` runtime-routing + `timeline`/`get_observations` server guards. | — | yes (worker path untouched) | **OPEN** (Apache-2.0 substrate; independent of §11) |
| **1** | **Author seam.** `actor_id`/`api_key_id` on `observations`+`agent_events` (PG + SQLite server schema), backfill from audit/job lineage, `idx_observations_actor`, `actorId` in Chroma metadata. | 0 | yes (nullable + backfill) | **OPEN** |
| **2** | **Visibility seam.** `visibility` enum + `where` enforcement + `<private>` stripping + `CLAUDE_MEM_DEFAULT_VISIBILITY`. Data model only. | 1 | yes (defaulted) | **OPEN** data model; **sharing UX → Designer; `org` value → reserved (federation)** |
| **3** | **Hosting + migration bridge.** `docker-compose` deploy recipe (H1) + Tailscale recipe (H3) + `observations→memory_items` backfill translator + write-capable `/v1/keys` mint + bulk-import endpoint + onboarding docs. | 0 (auth), 1–2 (stamp actor/visibility on backfill) | yes (opt-in tooling) | **OPEN** self-host recipe + docs; **note:** productized/turnkey installer = reserved ("Customer deployment tooling") |
| **4** | **Vector-in-team-mode.** Wire `/v1/search` + `RecallBackend` through the proven Chroma path (+ `actorId`/`visibility` filters); FTS fallback. Optional pgvector fast-follow. | 1–2 (filter dims), 3 (Chroma deployed) | yes (server-only) | **OPEN** |
| **5** | **Org→team bridge (Gap 4 cold-start).** `better-auth` org/team → Postgres `teams` mapping; human-driven team+first-key creation; dashboard key mint; Chroma `CHROMA_API_KEY` tenancy. | 0, 3 | yes (server-only) | **ON THE RESERVED LINE** — substrate *mint API* can be OPEN; org sign-in UX + SSO/SCIM + team/org memory sync + admin dashboard = **RESERVED-COMMERCIAL** |

### Position relative to the commercial boundary
Per Mark's confirmed direction (build the full capability on his fork; document the upstream IP boundary), **Phases 0–4 are clean Apache-2.0 substrate** — open on the fork *and* upstream-eligible. **Phase 5 straddles the reserved line**: the Postgres-key **mint API** is substrate (open), but the org sign-in UX, SSO/SAML/SCIM, cross-team federation (`org` visibility), the admin dashboard, and "team/org memory sync" are reserved-commercial per `docs/ip-boundary.md`. When Mark builds Phase 5 on his fork, mark those pieces in `docs/ip-boundary.md` as **fork-built / upstream-reserved** so the open/closed line stays legible.

---

## 8. Auth reconciliation detail (Deliverable 6, cross-referenced)

Single canonical store = Postgres `api_keys` (ADR 0001 §7, decision A). The three moving parts across the phases:
1. **Scope vocabulary (Phase 0).** Bootstrap mints `['memories:read','memories:write']` — the vocabulary every `/v1` route already gates on. Fixes the `403` that makes a server-mode install unable to `POST /v1/events`.
2. **Write-capable teammate mint (Phase 3).** `POST /v1/keys` gains an opt-in `scopes` including `memories:write`, guarded by the existing "you must already hold write to mint a lesser key" escalation rule (`writeAuth` on the route).
3. **org→team bridge + Chroma tenancy (Phase 5).** `authContext.userId`/`organizationId` (reserved seam, currently null) is where a `better-auth` human/org identity maps onto a Postgres `teams` row and mints scoped keys — closing cold-start. Chroma gets `CHROMA_API_KEY` (moot if pgvector is chosen in §5). This is the piece that sits on the reserved boundary.

---

## 9. Deliverable 8 — The non-regression invariant, stated and defended

> **Prime invariant (from ADR 0001 §1.1):** Local-first stays the default and keeps working with **zero server, zero auth, zero network**. `CLAUDE_MEM_RUNTIME=worker` (the default) must remain a complete, offline, single-user product. **Mark's personal setup — local SQLite + LAN Chroma at `appserver.lan` — must observe zero behavioral change.**

How each phase preserves it:

| Phase | Why the worker/local path is untouched |
|---|---|
| 0 | Scope fix touches only Postgres bootstrap keys (worker uses unauthenticated loopback `/api/*`); `search`/`timeline`/`get_observations` changes only branch on `selectRuntime()==='server'` — worker branch is byte-for-byte unchanged. |
| 1 | New columns are nullable and only written on the server ingest/generation paths; worker SQLite schema + Chroma metadata are not on this path. |
| 2 | `visibility` defaulted; worker (single user) ignores it entirely — no `where` scoping, no `<private>` column read. |
| 3 | Hosting recipes + backfill are opt-in tooling; backfill *copies up* and never mutates local SQLite; a user who never opts in is untouched. Reversible by re-pointing `CLAUDE_MEM_RUNTIME=worker`. |
| 4 | Vector wiring is inside the `/v1` (server) surface only; the worker's local Chroma-at-`appserver.lan` recall path is not modified. |
| 5 | org/SSO/dashboard is server-mode identity; the worker has no auth and never consults it. |

**The invariant holds because the seam is `CLAUDE_MEM_RUNTIME`, not a shared code path.** Every phase adds to the `server` branch; Mark's `worker` branch — and his LAN Chroma box — is never in the blast radius.

---

## 10. Open decisions needed from Mark (before this becomes buildable work)

1. **Hosting shape to provision now** (§2): approve **H3 (Tailscale-exposed `appserver`) for the pilot → H1 (VPS) for steady state**? This gates Phase 3.
2. **Vector tier: Chroma-wired vs pgvector** (§5). Recommendation: Chroma-wired first (Phase 4 is pure wiring), pgvector as a fast-follow. This is the biggest technical decision — it sets the self-host footprint (three stateful services vs. two) and whether a `CHROMA_API_KEY` perimeter exists.
3. **Bulk-import endpoint for backfill** (§6): approve adding `POST /v1/memories:import` in Phase 3, or accept looping single `/v1/memories` for the pilot (fine at low-thousands of rows)?
4. **Phase 5 open/closed placement** (§7): confirm the org→team bridge + dashboard mint + SSO are built on the fork but marked **upstream-reserved** in `docs/ip-boundary.md`, with only the substrate mint API upstream-eligible?
5. **Visibility UX handoff** (§4.2): approve handing the §4.2 data model to Designer for the default-visibility + `<private>` sharing UX spec?
6. **Phase 0 gating** (from ADR 0001 §11): confirm Phase 0's two correctness bugs proceed immediately (they are already planned on `docs/ws2-serverbeta-bugfixes`), independent of the rest of the arc.

---

## 11. Consequences (summary)

**Positive.**
- Reuses the shipped substrate end-to-end: hosting is `docker-compose` that already exists; vector recall is *wiring a proven path*, not building one; migration rides the already-documented `memory_items` bridge.
- The prime invariant holds structurally (§9): the seam is an env var, not a shared path — Mark's local-first + LAN Chroma is never in the blast radius.
- A clean open/closed line: Phases 0–4 are Apache-2.0 substrate; only Phase 5 straddles the reserved boundary, and cleanly.

**Negative / risks.**
- **Feature-parity regression for team-native users** (§6) — worker-only `timeline`/corpus/context-injection are lost until `/v1` parity is built. This is the biggest *risk* and is why team-native (state 4) trails, not leads.
- **The Chroma-vs-pgvector call** (§5) sets every self-host's ops footprint and is not reversible cheaply once history is embedded one way.
- **Phase 5 touches reserved-commercial IP** — the org/SSO/dashboard layer must be boundary-marked, not silently shipped open.
