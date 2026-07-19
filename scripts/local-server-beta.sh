#!/usr/bin/env bash
#
# local-server-beta.sh — start / stop / status a LOCAL claude-mem server-beta
# on http://127.0.0.1:37778.
#
# What this is: a Postgres-backed collection server for testing the
# connect-to-server / connection-config flow. It is NOT the NAS and NOT your
# local :37777 worker (which keeps running independently and untouched).
#
# Generation is intentionally OFF (the server ingests but does not compress
# events into observations). Enabling server-side generation is roadmap #30 —
# it needs a metered ANTHROPIC_API_KEY (sk-ant-…, NOT your Claude subscription)
# and `--profile generation`; see docs/ops/2026-07-18-local-server-beta.md.
#
# Secrets (Postgres/Chroma passwords) live in an env file OUTSIDE the repo:
#   ~/.claude-mem-local-server/claude-mem-local-uat.env
# Override its path with CLAUDE_MEM_LOCAL_SERVER_ENV.
#
# Data (Postgres schema + the minted API key + Chroma) persists in Docker
# volumes across stop/start. `reset` is the only thing that deletes them.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="claude-mem-local-uat"
BASE="$REPO/docker-compose.yml"
OVERRIDE="$REPO/docker-compose.local-uat.yml"
ENV_FILE="${CLAUDE_MEM_LOCAL_SERVER_ENV:-$HOME/.claude-mem-local-server/claude-mem-local-uat.env}"
PORT=37778
URL="http://127.0.0.1:${PORT}"

compose() {
  docker compose --project-directory "$REPO" -p "$PROJECT" \
    -f "$BASE" -f "$OVERRIDE" --env-file "$ENV_FILE" "$@"
}

require_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    echo "  (holds the Postgres/Chroma secrets the persisted volumes expect)" >&2
    exit 1
  fi
}

case "${1:-status}" in
  start)
    require_env
    echo "Starting server-beta on ${URL} (generation OFF)…"
    compose up -d claude-mem-server || { echo "ERROR: compose up failed" >&2; exit 1; }
    echo -n "Waiting for health"
    for _ in $(seq 1 30); do
      if curl -sf "${URL}/healthz" >/dev/null 2>&1; then
        echo " — UP: ${URL}"
        exit 0
      fi
      echo -n "."
      sleep 2
    done
    echo " — WARN: not healthy after 60s. Check: $0 logs" >&2
    exit 1
    ;;
  stop)
    require_env
    echo "Stopping (volumes/data/minted-key preserved)…"
    compose down
    ;;
  status)
    require_env
    compose ps
    echo -n "healthz: "
    curl -s -m 3 "${URL}/healthz" 2>/dev/null || echo "(down)"
    echo
    ;;
  logs)
    require_env
    compose logs -f --tail=100 claude-mem-server
    ;;
  reset)
    require_env
    echo "⚠️  DELETES the Postgres/Chroma/data volumes — the minted API key and all"
    echo "    ingested data go with them. You'd re-mint a key on next start."
    read -r -p "Type 'reset' to confirm: " c
    if [ "$c" = "reset" ]; then compose down -v; else echo "aborted"; exit 1; fi
    ;;
  *)
    echo "usage: $0 {start|stop|status|logs|reset}" >&2
    exit 1
    ;;
esac
