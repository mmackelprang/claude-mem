# TEAM-CONFIG — connect your machine to the team's claude-mem

**Who this is for:** a **teammate** pointing their own Claude Code at the team's **already-running** claude-mem server
on the NAS. If that describes you, this file is the whole job.

**Not what you're doing?** If you are standing up, configuring, or repairing the server **app on the NAS** (deploy,
env vars, minting keys, the generation worker), you want the operator guide instead:
[`docs/ops/2026-07-15-nas-server-setup.md`](docs/ops/2026-07-15-nas-server-setup.md). This file does **not** cover any
of that — it points at it where you need it.

> **Fork-only.** This is pilot infrastructure for our team's fork, not an upstream claude-mem feature. The server it
> talks to is the `claude-mem` custom app on our NAS.

---

## The whole job, in three steps

1. **Add a connection in the Settings UI and activate it with Test-before-Activate** (§2). The UI probes the server —
   reachable → API key → project — and **refuses to activate a connection that fails**, telling you exactly which of the
   three broke. This is what kills the silent-fallback failure below. (Prefer the shell? The by-hand `settings.json`
   route is the **fallback** in §3 — same result, none of the guardrails.)
2. **Lock that file down** — activating a connection writes a live API key into `~/.claude-mem/settings.json`, which
   lands world-readable by default (§4).
3. **Verify your sessions actually ingest** — a green health check proves nothing (§6).

The failure this whole document exists to prevent: miss one connection value and your client **silently falls back to
local mode** — it keeps working, captures to your own local SQLite, and tells you nothing is wrong. The Settings-UI Test
(§2) catches that before you ever activate; the manual route (§3) does not, which is exactly why the UI is the primary
path.

---

## 1. Before you start

You need:

1. **Network reach to the server.** On the LAN that is `http://192.168.86.47:37877`. Remote, over Tailscale, it is
   `http://truenas-scale.taila02f52.ts.net:37877` (you must be joined to the `taila02f52.ts.net` tailnet and approved —
   ask Mark). Teammates are restricted by ACL to `:37877` only.

   > ⚠️ **Use the IP `192.168.86.47`, not `nas.lan`.** The name `nas.lan` **does not resolve on every machine** —
   > notably not on Mark's. Either use the IP everywhere, or add a hosts entry (`192.168.86.47  nas.lan`). This has cost
   > debugging time more than once. If you are remote, use the tailnet name above instead.
   >
   > ⚠️ **The server port is `37877`.** The Add-connection presets (§2) pre-fill a **`37700`** template port — that is
   > the *local viewer's* default port, **not** the NAS's. Whichever preset you pick, replace the whole URL with the
   > real one above.

2. **The claude-mem plugin installed** on your machine, and its worker running (it must be, for the viewer in §2 to
   open).

