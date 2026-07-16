# Setup — claude-mem server app on `nas.lan`

**Audience:** whoever is standing up, re-configuring, or debugging the claude-mem server stack on the NAS, and anyone pointing a client at it.
**Status:** current as of 2026-07-15. **Fork-only** — this is pilot infrastructure, not an upstream feature.
**Scope:** prerequisites → deploy → configure → mint keys → point a client → verify ingest → troubleshoot.

> **Read this first.** The stack has been "green" while capturing **nothing** for 11 days. Every health probe
> returned 200 the whole time. The three things that make or break a working install are in
> [§4 Configure](#4-configure-the-stack), [§5 Mint keys](#5-mint-api-keys), and [§6 Point a client](#6-point-a-client-at-the-server) —
> and the only step that proves any of it worked is [§7 Verify ingest for real](#7-verify-ingest-for-real).
> **Do not treat a 200 from `/healthz` as evidence of anything.** See [§8 Troubleshooting](#8-troubleshooting).

---

## 1. What this stack is

The NAS runs claude-mem's **server runtime**: clients (Claude Code hooks) POST session events over HTTP instead of
writing to a local SQLite worker. A generation worker turns those events into observations via a provider API call.

| Item | Value |
|---|---|
| Host | `nas.lan` = **`192.168.86.47`**, TrueNAS SCALE |
| Deployed as | TrueNAS **custom app** named `claude-mem` |
| Services | `postgres` + `valkey` + `chroma` + `claude-mem-server` + `claude-mem-worker` |
| LAN endpoint | `http://192.168.86.47:37877` |
| Tailnet endpoint | `http://truenas-scale.taila02f52.ts.net:37877` (tailnet IP `100.76.112.66`) |
| SSH user | **`claude`** (uid 3010, passwordless sudo). Docker commands need `sudo`. |

> ⚠️ **`nas.lan` does not resolve on every machine on the LAN** — notably not on Mark's. **Use the IP `192.168.86.47`**,
> or add a hosts entry (`192.168.86.47  nas.lan`). This has cost debugging time more than once. Every command below
> uses the IP deliberately.

> ⚠️ **`appserver.lan` (`192.168.86.167`) is a DIFFERENT box** — that is Mark's local Chroma, unrelated to this stack
> and not part of it. Do not conflate the two. The NAS runs its own `chroma` service *inside* the app.

**Split-brain by design:** `claude-mem-server` serves HTTP and has generation **disabled**
(`CLAUDE_MEM_GENERATION_DISABLED: "true"`, `docker-compose.yml`) — *"The HTTP service does not consume BullMQ jobs;
the worker container does."* `claude-mem-worker` runs generation and **has no HTTP surface at all**. Internalize this:
it is why server health tells you nothing about generation ([§8.1](#81-health-checks-lie)).

**History / prior art** — read these for what was actually done, in order:
- [`2026-07-03-nas-tailscale-pilot-runbook.md`](./2026-07-03-nas-tailscale-pilot-runbook.md) — the deploy itself, Tailscale, Phase 2/4.
- [`2026-07-04-teammate-onboarding.md`](./2026-07-04-teammate-onboarding.md) — day-1 teammate flow. **Its client config section is
  incomplete — see [§6](#6-point-a-client-at-the-server); prefer this document.**
- [`2026-07-06-tailscale-acl-and-rename-runbook.md`](./2026-07-06-tailscale-acl-and-rename-runbook.md) — tailnet ACL lockdown.
- [`2026-07-06-pihole-nas-runbook.md`](./2026-07-06-pihole-nas-runbook.md) — unrelated PiHole app on the same NAS (context only).
- Generic server reference (upstream, not NAS-specific): [`docs/server.md`](../server.md).

---

## 2. Prerequisites

**On the NAS:**
1. TrueNAS SCALE with the Docker-based Apps backend (24.10 "Electric Eel" or later). The pilot deliberately did **not**
   install anything on the TrueNAS host OS — the managed base wipes host changes on update.
2. SSH access as `claude` with sudo (key auth; the pilot uses a dedicated ed25519 key).
3. Free space on the app pool for the Postgres/Chroma volumes.

**On your machine:**
4. Network reach to `192.168.86.47:37877` — LAN, or the tailnet if remote.
5. Tailscale joined to `taila02f52.ts.net` and approved, **if remote**. Teammates are restricted by ACL to `:37877` only.
6. claude-mem plugin installed.

**Secrets you will need** (never commit these; all shown as placeholders throughout):
- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — generated on-NAS, no defaults; the stack refuses to start without them.
- `CHROMA_API_KEY` — required whenever Chroma is enabled (the default).
- `ANTHROPIC_API_KEY` — **required for generation to run at all.** See [§4.2](#42-set-anthropic_api_key-on-the-worker).

---

## 3. Deploy

> **Honest gap — read before following.** The NAS app was created as a TrueNAS **custom app** whose compose was authored
> **on the NAS**, with DB secrets generated on-box so they never entered a transcript. **That deployed compose is not in
> this repo**, and the image is a locally-built `claude-mem-server:pilot` (`pull_policy: missing`). The repo's
> [`docker-compose.yml`](../../docker-compose.yml) is the **reference** for service topology and env contract — it is not
> a byte-for-byte copy of what runs on the NAS. **The stack is already deployed.** Treat this section as
> "how it was stood up / how to re-create it", and **verify the live app's actual compose on the box** before changing it:
>
> ```bash
> ssh claude@192.168.86.47
> sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'   # discover real container names
> ```
>
> Container names follow TrueNAS's `ix-<app>-<service>-1` convention — the server is
> `ix-claude-mem-claude-mem-server-1` (**verified**, used throughout the runbooks). Other services' exact names are
> **inferred from that pattern, not verified** — read them off `docker ps` rather than trusting this doc.

For a **fresh** stand-up, follow the pilot runbook's Steps 3–5
([`2026-07-03-nas-tailscale-pilot-runbook.md`](./2026-07-03-nas-tailscale-pilot-runbook.md)), which records what was
actually done: detect the SCALE version/backend, install the Tailscale app, then create the custom app from a compose
modeled on the repo's `docker-compose.yml`.

**Two deploy facts that have already bitten this pilot — do not skip:**

1. **Regenerate the server bundle before deploying.** A source-only merge leaves `plugin/scripts/server-service.cjs`
   stale and ships the wrong schema version. This has happened: the pilot once shipped at schema v1 after a merge
   reverted the bundle rebuild. ADR 0002 §4.1 makes this a **gate, not a chore** — it cites
   [`2026-07-03-nas-tailscale-pilot-runbook.md:49`](./2026-07-03-nas-tailscale-pilot-runbook.md) as the precedent and calls it
   *"the single most likely way to ship a broken pilot."*
2. **Take a Postgres volume snapshot before any redeploy.** Required by ADR 0002 §7.2. The pilot carries real (if
   sparse) rows and an in-place schema migration history (v1 → v2 → v3).

**Tailscale:** use a **pre-auth key**, not the interactive login flow. The interactive flow **does not work here** — the
container's health check restarted it 29× before any login URL could be clicked, minting a fresh URL each cycle. The
pre-auth key brought the node online immediately and restarts went `29 → 0`.

---

## 4. Configure the stack

This is where installs silently break. Three settings decide whether you get a working, affordable install.

### 4.1 Set `CLAUDE_MEM_SERVER_MODEL` — or silently pay 3×

**The variable is `CLAUDE_MEM_SERVER_MODEL`.** Set it on **`claude-mem-worker`** (the container that generates).

- ❌ **`CLAUDE_MEM_MODEL` does nothing on the server.** It is the *local worker's* settings key
  (`SettingsDefaultsManager.ts:104`). Setting it here is a no-op with no warning.
- ❌ **The server runtime never reads `settings.json`.** There is no settings tier server-side: it is
  **env var → code default**, full stop. Do not expect a settings file to influence it.
- ⚠️ **Unset, the code default is `claude-sonnet-4-6`** (`DEFAULT_SERVER_CLAUDE_MODEL`,
  `src/server/generation/providers/ClaudeObservationProvider.ts:22`), read at
  `src/server/runtime/create-server-service.ts:261`.

> ### 💰 Cost implication — state this plainly
>
> | Model | Input / output per 1M tokens | Notes |
> |---|---|---|
> | `claude-sonnet-4-6` | **$3 / $15** | **the silent default if you set nothing** |
> | `claude-haiku-4-5-20251001` | **$1 / $5** | what Mark's local worker uses |
>
> **Leaving `CLAUDE_MEM_SERVER_MODEL` unset costs 3× per token, silently, forever.** Nothing warns you. The repo's
> `docker-compose.yml` does **not** set it, so a stack deployed from the reference compose gets the Sonnet default.
> Compose's own header also warns this path *"bills per token and can be EXPENSIVE at high observation volume."*
>
> **Set it explicitly, even if you want Sonnet** — an explicit value is a decision; an absent one is an accident.

```yaml
# on the claude-mem-worker service:
CLAUDE_MEM_SERVER_MODEL: claude-haiku-4-5-20251001
```

### 4.2 Set `ANTHROPIC_API_KEY` on the worker

**Without it, generation never runs — and the worker enters an infinite restart loop.**

```yaml
# on the claude-mem-worker service:
ANTHROPIC_API_KEY: <your-anthropic-api-key>   # placeholder — never commit a real key
```

Why it matters, precisely:
- Compose declares `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` — an **empty-string default, not unset**.
- Empty key → `create-server-service.ts:258-259` returns null → no provider → `DisabledServerGenerationWorkerManager`.
- Generation disabled → the worker process **exits 0** → compose `restart: unless-stopped` restarts it → **forever**.
  Measured on this pilot: **~2,817 restarts/day, ~30,000 total, ~200ms per lifetime, ExitCode 0, zero errors logged.**
  Tracked as **queue #11**.

> ⚠️ **`CLAUDE_MEM_ANTHROPIC_API_KEY` does not work under compose.** `create-server-service.ts:258` uses `??` (nullish
> coalescing), and compose always defines `ANTHROPIC_API_KEY` as at least `""`. An empty string **is not nullish**, so
> the chain short-circuits and the `CLAUDE_MEM_ANTHROPIC_API_KEY` fallback is **unreachable** — contradicting compose's
> own comment. Setting only that variable silently does nothing. **Same defect on the `gemini` branch** (`:266`).
> Tracked as **queue #14**. **Use `ANTHROPIC_API_KEY`.**

**Sequencing (important):** setting this fixes the crash loop but fixes **zero** of the "nothing is captured" symptom —
ingest is dead *upstream* of generation, so an enabled provider sits idle on an empty queue. Fix ingest
([§6](#6-point-a-client-at-the-server)) first. Also note: pre-existing Postgres rows would need a one-time Chroma
backfill, which **is not built**.

### 4.3 Leave the server's generation flag alone

`CLAUDE_MEM_GENERATION_DISABLED: "true"` on `claude-mem-server` is **correct and intentional**. It is not the bug. The
worker generates; the server does not. Do not "fix" this.

---

## 5. Mint API keys

Run on the NAS. **Every key below is a placeholder — never paste a real key into a doc, ticket, or transcript.**

```bash
ssh claude@192.168.86.47

# Contributor (read + write) — what an actual teammate needs:
sudo docker exec ix-claude-mem-claude-mem-server-1 \
  bun /opt/claude-mem/scripts/server-service.cjs \
  server api-key create --name <teammate> --actor <teammate> --scope memories:read,memories:write

# Consume-only (read):
#   --scope memories:read
```

The command prints JSON containing **`key`**, **`projectId`**, `teamId`, `scopes`, and `actorId`
(`ServerService.ts:546-554`). **Keep `key` and `projectId`** — you need both in [§6](#6-point-a-client-at-the-server).
`projectId` is not printed anywhere else convenient; capture it now.

**Two traps:**

1. ⚠️ **`--scope` defaults to `memories:read`.** Omit the flag and you mint a **read-only** key
   (`ServerService.ts:519`). A contributor holding one gets **403 on every write** — writes require `memories:write`
   (`ServerV1Routes.ts:70`, `ServerV1PostgresRoutes.ts:178`). **The existing teammate key on the box
   (`/mnt/datapool/apps/claude-mem-pilot/teammate-readonly.key`) is read-only** — do not hand it to a contributor and
   expect writes to work.
2. ⚠️ **Always pass `--actor <name>`.** It gives each person a distinct author identity (Phase 1 attribution).
   Without it, `actor_id` is not per-teammate and attribution collapses.

Audit existing keys (metadata only, no secrets): `... server api-key list --active`.

---

## 6. Point a client at the server

**This is the step that failed for 11 days. Get it exactly right.**

### The four keys — all of them, in `settings.json`, not env vars

Edit **`~/.claude-mem/settings.json`** on the *client* machine:

```jsonc
{
  "CLAUDE_MEM_RUNTIME": "server",
  "CLAUDE_MEM_SERVER_URL": "http://192.168.86.47:37877",
  "CLAUDE_MEM_SERVER_API_KEY": "<key from §5>",
  "CLAUDE_MEM_SERVER_PROJECT_ID": "<projectId from §5>"
}
```

> Remote/tailnet clients use `http://truenas-scale.taila02f52.ts.net:37877` instead.
> Restrict the file: it holds a live key (the installer writes it `0600`).

**Miss any one of the four → silent fallback to local worker mode.** The client keeps working, captures to its own
local SQLite, and reports nothing wrong. That is the failure, and it is not loud.

- ❗ **These are `settings.json` keys, NOT environment variables.** `selectRuntime()` reads
  `loadFromFileOnce()` → `~/.claude-mem/settings.json` (`runtime-selector.ts:39-46`). **Exporting them in your shell
  proves nothing and does nothing.** The teammate-onboarding runbook's *"settings.json or env"* is **wrong** — prefer
  this document.
- ❗ **There are FOUR keys.** The onboarding runbook lists **three** — it **omits `CLAUDE_MEM_SERVER_PROJECT_ID`**,
  which `buildServerContext()` requires (`runtime-selector.ts:48-86`; the `projectId` guard is at `:83-86`). A client following that doc lands in exactly the
  silent-fallback state. The canonical set is enumerated in-source at
  `src/npx-cli/commands/server-runtime-setup.ts:22-30`.
- Legacy `CLAUDE_MEM_SERVER_BETA_*` names are still accepted as fallbacks; `CLAUDE_MEM_RUNTIME` accepts the legacy
  value `server-beta` as well as `server`.

### ⚠️ The installer cannot finish this job on a client machine

Do not assume `npx claude-mem install --runtime server --server-url ...` configures a teammate. It does **not**:

1. It sets **only** `CLAUDE_MEM_RUNTIME` + `CLAUDE_MEM_SERVER_URL` (`install.ts:880`) — 2 of the 4 keys.
2. It then tries to bootstrap a key, which **requires `CLAUDE_MEM_SERVER_DATABASE_URL`** — i.e. **direct Postgres
   access**. A teammate's machine does not have that (Postgres lives on the NAS and is not exposed).
3. So `maybeBootstrapServerApiKey()` **skips**, logging: *"Hooks will fall back to the worker until you run
   `npx claude-mem server keys rotate`"* (`install.ts:902-908`).

Result: `API_KEY` and `PROJECT_ID` are never written, and the client silently runs in worker mode. **Set the four keys
by hand as above.** (The installer's bootstrap path is for a machine co-located with Postgres — not the teammate case.)

---

## 7. Verify ingest for real

**A 200 from `/healthz` is not verification.** It is a hardcoded string ([§8.1](#81-health-checks-lie)). The pilot
probed 200/200/200 for 11 days while `agent_events` sat at **0**.

**Verify that rows actually arrive.** This is the only step that proves the install works.

### 7.1 Baseline the event count (on the NAS)

```bash
ssh claude@192.168.86.47
sudo docker ps --format '{{.Names}}'          # find the real postgres container name

sudo docker exec <postgres-container> \
  psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "SELECT count(*) FROM agent_events;"
```

> **Verify on the box:** the exact postgres container name and the `POSTGRES_USER`/`POSTGRES_DB` values were generated
> on-NAS and are **not** in this repo. Read the container name off `docker ps` and the credentials off the app's
> configuration. Do not guess. (If the query errors with *relation does not exist*, check the schema/`search_path`
> before concluding the table is missing.)

### 7.2 Drive a real client session

On the client configured in [§6](#6-point-a-client-at-the-server), run an actual Claude Code session that does some
tool work. This is the part that cannot be faked by a curl — the hooks must route to the server.

### 7.3 Confirm the count moved

Re-run the count from [§7.1](#71-baseline-the-event-count-on-the-nas). **`agent_events` must be strictly greater than
your baseline.** If it did not move, the client never reached the server → go to [§8.2](#82-silent-runtime-fallback--everything-is-green-but-nothing-is-captured).
**Do not proceed on a green health check.**

### 7.4 Confirm an observation actually lands

Ingest working ≠ generation working. These are independent; verify both.

```sql
-- jobs enqueued by ingest:
SELECT count(*) FROM observation_generation_jobs;

-- generated (not hand-written) observations:
SELECT count(*) FROM observations WHERE created_by_job_id IS NOT NULL;
```

A generated observation has `created_by_job_id` **NOT NULL**. Rows with `kind='manual'` and
`created_by_job_id IS NULL` are **not evidence** — the only two observations on the pilot are exactly that, written by
since-revoked E2E test keys.

- Events climbing, jobs **0** → ingest works, enqueue path is broken.
- Jobs climbing, generated observations **0** → generation is off → [§4.2](#42-set-anthropic_api_key-on-the-worker) (and check the worker's restart count).

### 7.5 Sanity signals (necessary, not sufficient)

```bash
curl http://192.168.86.47:37877/healthz     # liveness of the HTTP process ONLY
```

`/v1/info` exposes `boundaries.generationWorkerManager` — but on `claude-mem-server` it reports generation **`disabled`
always, in a perfectly healthy stack**, because that container is *supposed* to have generation off ([§4.3](#43-leave-the-servers-generation-flag-alone)).
**Do not read that as a fault, and do not wire it into a healthcheck** — it would alarm permanently. See **queue #12**.

---

## 8. Troubleshooting

### 8.1 Health checks lie

**Say it plainly: green health tells you nothing about capture.**

- `/healthz` returns a **hardcoded** `{"status":"ok","runtime":...}` (`ServerService.ts:57-59`). It never consults the
  generation boundary, the queue, or the database. It is a liveness probe for the HTTP process and nothing more.
- **`claude-mem-worker` has no compose `healthcheck:` at all** — the **only** long-running service without one
  (postgres, valkey, chroma, and claude-mem-server all have one). That omission — not `/healthz` — is why ~30,000
  worker restarts looked healthy.
- The worker has **no HTTP surface**, so no server endpoint can ever report its liveness. This is structural.

**Therefore:** verify with [§7](#7-verify-ingest-for-real), always. Queue **#11** (worker healthcheck) and **#12**
(probe blindness) track the fix.

### 8.2 Silent runtime fallback — "everything is green but nothing is captured"

**The #1 failure.** The client is writing to its own local SQLite and never contacting the NAS.

Diagnose in this order — it is two cheap steps:

1. **Read the client's `~/.claude-mem/settings.json` for `CLAUDE_MEM_RUNTIME`.** Absent, or not `server`/`server-beta`?
   **That is the truly silent path** — `resolveRuntimeContext()` returns `{runtime:'worker'}` with **no log
   whatsoever** (`runtime-selector.ts:101-103`). No warning will ever exist. This matches the pilot's evidence.
2. **If it *is* `server`,** grep the **client-side** hook logs for `[server-fallback] reason=` — these paths *are*
   loud and name the exact missing key: `reason=missing_base_url` / `missing_api_key` / `missing_project_id`
   (`runtime-selector.ts:76,80,84`).

> The "zero WARN/ERROR in 11 days" evidence is from the **NAS**. A `[server-fallback]` warning appears on the
> **client**. NAS logs cannot rule this out — look on the client.

Fix: set all four keys ([§6](#6-point-a-client-at-the-server)). Tracked as **queue #13**, which also owns correcting
the pilot runbook's *"functionally complete"* claim — that was validated by **E2E test writes, not an actual teammate**.

### 8.3 Worker crash-loop (exits 0, restarts forever)

**Symptom:** enormous restart count, ExitCode **0**, ~200ms lifetimes, **zero errors in the logs**, server health green.

```bash
sudo docker ps -a --format '{{.Names}}\t{{.Status}}'   # look for a churning worker
sudo docker inspect <worker-container> --format '{{.RestartCount}} {{.State.ExitCode}}'
```

**Cause:** no provider key → generation disabled → nothing holds the event loop open → Node exits 0 → `restart:
unless-stopped` → repeat. **Fix:** [§4.2](#42-set-anthropic_api_key-on-the-worker). Tracked as **queue #11**.

> Note the code comment at `ServerService.ts:869-870` — *"Block forever … Without this the process would exit"* — is
> **factually wrong** about the `await new Promise<void>(() => {})` at `:871`: an unsettled Promise is not a libuv
> handle and holds nothing open. Don't be misled by it while debugging. Queue #11 covers correcting it.

### 8.4 Wrong model / unexpectedly large bill

Generation works but costs 3× expected → `CLAUDE_MEM_SERVER_MODEL` is unset and you are on the `claude-sonnet-4-6`
default. If you set `CLAUDE_MEM_MODEL`, **that did nothing** — wrong variable, no warning.
See [§4.1](#41-set-claude_mem_server_model--or-silently-pay-3).

### 8.5 403 on write

The key is **read-only**. `--scope` defaults to `memories:read`, and the pre-existing
`teammate-readonly.key` is read-only. Mint a new key with `--scope memories:read,memories:write` and `--actor`
([§5](#5-mint-api-keys)), or migrate the existing key's scopes (`server api-key migrate-scopes <id> --scope ...`).
Reads succeeding while writes 403 is the tell.

### 8.6 `nas.lan` does not resolve

Expected on some machines, including Mark's. **Use `192.168.86.47`**, or add `192.168.86.47  nas.lan` to your hosts
file. If you are remote, you want the tailnet name instead:
`http://truenas-scale.taila02f52.ts.net:37877`.

> MagicDNS uses the host name **`truenas-scale`**, not the configured `claude-mem-nas` — cosmetic, but it means the
> obvious name does not resolve. A rename to `claude-mem-nas` is proposed in the ACL runbook; **verify in the Tailscale
> admin console whether it was ever applied** before assuming either name works.

### 8.7 Remote teammate can reach nothing / can reach too much

Teammate access is governed by a **Tailscale ACL** restricting `group:cmem-teammates` to `claude-mem:37877` only.
`host_network: true` means the NAS's **entire host** is otherwise exposed to the tailnet — the ACL is what restricts it.

> ⚠️ **Nothing in this repo can prove the ACL was ever applied** — every step is in the Tailscale admin console.
> **Verify there.** Do not assume it is in force; other "complete" pilot claims turned out to be unsubstantiated.
> Tracked as **queue #16**.

---

## 9. Known issues — cross-reference

Live detail lives in [`docs/BUILDER_QUEUE.md`](../BUILDER_QUEUE.md); it is not duplicated here.

| Row | Issue | Where it bites |
|---|---|---|
| **#11** | Worker exits 0 into an infinite restart loop; missing worker `healthcheck:` | [§4.2](#42-set-anthropic_api_key-on-the-worker), [§8.3](#83-worker-crash-loop-exits-0-restarts-forever) |
| **#12** | No deploy-facing probe can observe whether generation is running | [§7.5](#75-sanity-signals-necessary-not-sufficient), [§8.1](#81-health-checks-lie) |
| **#13** | Pilot has never ingested anything; silent runtime fallback | [§6](#6-point-a-client-at-the-server), [§8.2](#82-silent-runtime-fallback--everything-is-green-but-nothing-is-captured) |
| **#14** | Empty `ANTHROPIC_API_KEY`; `CLAUDE_MEM_ANTHROPIC_API_KEY` unreachable under compose | [§4.2](#42-set-anthropic_api_key-on-the-worker) |
| **#15** | These runbooks existed only on an unmerged branch | landed alongside this document |
| **#16** | `host_network: true` — confirm the ACL was actually applied | [§8.7](#87-remote-teammate-can-reach-nothing--can-reach-too-much) |
| **#17** | Windows: orphaned `:37777` socket blocks the **local** worker | Client-side, worker mode only — not this stack, but it will stop a Windows client from capturing anything at all |

---

## 10. Current pilot state (2026-07-15)

So nobody re-derives this: the box is **deployed and healthy but has never captured anything**.

- `agent_events` = **0**, `observation_generation_jobs` = **0**, `server_sessions` = **0**, `usage_events` = **0**.
- The only 2 `observations` are `kind=manual`, written by since-revoked E2E test keys on Jul 3.
- `audit_log`'s last entry is **2026-07-04**. All 12 API keys are test artifacts.
- Valkey holds only BullMQ `:meta` keys — no `wait`/`active`/`failed`.
- **No client has ever successfully written to that box.**

A working install therefore means finishing [§4](#4-configure-the-stack) → [§6](#6-point-a-client-at-the-server) and
proving it with [§7](#7-verify-ingest-for-real). **The pilot runbook's "functionally complete" claim is
unsubstantiated** — it was validated by E2E test writes, not by a real teammate. Correcting it belongs to **queue #13**;
this document does not restate it as fact.

---

## Appendix — unverified in this document

Everything below was **not** verified while writing this, and is flagged rather than fabricated. **Check on the box
before relying on any of it.**

1. **Container names other than `ix-claude-mem-claude-mem-server-1`** — inferred from TrueNAS's `ix-<app>-<service>-1`
   pattern. Read them off `sudo docker ps` ([§3](#3-deploy), [§7.1](#71-baseline-the-event-count-on-the-nas)).
2. **The NAS app's actual compose** — authored on-NAS, not in this repo; the repo's `docker-compose.yml` is a reference,
   not a mirror. Env-var *names* and defaults cited here come from the repo file and are accurate **for that file**;
   confirm the deployed app sets them the same way ([§3](#3-deploy)).
3. **`POSTGRES_USER` / `POSTGRES_DB` values** — generated on-NAS, deliberately never transcribed ([§7.1](#71-baseline-the-event-count-on-the-nas)).
4. **Whether the Tailscale ACL and the node rename were ever applied** — console-only actions, unprovable from the repo
   ([§8.6](#86-naslan-does-not-resolve), [§8.7](#87-remote-teammate-can-reach-nothing--can-reach-too-much)); queue #16.
5. **Whether the `observations`/`agent_events` tables live in `public`** — the [§7](#7-verify-ingest-for-real) queries
   assume the default `search_path`. Table *names* are verified from the live box; the schema is not.
6. **The exact `bun /opt/claude-mem/scripts/server-service.cjs` path inside the container** — taken verbatim from the
   teammate-onboarding runbook, where it is recorded as actually run. Note the repo's compose header refers to
   `server-beta-service.cjs`; this naming drift is unreconciled. If the [§5](#5-mint-api-keys) command errors, check the
   real path in the container.
7. **No step in this document was executed.** It is assembled from the runbooks (what was actually done), verified
   in-repo source citations, and read-only findings recorded in the queue. Nothing was run against the NAS.
</content>
