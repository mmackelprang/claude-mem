# Design — Connection Profiles + Server-Config Wizard (Settings UI)

- **Date:** 2026-07-16
- **Status:** Approved (brainstorm complete; Phase 1 → Designer + Planner next)
- **Author:** Coordinator (with Mark)
- **Consumers:** Designer (UX handoff for the Connection panel + wizard), Planner (config-seam plan)
- **Related:** the viewer Settings panel (`src/ui/viewer/`, `src/services/worker/http/routes/SettingsRoutes.ts`), `src/shared/SettingsDefaultsManager.ts`, `src/server/runtime/create-server-service.ts`, `TEAM-CONFIG.md`, `docs/ops/2026-07-15-nas-server-setup.md`

---

## 1. Purpose

Make it **easy and intuitive** to (a) point a claude-mem client at a collection server — local, LAN, or Tailscale — and (b) set up the server's generation config (`CLAUDE_MEM_SERVER_PROVIDER`, `ANTHROPIC_API_KEY`, `CLAUDE_MEM_SERVER_MODEL`) — from the Settings UI, on both the local UI and the server's own UI.

Today both are manual and error-prone:
- **Connecting a client** means hand-editing four `settings.json` keys; miss any one and the client **silently falls back to local worker mode** — the exact failure that left the NAS pilot green-but-capturing-nothing for 11 days.
- **Server generation config** is set as container env vars at creation time, with an un-warned **silent 3× cost trap** (the `claude-sonnet-4-6` default vs `claude-haiku-4-5`) and a `CLAUDE_MEM_SERVER_MODEL`-not-`CLAUDE_MEM_MODEL` gotcha.

---

## 2. The architecture split (grounded findings)

Mark's ask lands on a real fault line in the codebase:

| Config | Where it's read | UI-mutable today? |
|---|---|---|
| **Client connect** — `CLAUDE_MEM_RUNTIME`, `SERVER_URL`, `SERVER_API_KEY`, `SERVER_PROJECT_ID` | `settings.json` via `loadFromFileOnce()`; keys already defined in `SettingsDefaultsManager` (:86, :93–95, :180, :185–190) | **Yes in principle** — but the `/api/settings` POST allow-list (`SettingsRoutes.ts`) does **not** currently list them, so persistence needs plumbing. |
| **Server generation** — `CLAUDE_MEM_SERVER_PROVIDER`, `ANTHROPIC_API_KEY`, `CLAUDE_MEM_SERVER_MODEL` | `process.env` **only** (`create-server-service.ts:243, 261, 268, 275`); the server runtime **never reads `settings.json`** | **No** — env-only, baked at container creation. Live UI mutation would require the server to read gen-config from a mutable store. |

**Hard constraint over both:** the viewer HTTP server has **no authentication**. Entering an `ANTHROPIC_API_KEY` into an unauthenticated web UI is questionable on localhost and a genuine exposure on a LAN/Tailscale-reachable server. So *live* server-config-over-web is gated on adding auth to the viewer.

---

## 3. Decisions (locked in brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Hybrid / phased.** Phase 1: client-connect UI (live, over `settings.json`) + a server-config **wizard that generates** the env/compose to apply at container creation. Phase 2: live server mutation, gated behind viewer auth. | Delivers the safe, high-value wins now; defers the risky part (server reads mutable config + web-UI key entry) behind the auth it requires. |
| D2 | **Saved connection profiles.** Named connections (e.g. "Local worker", "NAS (LAN)", "NAS (Tailscale)") you switch between; one active. Each stores runtime + url + key + project. | Matches Mark's reality: one NAS reached three ways (localhost on-box, `nas.lan` at home, tailnet remote), plus a pure-local mode. Switching is one click. |
| D3 | **Test-before-activate.** Activating a profile first probes `/healthz` (reachable) → validates the API key (auth) → confirms the project, and **fails loudly** if any step fails. | Directly kills the silent-fallback failure (11 days green-but-broken). This is the feature's highest-value behavior. |
| D4 | **Wizard generates, does not live-mutate (Phase 1).** The server-config wizard outputs the exact env vars + where to apply them; it does **not** store the key or touch the running server. | The viewer has no auth (§2) — keep the `ANTHROPIC_API_KEY` off the open web server until Phase 2's auth exists. |
| D5 | **Context-aware, one UI.** The Settings panel detects whether it runs on a *local worker* (→ Connection profiles) or the *server* (→ its generation config + wizard + real ingest status). One codebase, adapts. | Mark wants "the same UI local and on the server." |
| D6 | **Manager-over-existing-keys seam (no runtime change).** Profiles stored as a new `settings.json` structure; **activating a profile writes its values into the 4 canonical keys the hooks already read.** The runtime's config consumption is unchanged. | Smallest, safest seam — no change to how hooks/runtime resolve config; the UI is purely a profile manager on top. |

