# Docker

The root `docker-compose.yml` starts Claude-Mem Server beta with a persistent Valkey sidecar.

```sh
docker compose up --build
curl http://127.0.0.1:37777/healthz
```

The server container uses:

- `CLAUDE_MEM_WORKER_HOST=0.0.0.0`
- `CLAUDE_MEM_DATA_DIR=/data/claude-mem`
- `CLAUDE_MEM_QUEUE_ENGINE=bullmq`
- `CLAUDE_MEM_REDIS_URL=redis://valkey:6379`
- `CLAUDE_MEM_AUTH_MODE=api-key`

Create an API key inside the container before using protected V1 write routes.

## Vector recall (Chroma) — Phase 4 pilot

The stack includes a `chroma` service (`chromadb/chroma`) that backs semantic
vector recall for the `/v1/search`, `/v1/context`, and `/v1/mcp` read surfaces.
The worker indexes every generated observation into Chroma on write; the server
queries Chroma first and falls back to Postgres full-text search (FTS) whenever
Chroma is unavailable, so recall degrades safely instead of failing.

### Required secret

`CHROMA_API_KEY` is **required** when Chroma is enabled (the default). It is the
token credential the Chroma server enforces and is passed to `chroma-mcp` via
`--api-key`. Supply it in your `.env`:

```sh
CHROMA_API_KEY=$(openssl rand -hex 32)
```

The stack refuses to start if Chroma is enabled and `CHROMA_API_KEY` is unset.

### How the app services reach Chroma

Both `claude-mem-server` and `claude-mem-worker` connect over the in-network
hostname `chroma` using the remote (HTTP) chroma-mcp client. The relevant env
(already wired in `docker-compose.yml`):

- `CLAUDE_MEM_CHROMA_ENABLED=true` — turns the vector path on for the server
  (write + read). Strict opt-in: only the exact string `true` enables it.
- `CLAUDE_MEM_CHROMA_MODE=remote`
- `CLAUDE_MEM_CHROMA_HOST=chroma`
- `CLAUDE_MEM_CHROMA_PORT=8000`
- `CLAUDE_MEM_CHROMA_SSL=false`
- `CLAUDE_MEM_CHROMA_API_KEY=${CHROMA_API_KEY}`

### FTS escape hatch

There are two levels to fall back to Postgres-FTS-only:

1. **Recall level (keep the container, stop using it).** Set
   `CLAUDE_MEM_CHROMA_ENABLED=false` on both app services. The app then neither
   writes to nor reads from Chroma — all recall is Postgres FTS. **Note:** the
   `chroma` service still starts and `CHROMA_API_KEY` is still required, because
   `docker-compose.yml` references `${CHROMA_API_KEY:?…}` on all three services
   and declares `depends_on: chroma` unconditionally — both are evaluated by
   Docker Compose at parse/startup time, independent of the app-level flag. So
   you must still supply any `CHROMA_API_KEY` value; the (now-idle) Chroma
   container just goes unused.
2. **Infra level (remove Chroma entirely).** To drop the `CHROMA_API_KEY`
   requirement and stop the container, remove the `chroma` service, the
   `chroma-data` volume, and — on both app services — the `CHROMA_*` env block
   and the `depends_on: chroma` entry. The cleanest way is a compose **override
   file** (`docker compose -f docker-compose.yml -f docker-compose.fts.yml up`)
   that nulls those out, so the base file stays pilot-ready.

### Networking / security

The Chroma `8000` port is intentionally **not published to the host** (there is
no `ports:` mapping on the `chroma` service) — only the in-network app services
can reach it (roadmap H1/H3). Token auth additionally gates the HTTP port so the
deployment is never open. Per-tenant isolation is enforced by the Chroma `where`
filter (`{$and:[{projectId},{teamId}]}` plus the visibility predicate) and the
`cm__<projectId>` collection name; a single shared Chroma service is acceptable
for the pilot, with DB/tenant separation deferred to a later hardening phase.
