# Day-1 onboarding — remote teammate → claude-mem team memory (pilot)

The pilot **server-beta** runs on the NAS, reachable over **Tailscale**:
- **Tailnet address:** `http://truenas-scale.taila02f52.ts.net:37877` (tailnet IP `100.76.112.66`, tailnet `taila02f52.ts.net`)
- Health: `curl http://truenas-scale.taila02f52.ts.net:37877/healthz` → `{"status":"ok","runtime":"server-beta"}`
- Runtime: server-beta, Postgres schema v2 (Phase 0 + Phase 1), Chroma disabled (Phase 4), auth = api-key.

## Prerequisites (teammate machine)
1. **Tailscale** installed + joined to the `taila02f52.ts.net` tailnet, approved by Mark (tailnet admin).
2. **claude-mem** plugin installed.
3. An **API key** issued by Mark (below).

## Mint a key (Mark, on the NAS)
```bash
# consume-only (read):
sudo docker exec ix-claude-mem-claude-mem-server-1 \
  bun /opt/claude-mem/scripts/server-service.cjs \
  server api-key create --name <teammate> --actor <teammate> --scope memories:read
# contributor (read+write): --scope memories:read,memories:write
```
`--actor <teammate>` gives each person a distinct author identity (Phase 1 attribution). A ready-made read-only demo key is at `/mnt/datapool/apps/claude-mem-pilot/teammate-readonly.key`.

## Teammate config (settings.json or env)
```
CLAUDE_MEM_RUNTIME=server
CLAUDE_MEM_SERVER_URL=http://truenas-scale.taila02f52.ts.net:37877
CLAUDE_MEM_SERVER_API_KEY=<the key>
```
`selectRuntime()` routes to the server when `RUNTIME=server` (`server-beta` also accepted) **and** `SERVER_URL` + `SERVER_API_KEY` are set; otherwise it **silently falls back to local worker mode** (so a misconfig never breaks a solo user).

## Verify (from the teammate machine, on the tailnet)
```bash
curl http://truenas-scale.taila02f52.ts.net:37877/healthz
curl -X POST -H "Authorization: Bearer <key>" -H 'content-type: application/json' \
  http://truenas-scale.taila02f52.ts.net:37877/v1/search -d '{"query":"..."}'
```

## Notes / follow-ups
- **Generation** (turning events into observations) needs a provider key (`ANTHROPIC_API_KEY`) on the `claude-mem-worker` service — intentionally unset in the pilot. Contributors' writes queue but won't generate observations until that's set.
- **Security:** host networking puts the whole NAS on the tailnet — restrict with **Tailscale ACLs** (limit who/what reaches `truenas-scale:37877`) or switch to **Tailscale Serve** to expose only `:37877`.
- Full server config reference: `docs/server.md`.