---

## 4. Architecture (Phase 1)

### 4.1 The connection-profiles seam (D6)

- New `settings.json` key: `CLAUDE_MEM_CONNECTIONS` — an array of `{ id, name, runtime: 'worker'|'server', url, apiKey, projectId }` — plus `CLAUDE_MEM_ACTIVE_CONNECTION` (the active id).
- **Activate(profile):** write the profile's `runtime`/`url`/`apiKey`/`projectId` into the canonical keys `CLAUDE_MEM_RUNTIME` / `CLAUDE_MEM_SERVER_URL` / `CLAUDE_MEM_SERVER_API_KEY` / `CLAUDE_MEM_SERVER_PROJECT_ID`. Hooks and the runtime keep reading those exactly as today — **zero change to config consumption.**
- Extend the `/api/settings` POST allow-list to permit the new keys + the canonical connection keys (they're currently absent — verified).
- The "Local worker" profile is `runtime: 'worker'` and simply clears the server keys on activate.

### 4.2 Test-before-activate (D3)

A new endpoint (e.g. `POST /api/connection/test`) takes a candidate profile and returns a structured result per step: **reachable** (`GET <url>/healthz`) → **authenticated** (a scoped read-only call with the key → 200 vs 401/403) → **project valid**. The UI blocks activation on any failure and shows *which* step failed (not a generic error) — so a wrong key reads as "auth failed," not "can't connect."

**Two target variants (verified in code — the probe MUST auto-detect them).** There are two connectable claude-mem server types with **divergent auth APIs**, and each 404s the other's endpoints:

| Target | Runtime routes | Auth (step 2) | Project (step 3) |
|---|---|---|---|
| **Collection server / server-beta** (the NAS) | `ServerV1PostgresRoutes` (Postgres) | `GET /v1/connect` (readAuth) — **no bare `/v1/projects`** | `GET /v1/projects/:id/jobs` (200 ok / 404 not-found) |
| **Local worker** | `ServerV1Routes` (SQLite) | `GET /v1/projects` (readAuth) — **no `/v1/connect`** | `GET /v1/projects/:id` (200 ok / 404 not-found) |

The auth step probes `/v1/connect` first; on **404** it falls back to `/v1/projects`. **If both 404**, the host answers `/healthz` but exposes neither claude-mem auth API → the result is **"No compatible claude-mem server at this URL"**, *not* a key error. A **404 must never be rendered as "the server rejected the API key."** The matched variant is carried into step 3 so the project check hits the right endpoint. Both variants accept `Authorization: Bearer <key>` and `x-api-key`. (History: the original draft assumed `/v1/projects` for "the server," which 404s on the Postgres server-beta and mislabeled the 404 as a bad key — fixed in PR #30.)

### 4.3 Server-config wizard (D4)

A guided form (shown in the server-context UI, and available read-only in the local UI as a helper) that collects provider + model + key-location and **emits**:
- The exact env vars: `CLAUDE_MEM_SERVER_PROVIDER`, `ANTHROPIC_API_KEY`, `CLAUDE_MEM_SERVER_MODEL` (default **explicitly** shown as `claude-haiku-4-5-20251001`, **not** the silent `claude-sonnet-4-6`).
- An **inline 3× cost warning** on the model picker (sonnet-4-6 = 3× haiku-4-5 per the measured figures).
- *Where* to apply them (TrueNAS custom-app config / compose) and the **"verify ingest for real, not `/healthz`"** step.
- It does **not** persist the key or call the running server (Phase 2).

### 4.4 Context detection (D5)

The panel asks the worker "am I a worker or a server?" (a small `/api/runtime-role` or reuse of existing runtime info) and renders the Connection section (worker) or the generation-config + wizard + ingest-status section (server).

---

## 5. Phasing

### Phase 1 — this design's target (Designer + Planner next)
- Connection profiles UI (list, add/edit/delete, activate) over the §4.1 seam.
- Test-before-activate (§4.2).
- Server-config wizard as a generator (§4.3).
- Context-aware rendering (§4.4).
- **No** live server mutation, **no** viewer auth, **no** API key stored on the server via web.

### Phase 2 — later, auth-gated
- Add authentication to the viewer HTTP server (it needs this regardless).
- Server reads generation config from a mutable store (settings/DB) instead of env-only.
- UI mutates server provider/model/key **live**, with hot-reload of the generation provider.

---

## 6. Components (Phase 1)

| Unit | Purpose |
|---|---|
| `ConnectionStore` | Read/write `CLAUDE_MEM_CONNECTIONS` + active id in `settings.json`; `activate()` writes canonical keys (§4.1). |
| `POST /api/connection/test` | The reachable → auth → project probe (§4.2). |
| `/api/settings` allow-list extension | Permit the new + canonical connection keys. |
| Connection panel (UI) | Profile list + editor + presets + Test button + active radio. |
| Server-config wizard (UI) | Provider/model form → env-var output + cost warning + apply/verify steps (§4.3). |
| Context role probe | `worker` vs `server` → which section renders (§4.4). |

**Boundaries:** `ConnectionStore` is the only writer of the connection keys; the UI never writes `settings.json` directly. The test endpoint is a pure probe (no persistence). The wizard is output-only (no persistence, no server calls).

---

## 7. Security

- Client `SERVER_API_KEY` lives in `settings.json` (same as today; file-permission hardening is queue #23 — the `0600` chmod is a no-op on Windows).
- The wizard **keeps `ANTHROPIC_API_KEY` off the web server** by design (D4) — it emits config for the operator to apply out-of-band.
- The local-worker viewer editing a client key is a localhost concern (lower risk); the **server** viewer over LAN/Tailscale is the real exposure — which is why live server-config + any key entry there is **Phase 2, behind auth**.
- The Test endpoint must not echo the key back in responses/logs (write-only, like the existing settings keys).

---

## 8. Risks & open questions

| # | Risk / question | Disposition |
|---|---|---|
| R1 | Wizard output format may not match how Mark applies config to the TrueNAS app. | **Proposed:** env-var list + copy-paste + TrueNAS-apply steps. Designer confirms with Mark; could add a compose fragment. |
| R2 | Context auto-detection (worker vs server) picking wrong could show the wrong controls. | Detect from the worker's own runtime role (authoritative), not a guess; fall back to a manual toggle if ambiguous. |
| R3 | The Test endpoint itself calls out to a URL from the (unauthenticated) worker — SSRF-shaped surface. | Scope it to the connection-test purpose; it's localhost-initiated in Phase 1. Revisit with Phase 2 auth. |
| R4 | Storing multiple API keys (one per profile) widens the at-rest key surface in `settings.json`. | Accepted; same class as today's single key. Tracked with #23 (perms). |
| Q1 | Should "Local worker" always exist as an undeletable default profile? | Proposed yes (it's the safe fallback). Designer's call on presentation. |

---

## 9. Out of scope (YAGNI / Phase 2)

- No viewer authentication (Phase 2).
- No live mutation of the running server's generation config (Phase 2).
- No `ANTHROPIC_API_KEY` entry/storage on the server web UI (Phase 2).
- No auto-detect/probe of best address (rejected in brainstorm — profiles are explicit).
- No server reading generation config from `settings.json`/DB (Phase 2).

---

*Terminal state of this brainstorm: hand Phase 1 to **Designer** (UX handoff for the Connection panel + wizard — layout, copy, states, the test-result presentation) and **Planner** (`superpowers:writing-plans` for the `ConnectionStore` seam, the test endpoint, and the allow-list extension). Phase 2 gets its own spec, gated on viewer auth.*
