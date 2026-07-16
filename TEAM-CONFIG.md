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

1. **Set four keys** in `~/.claude-mem/settings.json` (§2).
2. **Lock that file down** — it holds a live API key and lands world-readable by default (§3).
3. **Verify your sessions actually ingest** — a green health check proves nothing (§5).

Miss step 1 by even one key and your client **silently falls back to local mode** — it keeps working, captures to your
own local SQLite, and tells you nothing is wrong. That is the failure this whole document exists to prevent.

---

## 1. Before you start

You need:

1. **Network reach to the server.** On the LAN that is `http://192.168.86.47:37877`. Remote, over Tailscale, it is
   `http://truenas-scale.taila02f52.ts.net:37877` (you must be joined to the `taila02f52.ts.net` tailnet and approved —
   ask Mark). Teammates are restricted by ACL to `:37877` only.

   > ⚠️ **Use the IP `192.168.86.47`, not `nas.lan`.** The name `nas.lan` **does not resolve on every machine** —
   > notably not on Mark's. Either use the IP everywhere, or add a hosts entry (`192.168.86.47  nas.lan`). This has cost
   > debugging time more than once. If you are remote, use the tailnet name above instead.

2. **The claude-mem plugin installed** on your machine.

3. **An API key and a project ID, from the operator.** Ask Mark to mint you a **contributor** key — one with
   **`memories:write`**, not a read-only key (see the 403 trap in §6). The mint command lives in the operator guide:
   [`docs/ops/2026-07-15-nas-server-setup.md` §5](docs/ops/2026-07-15-nas-server-setup.md#5-mint-api-keys). What it
   hands back is a **`key`** and a **`projectId`** — you need **both** in §2. There is no way to derive `projectId`
   yourself; the operator must give it to you along with the key.

---

## 2. Set the four keys — all of them, in `settings.json`, not env vars

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
local SQLite, and reports nothing wrong. That is the failure, and it is not loud. Get all four right.

- ❗ **These are `settings.json` keys, NOT environment variables.** The runtime selector reads them from
  `~/.claude-mem/settings.json` (`runtime-selector.ts:39-46`). **Exporting them in your shell proves nothing and does
  nothing.** (Any onboarding note that says "settings.json *or* env" is wrong — it is settings.json only.)
- ❗ **There are FOUR keys, not three.** The most common mistake is omitting **`CLAUDE_MEM_SERVER_PROJECT_ID`** —
  `buildServerContext()` requires it (`runtime-selector.ts:48-86`; the `projectId` guard is at `:83-86`). A client
  missing it lands in exactly the silent-fallback state above. Four keys — that is the whole set.
- Legacy `CLAUDE_MEM_SERVER_BETA_*` names are still accepted as fallbacks, and `CLAUDE_MEM_RUNTIME` accepts the legacy
  value `server-beta` as well as `server`. Prefer the non-`BETA` names above.

---

## 3. Lock the file down yourself — nothing else will

`~/.claude-mem/settings.json` now holds a **live API key**, and the tooling that wrote it does **not** restrict its
permissions.

**macOS / Linux:**

```bash
chmod 600 ~/.claude-mem/settings.json
```

**Windows** — break inheritance and grant only yourself:

```powershell
icacls "$env:USERPROFILE\.claude-mem\settings.json" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

> 🔒 **Do not assume the tooling did this.** The only `chmod 0600` on `settings.json` lives in `persistServerSettings()`
> (`server-bootstrap.ts:171`), reachable **only** via a bootstrap path that never runs on a teammate machine (§4). The
> writer that actually runs (`mergeSettings` → `writeJsonFileAtomic`) creates the file under your **process umask**
> (`atomic-json.ts:77-86`) — typically **`0644`, world-readable**. On a shared machine that leaks your key. Lock it.

---

## 4. The installer cannot finish this job on your machine

Do **not** assume `npx claude-mem install --runtime server --server-url ...` configures you. It does **not**:

1. It sets **only** `CLAUDE_MEM_RUNTIME` + `CLAUDE_MEM_SERVER_URL` (`install.ts:880`) — **2 of the 4** keys.
2. It then tries to bootstrap a key, which requires `CLAUDE_MEM_SERVER_DATABASE_URL` — i.e. **direct Postgres access**.
   Your machine does not have that (Postgres lives on the NAS and is not exposed).
3. So `maybeBootstrapServerApiKey()` **skips**, logging *"Skipping local hook API key bootstrap:
   CLAUDE_MEM_SERVER_DATABASE_URL is not set…"* (`install.ts:903-906` — grep your install output for it).

Result: `CLAUDE_MEM_SERVER_API_KEY` and `CLAUDE_MEM_SERVER_PROJECT_ID` are **never written**, and you silently run in
local worker mode. **Set the four keys by hand as in §2.** (The installer's bootstrap path is for a machine co-located
with Postgres — the operator's case, not yours.)

---

## 5. Verify your sessions actually ingest — a 200 is not verification

**A green `/healthz` proves nothing.** It returns a hardcoded `{"status":"ok",...}` string and never consults the
database. The pilot probed 200/200/200 for **11 days** while capturing **nothing**. Do not stop at a health check.

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
   got wrong in §2 — go fix it. **No `server-fallback` line and nothing is being captured?** See §6 — you are probably
   in the truly-silent path (a missing or wrong `CLAUDE_MEM_RUNTIME`). The log lives at
   `~/.claude-mem/logs/claude-mem-<date>.log` (`paths.ts:44`, `logger.ts:116`) — note it is `claude-mem-<date>.log`,
   **not** `worker-<date>.log`; if `CLAUDE_MEM_DATA_DIR` is set, the logs follow it instead of `~/.claude-mem`.

3. **Confirm the count moved on the NAS.** This is the only proof that rows actually arrived. It needs NAS access, so
   ask the operator to run the `agent_events` count before and after your session — the strictly-greater check and the
   exact queries live in the operator guide:
   [`docs/ops/2026-07-15-nas-server-setup.md` §7](docs/ops/2026-07-15-nas-server-setup.md#7-verify-ingest-for-real).
   **If the count did not move, your client never reached the server** — go to §6. Do not report "it's working" off a
   green health check.

---

## 6. Troubleshooting — what you can diagnose without NAS access

### "Everything looks green but nothing is captured" — the #1 failure

Your client is writing to its own local SQLite and never contacting the NAS. Diagnose in this order — two cheap steps:

1. **Read your `~/.claude-mem/settings.json` for `CLAUDE_MEM_RUNTIME`.** Absent, or not `server`/`server-beta`? **That
   is the truly silent path** — the runtime selector returns local worker mode with **no log whatsoever**
   (`runtime-selector.ts:101-103`). No warning will ever exist. Fix: set all four keys (§2).
2. **If it *is* `server`,** grep your hook log for `server-fallback` as in §5.2 — those paths *are* loud and name the
   exact missing key.

### 403 on write

Your key is **read-only**. Minting defaults to `memories:read`, so a key minted without `--scope memories:write` gets
**403 on every write** while reads still succeed (reads working while writes 403 is the tell). You cannot fix this from
your side — **ask the operator to mint you a `memories:read,memories:write` key** (or migrate your key's scopes):
[`docs/ops/2026-07-15-nas-server-setup.md` §5](docs/ops/2026-07-15-nas-server-setup.md#5-mint-api-keys) /
[§8.5](docs/ops/2026-07-15-nas-server-setup.md#85-403-on-write).

### `nas.lan` does not resolve

Expected on some machines, including Mark's. Use `192.168.86.47`, or add `192.168.86.47  nas.lan` to your hosts file.
Remote, use the tailnet name `http://truenas-scale.taila02f52.ts.net:37877`. (Heads-up: MagicDNS uses the host name
`truenas-scale`, not `claude-mem-nas` — confirm the working name with the operator if the tailnet name fails.)

### Something server-side looks wrong

Anything beyond the three above — the worker crash-looping, no observations being *generated* even though your events
land, wrong model/cost, ACL reachability — is an operator concern. Hand it to Mark with a pointer to the operator
guide: [`docs/ops/2026-07-15-nas-server-setup.md` §8](docs/ops/2026-07-15-nas-server-setup.md#8-troubleshooting).

---

## See also

- **Operator / deploy guide** (stand up, configure, mint keys, verify from the NAS side, troubleshoot the stack):
  [`docs/ops/2026-07-15-nas-server-setup.md`](docs/ops/2026-07-15-nas-server-setup.md).
- **Generic server reference** (upstream, not NAS-specific): [`docs/server.md`](docs/server.md).
</content>
</invoke>
