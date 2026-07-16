# Setup — claude-mem server app on `nas.lan`

**Audience:** whoever is configuring, repairing, or debugging the claude-mem server stack on the NAS, and anyone pointing a client at it.
**Status:** current as of 2026-07-15. **Fork-only** — this is pilot infrastructure, not an upstream feature.
**Scope:** prerequisites → deploy → configure → mint keys → point a client → verify ingest → troubleshoot.

### Start here — what this document is, and is not

> **The stack is already deployed on the NAS.** It is running right now, and every health probe has returned 200 for
> 11 days — while capturing **nothing**. So the job in front of you is almost certainly **configure + verify**, not
> deploy.
>
> - **You are configuring/repairing the existing app** → this document is self-contained. Go to
>   [§4](#4-configure-the-stack) → [§6](#6-point-a-client-at-the-server) → [§7](#7-verify-ingest-for-real).
> - **You are standing up a brand-new stack from scratch** → this document is **not sufficient on its own**.
>   [§3](#3-deploy) hands you to the pilot runbook for the TrueNAS app-creation steps, which are not reproduced here.
>   Read [§3](#3-deploy)'s gap notice before you start.
>
> **Execution order — the section numbers are not the running order.** Generation is downstream of ingest, and ingest
> is what is broken, so:
>
> **[§4.0](#40-how-to-apply-a-config-change-do-this-first--the-rest-of-4-assumes-it) → [§5](#5-mint-api-keys) → [§6](#6-point-a-client-at-the-server) → [§7.1–7.3](#7-verify-ingest-for-real) (prove ingest) → [§4.1–4.2](#41-set-claude_mem_server_model--or-silently-pay-3) (model + generation) → [§7.4](#74-confirm-an-observation-actually-lands) (prove generation).**
>
> Doing §4.2 first is not wrong, just useless on its own: an enabled provider sits idle on an empty queue until a
> client actually reaches the box.
>
> **Two config surfaces — do not cross the streams:**
>
> | Side | Where config lives | Set via |
> |---|---|---|
> | **Server** (the NAS app) | **environment variables** in the app's compose | [§4](#4-configure-the-stack) — env only; the server **never** reads `settings.json` |
> | **Client** (a teammate's machine) | **`~/.claude-mem/settings.json`** | [§6](#6-point-a-client-at-the-server) — settings file only; **env vars do nothing** |
>
> **Do not treat a 200 from `/healthz` as evidence of anything.** See [§8.1](#81-health-checks-lie).

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
2. **SSH access as `claude` with sudo.** Key auth only — **password auth is not available** (the pilot host has no
   `sshpass` path and was set up key-only), so you cannot get in without an authorized key.
   - **Getting access:** generate a keypair (`ssh-keygen -t ed25519`) and have **Mark authorize your public key** —
     TrueNAS → Credentials → Local Users → the `claude` user → **Authorized Keys**. That user must have a real shell
     (bash/zsh, not nologin) and sudo. Access is revoked by removing the line.
   - The pilot's own dedicated key is `~/.ssh/claude_nas_pilot_ed25519` **on Mark's machine** — it is not shared, and
     it is not in this repo. If you are not Mark, you need your own key authorized.
   - Test before going further: `ssh claude@192.168.86.47 'sudo docker ps'` should list containers without prompting
     for a password.
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

**Two facts that have already bitten this pilot.** Both apply to **redeploys** — building/shipping a new image. If you
are only changing env vars on the existing app ([§4](#4-configure-the-stack)), #1 does not apply to you; **#2's snapshot
gate may still** — see the snapshot notice in [§4.0](#40-how-to-apply-a-config-change-do-this-first--the-rest-of-4-assumes-it).

1. **Regenerate the server bundle before deploying.** A source-only merge leaves `plugin/scripts/server-service.cjs`
   stale and ships the wrong schema version. This has happened: the pilot once shipped at schema v1 after a merge
   reverted the bundle rebuild. [ADR 0002](../architecture/decisions/2026-07-14-upstream-v13.11.0-fork-merge.md) §4.1
   makes this a **gate, not a chore** — it cites
   [`2026-07-03-nas-tailscale-pilot-runbook.md:49`](./2026-07-03-nas-tailscale-pilot-runbook.md) as the precedent and calls it
   *"the single most likely way to ship a broken pilot."*

   ```bash
   npm run build     # regenerates plugin/scripts/*.cjs, incl. server-service.cjs
   ```

   The image `COPY plugin/ /opt/claude-mem/` (`docker/claude-mem/Dockerfile:41`), so the bundle must be rebuilt
   **before** the image is built — otherwise the image carries a stale bundle. Use `npm run build`, **not**
   `build-and-sync`: the latter also restarts your *local* worker, which has nothing to do with the NAS.
2. **Take a Postgres volume snapshot before any redeploy.** Required by
   [ADR 0002](../architecture/decisions/2026-07-14-upstream-v13.11.0-fork-merge.md) §7.2. The pilot carries real (if
   sparse) rows and an in-place schema migration history (v1 → v2 → v3).
   > **Verify on the box:** the exact dataset path and snapshot command are **not recorded anywhere in this repo**.
   > Take it via TrueNAS (Storage → Snapshots) or `zfs snapshot <pool>/<dataset>@<name>` against the app's Postgres
   > dataset — **identify the real dataset on the NAS first.** Do not guess a path from this document.

**Tailscale:** use a **pre-auth key**, not the interactive login flow. The interactive flow **does not work here** — the
container's health check restarted it 29× before any login URL could be clicked, minting a fresh URL each cycle. The
pre-auth key brought the node online immediately and restarts went `29 → 0`.

---

## 4. Configure the stack

This is where installs silently break. Three settings decide whether you get a working, affordable install.

> ⚠️ **If you jumped straight to this section: the subsections are not in running order.** Do
> **[§4.0](#40-how-to-apply-a-config-change-do-this-first--the-rest-of-4-assumes-it) first**, then go to
> [§5](#5-mint-api-keys) → [§6](#6-point-a-client-at-the-server) → [§7.1–7.3](#7-verify-ingest-for-real) and **come back
> for §4.1–4.2**. Generation (§4.1/§4.2) is downstream of ingest (§6): configuring it before a client can reach the box
> leaves an enabled provider idle on an empty queue, proving nothing. Full order in
> [Start here](#start-here--what-this-document-is-and-is-not).

### 4.0 How to apply a config change (do this first — the rest of §4 assumes it)

Every §4 change is an **environment variable on a service in the `claude-mem` custom app's compose**. The YAML snippets
below are fragments to merge into the relevant service's `environment:` block — they are not standalone files.

The app is a **TrueNAS custom app**, so its compose is edited through TrueNAS, not through this repo:

> **TrueNAS UI:** Apps → **`claude-mem`** → **Edit** → the custom-app YAML → apply the change → **Update/Save**.
> TrueNAS redeploys the affected containers. **The Edit view is also how you *read* the current YAML** — there is no
> repo-verifiable CLI command to dump it (`docker inspect` shows the *already-applied* env of a running container, not
> the compose source; see the check below).

> ⚠️ **Verify this path on the box before relying on it.** The exact UI wording varies by SCALE version, and **this
> step was not executed while writing this document**. What *is* recorded: the pilot changed live app config
> programmatically via **`app.update`** (that is how the Tailscale `auth_key` was set — see the pilot runbook), so a
> `midclt`-based route exists if the UI is awkward. **This document deliberately does not print a `midclt` command
> line** — the exact signature was not verified, and a fabricated one here would be worse than none. Discover it on the
> box (TrueNAS API docs / `midclt call core.get_methods`) or use the UI. **Editing the repo's `docker-compose.yml` does
> nothing to the NAS** — that file is a reference, not the deployed artifact ([§3](#3-deploy)).

> 🛑 **Snapshot gate — resolve this before your first change.** Any §4 change redeploys containers, and
> [§3](#3-deploy) carries [ADR 0002](../architecture/decisions/2026-07-14-upstream-v13.11.0-fork-merge.md) §7.2's
> requirement to snapshot the Postgres volume **before any redeploy** — while admitting the dataset path is recorded
> nowhere in this repo. **These two facts collide on exactly the path you are about to take, and this document cannot
> resolve it for you.** The gate is written for redeploys carrying a new image/schema; whether it binds an env-only
> change that merely restarts a container **is not something this document can answer from the repo** — do not assume
> either way. **Confirm the intent with Mark (or read ADR 0002 §7.2 yourself) before the first §4 change.** The pilot's
> data is sparse but real, and this is the irreversible one.

**After any change, confirm it actually landed in the container** — do not assume the redeploy took:

```bash
sudo docker inspect <worker-container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'CLAUDE_MEM_SERVER_MODEL|CLAUDE_MEM_SERVER_PROVIDER|ANTHROPIC_API_KEY'
```

(That prints the key's *presence*; it also prints its value — run it where nobody is looking over your shoulder, and
never paste the output into a ticket.)

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

**Two variables are required, not one.** The provider is checked **first**, before any API key is read:

```yaml
# on the claude-mem-worker service:
CLAUDE_MEM_SERVER_PROVIDER: claude            # REQUIRED — checked before the key is even read
ANTHROPIC_API_KEY: <your-anthropic-api-key>   # placeholder — never commit a real key
```

> ⚠️ **`ANTHROPIC_API_KEY` alone is not enough.** `buildServerGenerationProviderFromEnv()` returns null immediately if
> `CLAUDE_MEM_SERVER_PROVIDER` is empty (`create-server-service.ts:242-244`) — the key at `:258` is **never reached**.
> The code's own disabled-reason says so: *"set CLAUDE_MEM_SERVER_PROVIDER **and** the matching API key to enable"*
> (`:231-233`). The reference compose hides this behind a default
> (`CLAUDE_MEM_SERVER_PROVIDER: ${CLAUDE_MEM_SERVER_PROVIDER:-claude}`, `docker-compose.yml:216`) — but **the NAS's
> compose was hand-authored on-box and is not in this repo** ([§3](#3-deploy)), so **do not assume the default is
> present there. Verify it on the box.** If it is missing, setting the API key fixes nothing and the crash loop
> continues.

Why the key matters, precisely:
- Compose declares `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` — an **empty-string default, not unset**.
- Empty key → `create-server-service.ts:258-259` returns null → no provider → `DisabledServerGenerationWorkerManager`.
- Generation disabled → the worker process **exits 0** → compose `restart: unless-stopped` restarts it → **forever**.
  Measured on this pilot: **~2,817 restarts/day, ~30,000 total, ~200ms per lifetime, ExitCode 0, zero errors logged.**
  Tracked as **queue #11**.

> ⚠️ **`CLAUDE_MEM_ANTHROPIC_API_KEY` does not work under compose.** `create-server-service.ts:258` uses `??` (nullish
> coalescing), and compose always defines `ANTHROPIC_API_KEY` as at least `""`. An empty string **is not nullish**, so
> the chain short-circuits and the `CLAUDE_MEM_ANTHROPIC_API_KEY` fallback is **unreachable** — contradicting compose's
> own comment. Setting only that variable silently does nothing. **Same defect on the `gemini` branch** (`:265`).
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
```

```bash
# Consume-only (read) — the full command, not a variant to assemble:
sudo docker exec ix-claude-mem-claude-mem-server-1 \
  bun /opt/claude-mem/scripts/server-service.cjs \
  server api-key create --name <teammate> --actor <teammate> --scope memories:read
```

> **On the script name** (you may see a contradiction elsewhere — it is resolved): the script is
> **`server-service.cjs`**. `docker-compose.yml:16-17`'s header comment says `server-beta-service.cjs`; **that comment
> is stale** — no such file exists anywhere in the repo, a casualty of the `server-beta` → `server` rename. Verified:
> `plugin/scripts/server-service.cjs` exists, and `Dockerfile:41` does `COPY plugin/ /opt/claude-mem/`, which puts it at
> exactly `/opt/claude-mem/scripts/server-service.cjs` — matching the path the runbooks record as actually run.
> If it still errors, list the real contents: `sudo docker exec ix-claude-mem-claude-mem-server-1 ls /opt/claude-mem/scripts/`.

The command prints JSON containing **`key`**, **`projectId`**, `teamId`, `scopes`, and `actorId`
(`ServerService.ts:546-554`). **Keep `key` and `projectId`** — you need both in [§6](#6-point-a-client-at-the-server).
`projectId` is not printed anywhere else convenient; capture it now.

**Two traps:**

1. ⚠️ **`--scope` defaults to `memories:read`.** Omit the flag and you mint a **read-only** key
   (`ServerService.ts:519`). A contributor holding one gets **403 on every write** — writes require `memories:write`
   (`ServerV1PostgresRoutes.ts:178`, the route surface this stack actually mounts). **The existing teammate key on the box
   (`/mnt/datapool/apps/claude-mem-pilot/teammate-readonly.key`) is read-only** — do not hand it to a contributor and
   expect writes to work.
2. ⚠️ **Always pass `--actor <name>`.** It gives each person a distinct author identity (Phase 1 attribution).
   Without it, `actor_id` falls back to `system:server-cli` (`ServerService.ts:474`) and attribution collapses.
3. ℹ️ **`--name` is echoed, not stored.** `createApiKey()` persists only `keyHash`/`teamId`/`projectId`/`scopes`/
   `actorId` (`ServerService.ts:539-545`); `name` appears in the printed JSON and nowhere else, so
   `api-key list` cannot show it. **`--actor` is the durable identity** — don't rely on `--name` to label a key.

Audit existing keys (metadata only, no secrets): `... server api-key list --active`.

---

## 6. Point a client at the server

**This is the step that failed for 11 days. Get it exactly right.**

### The four keys — all of them, in `settings.json`, not env vars

Edit **`~/.claude-mem/settings.json`** on the *client* machine.

> ⚠️ **Merge these four keys into the existing file — do not replace it.** The file very likely already holds other
> settings (the flat top-level shape is the modern format). Pasting the block below over the whole file clobbers them.
> If the file does not exist yet, create it with exactly this content.

```jsonc
{
  "CLAUDE_MEM_RUNTIME": "server",
  "CLAUDE_MEM_SERVER_URL": "http://192.168.86.47:37877",
  "CLAUDE_MEM_SERVER_API_KEY": "<key from §5>",
  "CLAUDE_MEM_SERVER_PROJECT_ID": "<projectId from §5>"
}
```

> Remote/tailnet clients use `http://truenas-scale.taila02f52.ts.net:37877` instead.

> 🔒 **Lock the file down yourself — nothing else will.** It holds a live API key.
>
> ```bash
> chmod 600 ~/.claude-mem/settings.json
> ```
>
> Do **not** assume the tooling did this. The only `chmod 0600` on `settings.json` lives in `persistServerSettings()`
> (`server-bootstrap.ts:171`) — reachable **only** via the bootstrap path that, as shown below, **never runs on a
> teammate machine**. The writer that actually runs (`mergeSettings` → `writeJsonFileAtomic`) creates a new file under
> the **process umask** (`atomic-json.ts:77-86`), i.e. typically **`0644` — world-readable**.
>
> **On Windows**, break inheritance and grant only yourself:
>
> ```powershell
> icacls "$env:USERPROFILE\.claude-mem\settings.json" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
> ```

**Miss any one of the four → silent fallback to local worker mode.** The client keeps working, captures to its own
local SQLite, and reports nothing wrong. That is the failure, and it is not loud.

- ❗ **These are `settings.json` keys, NOT environment variables.** `selectRuntime()` reads
  `loadFromFileOnce()` → `~/.claude-mem/settings.json` (`runtime-selector.ts:39-46`). **Exporting them in your shell
  proves nothing and does nothing.** The teammate-onboarding runbook's *"settings.json or env"* is **wrong** — prefer
  this document.
- ❗ **There are FOUR keys.** The onboarding runbook lists **three** — it **omits `CLAUDE_MEM_SERVER_PROJECT_ID`**,
  which `buildServerContext()` requires (`runtime-selector.ts:48-86`; the `projectId` guard is at `:83-86`). A client following that doc lands in exactly the
  silent-fallback state. **Four keys — that is the whole set.** (Corroboration: `SERVER_RUNTIME_SETTINGS_KEYS`,
  `src/npx-cli/commands/server-runtime-setup.ts:22-30`, is the uninstall teardown list. It contains these same four
  plus three deprecated `*_BETA_*` aliases of them — read as seven lines, it is still four settings.)
- Legacy `CLAUDE_MEM_SERVER_BETA_*` names are still accepted as fallbacks; `CLAUDE_MEM_RUNTIME` accepts the legacy
  value `server-beta` as well as `server`.

### ⚠️ The installer cannot finish this job on a client machine

Do not assume `npx claude-mem install --runtime server --server-url ...` configures a teammate. It does **not**:

1. It sets **only** `CLAUDE_MEM_RUNTIME` + `CLAUDE_MEM_SERVER_URL` (`install.ts:880`) — 2 of the 4 keys.
2. It then tries to bootstrap a key, which **requires `CLAUDE_MEM_SERVER_DATABASE_URL`** — i.e. **direct Postgres
   access**. A teammate's machine does not have that (Postgres lives on the NAS and is not exposed).
3. So `maybeBootstrapServerApiKey()` **skips**, logging: *"Skipping local hook API key bootstrap:
   CLAUDE_MEM_SERVER_DATABASE_URL is not set. Run `npx claude-mem server keys rotate` after configuring Postgres to
   provision a key."* (`install.ts:903-906` — this is the string to grep your install output for).

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
> on-NAS and are **not** in this repo. Do not guess them. Read them off the running container:
>
> ```bash
> sudo docker inspect <postgres-container> \
>   --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_
> ```
>
> That prints `POSTGRES_USER` / `POSTGRES_DB` — **and `POSTGRES_PASSWORD` in plaintext**, so run it privately and never
> paste the output anywhere. (`psql` inside the container authenticates locally and will not prompt for it.)
> Alternatively read them from the app's compose via the TrueNAS UI ([§4.0](#40-how-to-apply-a-config-change-do-this-first--the-rest-of-4-assumes-it)).
>
> If the query errors with *relation does not exist*, check the schema / `search_path` before concluding the table is
> missing — do not conclude the stack is empty.

### 7.2 Drive a real client session

On the client configured in [§6](#6-point-a-client-at-the-server), run an actual Claude Code session that does some
tool work. This is the part that cannot be faked by a curl — the hooks must route to the server.

### 7.3 Confirm the count moved

Re-run the count from [§7.1](#71-baseline-the-event-count-on-the-nas). **`agent_events` must be strictly greater than
your baseline.** If it did not move, the client never reached the server → go to [§8.2](#82-silent-runtime-fallback--everything-is-green-but-nothing-is-captured).
**Do not proceed on a green health check.**

> 🛑 **A moved count means ingest works. It does not mean the setup works — you are not done until
> [§7.4](#74-confirm-an-observation-actually-lands) passes.** Ingest and generation fail independently, and generation
> is the half that has never once run on this box. Stopping here is how "it's working" gets said about a stack that
> produces no observations.

### 7.4 Confirm an observation actually lands

Ingest working ≠ generation working. These are independent; verify both.

```bash
# jobs enqueued by ingest:
sudo docker exec <postgres-container> \
  psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "SELECT count(*) FROM observation_generation_jobs;"

# generated (not hand-written) observations:
sudo docker exec <postgres-container> \
  psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "SELECT count(*) FROM observations WHERE created_by_job_id IS NOT NULL;"
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
2. **If it *is* `server`,** grep the **client-side** hook log for `[server-fallback] reason=` — these paths *are*
   loud and name the exact missing key: `reason=missing_base_url` / `missing_api_key` / `missing_project_id`
   (`runtime-selector.ts:76,80,84`).

   The log lives at **`~/.claude-mem/logs/claude-mem-<YYYY-MM-DD>.log`** — `LOGS_DIR = join(DATA_DIR, 'logs')`
   (`src/shared/paths.ts:44`) and `claude-mem-${date}.log` with `date` = `toISOString().split('T')[0]`
   (`src/utils/logger.ts:116`). Note it is **`claude-mem-<date>.log`, not `worker-<date>.log`** — that split has
   already cost most of a debugging day (queue #17).

   ```bash
   grep -h "server-fallback" ~/.claude-mem/logs/claude-mem-*.log | tail -20
   ```
   ```powershell
   # Windows
   Select-String -Path "$env:USERPROFILE\.claude-mem\logs\claude-mem-*.log" -Pattern "server-fallback" | Select-Object -Last 20
   ```

   **No `[server-fallback]` line at all** (and `CLAUDE_MEM_RUNTIME` unset) → you are in case 1, the silent path.
   If `CLAUDE_MEM_DATA_DIR` is set on the client, the logs follow it instead of `~/.claude-mem`.

> The "zero WARN/ERROR in 11 days" evidence is from the **NAS**. A `[server-fallback]` warning appears on the
> **client**. NAS logs cannot rule this out — look on the client.

Fix: set all four keys ([§6](#6-point-a-client-at-the-server)). Tracked as **queue #13**, which also owns correcting
the pilot runbook's *"functionally complete"* claim — that was validated by **E2E test writes, not an actual teammate**.

### 8.3 Worker crash-loop (exits 0, restarts forever)

**Symptom:** enormous restart count, ExitCode **0**, ~200ms lifetimes, **no WARN/ERROR in the logs**, server health green.

**Read the worker's own startup log first — it names the cause in one command.** The worker logs its generation
boundary at startup, *including the disabled reason* (`ServerService.ts:849-853`):

```bash
sudo docker logs <worker-container> --tail 50
```

This is INFO, not ERROR — which is why "zero errors in 11 days" was true and useless at the same time. The reason
string distinguishes the failure modes: *"no server generation provider configured; set CLAUDE_MEM_SERVER_PROVIDER and
the matching API key to enable"* (`create-server-service.ts:231-233`) vs. a queue-disabled reason (`:225-227`).

```bash
sudo docker ps -a --format '{{.Names}}\t{{.Status}}'   # look for a churning worker
sudo docker inspect <worker-container> --format '{{.RestartCount}} {{.State.ExitCode}}'
```

**Cause:** no provider **or** no key → generation disabled → nothing holds the event loop open → Node exits 0 →
`restart: unless-stopped` → repeat. **Fix:** [§4.2](#42-set-anthropic_api_key-on-the-worker) — and note it takes
**both** `CLAUDE_MEM_SERVER_PROVIDER` **and** `ANTHROPIC_API_KEY`. Tracked as **queue #11**.

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
3b. **Whether the deployed worker sets `CLAUDE_MEM_SERVER_PROVIDER`** — the *reference* compose defaults it to `claude`
   (`docker-compose.yml:216`), but the NAS's compose is hand-authored and unverified (see #2). If it is absent there,
   generation stays disabled **even with a valid `ANTHROPIC_API_KEY`**, because the provider is checked first
   (`create-server-service.ts:242-244`). **Check the worker's env on the box** ([§4.2](#42-set-anthropic_api_key-on-the-worker)).
4. **Whether the Tailscale ACL and the node rename were ever applied** — console-only actions, unprovable from the repo
   ([§8.6](#86-naslan-does-not-resolve), [§8.7](#87-remote-teammate-can-reach-nothing--can-reach-too-much)); queue #16.
5. **Whether the `observations`/`agent_events` tables live in `public`** — the [§7](#7-verify-ingest-for-real) queries
   assume the default `search_path`. Table *names* are verified from the live box; the schema is not.
6. **How to apply a config change to the live TrueNAS app** ([§4.0](#40-how-to-apply-a-config-change-do-this-first--the-rest-of-4-assumes-it)) — the UI path is described from
   TrueNAS convention, **not executed**. The `app.update` route is recorded in the pilot runbook (used for Tailscale's
   `auth_key`); the Apps-UI YAML edit is not. Confirm before relying on either.
7. **The Postgres snapshot dataset path and command** ([§3](#3-deploy)) — not recorded anywhere in this repo.
8. **No step in this document was executed.** It is assembled from the runbooks (what was actually done), verified
   in-repo source citations, and read-only findings recorded in the queue. **Nothing was run against the NAS.**

**Resolved while writing — previously flagged, now settled (recorded so nobody re-opens it):** the container script is
**`server-service.cjs`**, not `server-beta-service.cjs`. `docker-compose.yml:16-17`'s comment is **stale** — the latter
file does not exist in the repo. `plugin/scripts/server-service.cjs` exists and `Dockerfile:41` (`COPY plugin/
/opt/claude-mem/`) places it at `/opt/claude-mem/scripts/server-service.cjs`, matching the runbooks' recorded command.

### What this document cannot give you

Being straight about it, so you budget for it: this guide is **complete for configure → point a client → verify**
(§4–§7), which is where this pilot is actually broken. It is **not** a from-scratch TrueNAS deployment runbook — §3
delegates app creation to the pilot runbook and does not reproduce it. And a handful of values simply **do not exist
outside the box** (real container names beyond the server's, the deployed compose, the DB credentials, whether the
Tailscale ACL was applied). Those are marked "verify on the box" everywhere they appear, with the command to discover
them. That is a deliberate choice: **this document would rather hand you a discovery command than a confident
fabrication.** Every instruction it *does* state as fact is cited to source you can check.
</content>
