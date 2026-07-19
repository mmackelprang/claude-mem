# Local server-beta — start / stop on demand

A Postgres-backed **claude-mem collection server** on `http://127.0.0.1:37778`, for
testing the connect-to-server / connection-config flow from a client. It is **not**
the NAS and **not** your local `:37777` worker — that worker keeps running,
untouched, whether this server is up or down.

> **Generation is OFF here.** The server *ingests* events but does not compress them
> into observations. It produces no searchable memory until server-side generation is
> enabled — that's roadmap **#30** (needs a metered `ANTHROPIC_API_KEY` = `sk-ant-…`
> from console.anthropic.com, **not** your Claude subscription, plus `--profile
> generation`). For day-to-day memory, keep using your `:37777` worker (free
> subscription generation).

## Use it

```bash
scripts/local-server-beta.sh start     # bring it up on :37778 (waits for health)
scripts/local-server-beta.sh status    # container state + /healthz
scripts/local-server-beta.sh stop      # stop; volumes/data/minted-key PRESERVED
scripts/local-server-beta.sh logs      # follow the server logs
scripts/local-server-beta.sh reset     # ⚠️ DELETE the volumes (wipes data + key), asks to confirm
```

Run from the repo root (git-bash on Windows). `stop`/`start` are cheap and lossless —
the Postgres schema, the minted API key, and Chroma all live in Docker volumes that
survive `stop`. Only `reset` (`down -v`) deletes them.

## Config + secrets

- **Compose:** `docker-compose.yml` (base, in the repo) + `docker-compose.local-uat.yml`
  (this override — publishes `127.0.0.1:37778`, bakes the Haiku model, keeps the
  generation worker behind a `generation` profile so a bare `up` never crash-loops it).
- **Secrets** (Postgres/Chroma passwords) live **outside the repo** at
  `~/.claude-mem-local-server/claude-mem-local-uat.env`. The script reads it from there;
  override with `CLAUDE_MEM_LOCAL_SERVER_ENV=/path/to.env`. **Do not commit this file.**
  If it's lost, the persisted Postgres volume can't be reused — you'd `reset` and start fresh.

## Connecting a client to it

Point a client (via the Settings-UI connection panel or the four canonical keys) at:

- **URL:** `http://127.0.0.1:37778`  (auth endpoint is `/v1/connect` — it's a Postgres server-beta)
- **API key + Project ID:** the ones minted at first standup **persist in the Postgres
  volume**, so the same values keep working across `stop`/`start`. To mint a fresh key:

  ```bash
  docker exec claude-mem-local-uat-claude-mem-server-1 \
    bun /opt/claude-mem/scripts/server-service.cjs \
    server api-key create --name <name> --actor <actor> --scope memories:read,memories:write
  ```

  (Never paste the key into a ticket or a committed file.)

## Notes

- Ports: only `127.0.0.1:37778` is published; Postgres/valkey/chroma bind internal-only,
  so there's no collision with other local services.
- `docker compose -p claude-mem-local-uat …` is the project name the script and all
  commands use.
- Teardown that keeps data = `stop`; full clean-slate = `reset`.