3. **An API key and a project ID, from the operator.** Ask Mark to mint you a **contributor** key — one with
   **`memories:write`**, not a read-only key (see the 403 trap in §7). The mint command lives in the operator guide:
   [`docs/ops/2026-07-15-nas-server-setup.md` §5](docs/ops/2026-07-15-nas-server-setup.md#5-mint-api-keys). What it
   hands back is a **`key`** and a **`projectId`** — you need **both** in §2. There is no way to derive `projectId`
   yourself; the operator must give it to you along with the key.

---

## 2. Connect in the Settings UI — the primary path

The claude-mem viewer manages connections as **named profiles** you switch between, and it will not let you activate one
until a live probe passes. This is the recommended way to connect: the probe converts the silent 11-day fallback into a
loud, specific failure.

### 2.1 Open the Connection panel

Open the **claude-mem web viewer** on your machine — the worker prints its URL on startup; it serves on
`http://127.0.0.1:<port>`, where `<port>` defaults to `37700 + (uid % 100)` (or whatever you set as
`CLAUDE_MEM_WORKER_PORT`). In the viewer, open **Settings** (the context-preview/gear toggle in the header). The **first
section is "Connection."** A chip reads `● This viewer — Local worker`, confirming you're configuring *this* machine's
client.

### 2.2 Add a connection

Click **+ Add connection** and pick a preset — **LAN**, **Tailscale**, **Custom**, or **Local worker**. The preset
pre-fills a URL *template* and drops you into the editor. Fill in:

- **Name** — anything, e.g. `NAS (LAN)` or `NAS (Tailscale)`. (Required; it's just a label.)
- **Runtime** — **Server** (a preset other than "Local worker" sets this for you).
- **Server URL** — **replace the template entirely** with the real address from §1:
  `http://192.168.86.47:37877` on the LAN, or `http://truenas-scale.taila02f52.ts.net:37877` remote. Do **not** ship the
  preset's `<hostname>.lan:37700` placeholder — the host *and* the port are both wrong for the NAS.
- **API key** — the `key` the operator minted for you (masked by default; use **Reveal** to check it).
- **Project ID** — the `projectId` the operator gave you alongside the key. Required — the single most-dropped value.

### 2.3 Test — the guardrail that makes this the primary path

Click **Test connection**. A three-step stepper runs, **short-circuiting on the first hard failure**, so you always
know *which* thing is wrong:

1. **Reachable** — `GET {url}/healthz` returns 200 and looks like claude-mem. Fail here → wrong address / server down /
   TLS problem. A host that answers but isn't claude-mem reads *"doesn't look like a claude-mem server,"* not a key
   error.
2. **Authenticated** — the key is checked against the server. **The Test auto-detects the server type** (see the box
   below), so it hits the right auth endpoint. A rejected key is reported as an authentication failure — *"The server
   rejected the API key"* or *"This server requires an API key"* — never a generic "can't connect."
3. **Project valid** — your `projectId` is checked on that server. A brand-new project id is a **warn** ("will be
   created on first capture"), still activatable; a forbidden project (403) is a hard fail.

If every step passes (or passes with a warn), the banner offers **Activate this connection**. On **any hard fail,
Activate is not offered** — you cannot activate a broken connection. That is the whole point: the client can never
silently switch to a connection that doesn't work.

> **Why the Test can't be fooled by a wrong URL — the two-variant reality (verified in code).**
> There are two connectable claude-mem server types, and they expose **different** auth APIs:
> a **local worker** authenticates at `GET /v1/projects`; a **Postgres server-beta** (the NAS + its docker stack)
> authenticates at `GET /v1/connect`. Each **404s the other's endpoint.** The Test probes `/v1/connect` first and falls
> back to `/v1/projects`; if **both** 404, the host answered `/healthz` but exposes **no** claude-mem auth API, so the
> result is **"No compatible claude-mem server"** at that host — explicitly **not** a key error. So a genuinely-wrong URL
> (some other service that happens to return a 200 health string) tells you the URL is wrong, and a wrong *key* tells you
> the key is wrong. They never get confused. (`ConnectionTestRoutes.ts` — variant detection at the `authenticated` step.)

### 2.4 Activate

Click **Activate this connection**. Under the hood this writes the four canonical keys the hooks read —
`CLAUDE_MEM_RUNTIME` / `CLAUDE_MEM_SERVER_URL` / `CLAUDE_MEM_SERVER_API_KEY` / `CLAUDE_MEM_SERVER_PROJECT_ID` — into
`~/.claude-mem/settings.json` from the active profile (`ConnectionStore.applyToSettings`, the single owner of that
derivation). New captures route to the server from that point. Switching connections later is one click: focus a profile,
**Test**, **Activate**.

> ℹ️ **Already hand-edited `settings.json` before? You won't lose it.** On first load the UI **adopts** a pre-existing
> `runtime=server` config into a profile named **"Server"** and marks it active, rather than silently wiping it
> (`ConnectionStore` adoption logic). Your existing connection shows up in the panel; you can Test/rename it from there.

> 🔒 **Activating still writes a live API key to `settings.json`** — both inside the `CLAUDE_MEM_CONNECTIONS` profile
> list **and** in the canonical `CLAUDE_MEM_SERVER_API_KEY`. So **§4's lockdown still applies to the UI path**, not just
> the manual one.

---

## 3. Fallback — set the four keys by hand in `settings.json`

Use this only if you can't reach the viewer (headless box, etc.). It reaches the **same** four canonical keys the UI
writes for you in §2 — but **without the Test guardrail**, so a typo here is exactly the silent fallback the UI prevents.
Edit **`~/.claude-mem/settings.json`** on **your** machine.

> ⚠️ **Merge these four keys into the existing file — do not replace it.** The file very likely already holds other
> settings (the flat top-level shape is the modern format). Pasting the block below over the whole file clobbers them.
> If the file does not exist yet, create it with exactly this content.

```jsonc
{
  "CLAUDE_MEM_RUNTIME": "server",
  "CLAUDE_MEM_SERVER_URL": "http://192.168.86.47:37877",
  "CLAUDE_MEM_SERVER_API_KEY": "<key from the operator>",
  "CLAUDE_MEM_SERVER_PROJECT_ID": "<projectId from the operator>"
}
```

> Remote/tailnet clients use `http://truenas-scale.taila02f52.ts.net:37877` for `CLAUDE_MEM_SERVER_URL` instead.

**Miss any one of the four → silent fallback to local worker mode.** The client keeps working, captures to its own
local SQLite, and reports nothing wrong. That is the failure, and it is not loud. Get all four right — or use §2, whose
Test catches exactly this before activation.

- ❗ **These are `settings.json` keys, NOT environment variables.** The runtime selector reads them from
  `~/.claude-mem/settings.json` (`runtime-selector.ts:39-46`). **Exporting them in your shell proves nothing and does
  nothing.** (Any onboarding note that says "settings.json *or* env" is wrong — it is settings.json only.)
- ❗ **There are FOUR keys, not three.** The most common mistake is omitting **`CLAUDE_MEM_SERVER_PROJECT_ID`** —
  `buildServerContext()` requires it (`runtime-selector.ts:48-86`; the `projectId` guard is at `:83-86`). A client
  missing it lands in exactly the silent-fallback state above. Four keys — that is the whole set.
- Legacy `CLAUDE_MEM_SERVER_BETA_*` names are still accepted as fallbacks, and `CLAUDE_MEM_RUNTIME` accepts the legacy
  value `server-beta` as well as `server`. Prefer the non-`BETA` names above.

---

## 4. Lock the file down yourself — nothing else will

`~/.claude-mem/settings.json` now holds a **live API key** (whether you got there via §2 or §3), and the tooling that
wrote it does **not** restrict its permissions.

**macOS / Linux:**

```bash
chmod 600 ~/.claude-mem/settings.json
```

**Windows** — break inheritance and grant only yourself:

```powershell
icacls "$env:USERPROFILE\.claude-mem\settings.json" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

> 🔒 **Do not assume the tooling did this.** The only `chmod 0600` on `settings.json` lives in `persistServerSettings()`
> (`server-bootstrap.ts:171`), reachable **only** via a bootstrap path that never runs on a teammate machine (§5). The
> writer that actually runs (`mergeSettings` → `writeJsonFileAtomic`, and the `/api/settings` POST the viewer uses)
> creates the file under your **process umask** (`atomic-json.ts:77-86`) — typically **`0644`, world-readable**. On a
> shared machine that leaks your key. Lock it.

---

## 5. The installer cannot finish this job on your machine

Do **not** assume `npx claude-mem install --runtime server --server-url ...` configures you. It does **not**:

1. It sets **only** `CLAUDE_MEM_RUNTIME` + `CLAUDE_MEM_SERVER_URL` (`install.ts:880`) — **2 of the 4** keys.
2. It then tries to bootstrap a key, which requires `CLAUDE_MEM_SERVER_DATABASE_URL` — i.e. **direct Postgres access**.
   Your machine does not have that (Postgres lives on the NAS and is not exposed).
3. So `maybeBootstrapServerApiKey()` **skips**, logging *"Skipping local hook API key bootstrap:
   CLAUDE_MEM_SERVER_DATABASE_URL is not set…"* (`install.ts:903-906` — grep your install output for it).

Result: `CLAUDE_MEM_SERVER_API_KEY` and `CLAUDE_MEM_SERVER_PROJECT_ID` are **never written**, and you silently run in
local worker mode. **Connect via the Settings UI (§2)** — or, failing that, set the four keys by hand (§3). (The
installer's bootstrap path is for a machine co-located with Postgres — the operator's case, not yours.)

---

## 6. Verify your sessions actually ingest — a 200 is not verification

**A green `/healthz` proves nothing.** It returns a hardcoded `{"status":"ok",...}` string and never consults the
database. The pilot probed 200/200/200 for **11 days** while capturing **nothing**. Do not stop at a health check —
and note the §2 Test's "Reachable" step is that same `/healthz`, so a green Test step 1 alone is not proof of capture
either; it's steps 2–3 (auth + project) plus this section that matter.

Verify in this order:

1. **Drive a real session.** On this machine, run an actual Claude Code session that does some tool work. This is the
   part a `curl` cannot fake — your hooks must route to the server.

2. **Check your own hook log for a fallback.** If your client quietly dropped to local mode, it says so here:

   ```bash
   grep -h "server-fallback" ~/.claude-mem/logs/claude-mem-*.log | tail -20
   ```
   ```powershell
   # Windows
   Select-String -Path "$env:USERPROFILE\.claude-mem\logs\claude-mem-*.log" -Pattern "server-fallback" | Select-Object -Last 20
   ```

   A `[server-fallback] reason=missing_base_url` / `missing_api_key` / `missing_project_id` line names the exact key you
   got wrong — go fix it (re-run §2's Test, or correct §3). **No `server-fallback` line and nothing is being captured?**
   See §7 — you are probably in the truly-silent path (a missing or wrong `CLAUDE_MEM_RUNTIME`). The log lives at
   `~/.claude-mem/logs/claude-mem-<date>.log` (`paths.ts:44`, `logger.ts:116`) — note it is `claude-mem-<date>.log`,
   **not** `worker-<date>.log`; if `CLAUDE_MEM_DATA_DIR` is set, the logs follow it instead of `~/.claude-mem`.

3. **Confirm the count moved on the NAS.** This is the only proof that rows actually arrived. It needs NAS access, so
   ask the operator to run the `agent_events` count before and after your session — the strictly-greater check and the
   exact queries live in the operator guide:
   [`docs/ops/2026-07-15-nas-server-setup.md` §7](docs/ops/2026-07-15-nas-server-setup.md#7-verify-ingest-for-real).
   **If the count did not move, your client never reached the server** — go to §7. Do not report "it's working" off a
   green health check.

> ℹ️ **Events landing ≠ memories you can search.** Even a perfectly-connected client only sends *events*; the server
> turns those into searchable observations with a separate **generation worker** that needs a metered
> `ANTHROPIC_API_KEY`. If the operator hasn't enabled generation yet, your captures ingest but produce **no searchable
> memory** — that's an operator/roadmap task (queue #30), not something wrong on your side. See the operator guide
> [§4.2](docs/ops/2026-07-15-nas-server-setup.md#42-set-anthropic_api_key-on-the-worker) / [§7.4](docs/ops/2026-07-15-nas-server-setup.md#74-confirm-an-observation-actually-lands).

---

## 7. Troubleshooting — what you can diagnose without NAS access

### "Everything looks green but nothing is captured" — the #1 failure

Your client is writing to its own local SQLite and never contacting the NAS. **The fastest fix is to re-run the §2
Test** — it names the broken step directly. If you're on the manual path, diagnose in this order — two cheap steps:

1. **Read your `~/.claude-mem/settings.json` for `CLAUDE_MEM_RUNTIME`.** Absent, or not `server`/`server-beta`? **That
   is the truly silent path** — the runtime selector returns local worker mode with **no log whatsoever**
   (`runtime-selector.ts:101-103`). No warning will ever exist. Fix: activate a connection in §2, or set all four keys
   (§3).
2. **If it *is* `server`,** grep your hook log for `server-fallback` as in §6.2 — those paths *are* loud and name the
   exact missing key.

### 403 on write

Your key is **read-only**. Minting defaults to `memories:read`, so a key minted without `--scope memories:write` gets
**403 on every write** while reads still succeed (reads working while writes 403 is the tell). In the §2 Test this shows
up as the **Project valid** step failing with *"This key can't write to project … (403)."* You cannot fix this from your
side — **ask the operator to mint you a `memories:read,memories:write` key** (or migrate your key's scopes):
[`docs/ops/2026-07-15-nas-server-setup.md` §5](docs/ops/2026-07-15-nas-server-setup.md#5-mint-api-keys) /
[§8.5](docs/ops/2026-07-15-nas-server-setup.md#85-403-on-write).

### `nas.lan` does not resolve

Expected on some machines, including Mark's. Use `192.168.86.47`, or add `192.168.86.47  nas.lan` to your hosts file.
Remote, use the tailnet name `http://truenas-scale.taila02f52.ts.net:37877`. (Heads-up: MagicDNS uses the host name
`truenas-scale`, not `claude-mem-nas` — confirm the working name with the operator if the tailnet name fails.)

### The §2 Test says "not a compatible claude-mem server"

You reached *something* at that URL, but it isn't claude-mem's auth API — almost always a **wrong URL or port** (the
NAS is `:37877`, not the preset's `:37700`), or a different service answering on that address. This is **not** a key
problem, so don't touch the key. Fix the URL and Test again (§2.2–2.3).

### Something server-side looks wrong

Anything beyond the above — the worker crash-looping, no observations being *generated* even though your events land,
wrong model/cost, ACL reachability — is an operator concern. Hand it to Mark with a pointer to the operator guide:
[`docs/ops/2026-07-15-nas-server-setup.md` §8](docs/ops/2026-07-15-nas-server-setup.md#8-troubleshooting).

---

## See also

- **Operator / deploy guide** (stand up, configure, mint keys, verify from the NAS side, troubleshoot the stack):
  [`docs/ops/2026-07-15-nas-server-setup.md`](docs/ops/2026-07-15-nas-server-setup.md).
- **Generic server reference** (upstream, not NAS-specific): [`docs/server.md`](docs/server.md).
</content>
</invoke>
