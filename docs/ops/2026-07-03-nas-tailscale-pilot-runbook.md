# Runbook — claude-mem team pilot on `nas.lan` (Tailscale + server-beta)

**Status:** IN PROGRESS · **Started:** 2026-07-03 · **Driver:** Claude (Coordinator), over SSH, with Mark approving host-mutating steps.

## Goal
Stand up the **WS2 Phase 3 pilot**: run the claude-mem **server-beta** runtime (Postgres + Redis + server-service) on `nas.lan`, reachable by **remote teammates over Tailscale**, so we can (a) clear the batched E2E validation debt (Phase 0 ×2, Phase 1 ×4) against a live server and (b) let a teammate start consuming shared memory. **Non-regression invariant:** Mark's local-first worker mode + LAN Chroma stay 100% untouched.

## Facts
| Item | Value |
|---|---|
| Pilot host | `nas.lan` = `192.168.86.47`, **TrueNAS SCALE** (Linux; Docker/VM capable — no FreeBSD jail path needed) |
| Chroma host (existing, separate) | `appserver.lan` = `192.168.86.167` (unchanged; server-beta recall is Postgres-FTS in Phase 3, Chroma wiring is Phase 4) |
| Reachability | ping 0ms, SSH :22 OPEN, `nas.lan` resolves locally |
| Access method | Dedicated ed25519 key `~/.ssh/claude_nas_pilot_ed25519` (pub authorized by Mark on the NAS; revocable by removing the authorized-key line) |
| Local tooling | OpenSSH 9.4, scp present; `sshpass` absent → key auth only |

## Architecture decision (finalize after on-box detection)
TrueNAS SCALE gives two clean, host-safe options — pick after detecting SCALE version + resources:
- **A) Native SCALE apps** — Tailscale app + server-beta as a Docker Compose "custom app" (SCALE 24.10 "Electric Eel"+ uses Docker; earlier uses k3s). Lighter.
- **B) Linux VM on SCALE (KVM)** — install Ubuntu/Debian, then Tailscale + `docker compose` *inside* the VM (fully standard, fully isolated, doesn't touch the NAS host at all). Cleaner isolation; heavier setup.
> Do **not** install Tailscale or the stack directly on the TrueNAS host OS (managed base; updates wipe host changes).

## Prerequisites (Mark)
1. **Authorize the SSH key** on a NAS user: Credentials → Local Users → (admin user) → add the public key below to *Authorized Keys*; ensure that user has a real **shell** (bash/zsh, not nologin) and **sudo**.
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAYk3zddYAtTbGtgSDhIRkOATZIWvLs3Hta+O5gNE7Eg claude-nas-pilot
   ```
2. **Tell Claude the SSH username** to use (`root` if root SSH is enabled, else the admin user, e.g. `truenas_admin`).
3. **Tailscale pre-auth key** — generate later at the `tailscale up` step (admin console → Settings → Keys). Recommend **ephemeral + tagged + short expiry**, revoked after first use. Paste at point-of-use to limit transcript exposure.

## Steps
- [x] 0. Reachability + tooling probe — DONE.
- [x] 1. Generate dedicated SSH keypair — DONE (`~/.ssh/claude_nas_pilot_ed25519`).
- [ ] 2. Mark authorizes pubkey + provides username.
- [ ] 3. Connect + **detect** (read-only): SCALE version, Apps/Docker vs k3s, VM support, CPU/RAM/pool free, existing Tailscale, whether `nas` is already on a tailnet. → choose Option A or B.
- [ ] 4. Install/authorize Tailscale (app or in-VM); `tailscale up` with the pre-auth key; capture the tailnet name/IP.
- [ ] 5. Deploy the server-beta stack (Postgres + Redis + server-service) via docker-compose; bootstrap the DB schema.
- [ ] 6. Verify reachability over the tailnet; run the batched E2E proofs (Phase 0 write/search, Phase 1 two-key attribution, in-place migration smoke).
- [ ] 7. Mint a read-only teammate key + document the day-1 "consume" onboarding.

## Security notes
- Key auth only; private key stays on Mark's machine; access revocable via the authorized-key line.
- Host-mutating commands get Mark's explicit OK before running.
- Tailscale auth key treated as a secret: point-of-use paste, ephemeral, revoked after.
- Detection pass (step 3) is read-only — no changes to the NAS until Option A/B is chosen with Mark.

## Progress & findings (2026-07-04)
- **Steps 2–6 DONE.** Server-beta is live as managed TrueNAS **custom app `claude-mem`** (postgres+valkey+server+worker, all healthy); reachable on LAN at `nas.lan:37877`. Image built locally (`claude-mem-server:pilot`, `pull_policy: missing`); DB secrets generated on-NAS in the compose (never in transcript).
- **FINDING — stale server bundle:** Phase 1's merge (PR #4) reverted the server-bundle rebuild, so the deployable shipped at schema **v1**. Fixed by rebuilding the bundle (fork **PR #5**) + redeploy → schema **v2**. **Lesson:** "regenerate `plugin/scripts/server-service.cjs`" must be a standing post-merge step — a source-only merge leaves the deployable stale.
- **E2E on the live server: 5/5 PASS** — auth enforced (401/403/200), Phase 0 scope fix, Phase 1 author attribution (no cross-actor leak), in-place v1→v2 migration.
- **FINDING — CLI can't set actor:** `server api-key create` hardcoded `actor_id`. Fixed with a `--actor` flag (fork **PR #6**), redeployed, verified on pilot (`--actor teammate-carol` → `actor_id=teammate-carol`).
- **Tailscale:** community app **v1.4.10** installed (`host_network: true`, hostname `claude-mem-nas`). **Awaiting Mark's interactive login click.** SECURITY NOTE: host networking exposes ALL NAS host ports to the tailnet — tighten with Tailscale ACLs or switch to Tailscale Serve (`:37877` only) as a follow-up.
- **TODO:** Mark clicks login URL → verify `:37877` over the tailnet → mint a read-only teammate key + document day-1 onboarding.

## COMPLETE (2026-07-04)
- **Step 4 (Tailscale) DONE.** Interactive-login flow failed — the container's health check restarted it (29×) before any login URL could be clicked, minting a fresh URL each cycle. Switched to a **pre-auth key** (set as app `auth_key` via `app.update`): node came **online** immediately, restarts `29 → 0`, state persists on the `/var/lib/tailscale` bind mount.
- **Reachable over the tailnet:** `http://truenas-scale.taila02f52.ts.net:37877` (IP `100.76.112.66`) → `/healthz` ok. (MagicDNS used the host name `truenas-scale`, not the configured `claude-mem-nas` — cosmetic.)
- **Steps 6–7 DONE.** E2E validated (5/5); read-only teammate key minted (`/mnt/datapool/apps/claude-mem-pilot/teammate-readonly.key`); day-1 onboarding written → `docs/ops/2026-07-04-teammate-onboarding.md`.
- **Pilot is functionally complete: a remote teammate can consume/contribute over Tailscale.**
- **Open follow-ups:** (1) Tailscale ACLs / Serve to stop host-networking exposing all NAS ports; (2) provider key on `claude-mem-worker` to enable generation; (3) optional node rename to `claude-mem-nas`.

## Phase 2 + Phase 4 live on pilot (2026-07-04)
- **Phase 2 (visibility) — PR #7 deployed:** pilot schema v2→v3 in-place; pre-existing rows backfilled to `visibility=private`; go-forward `team`. Verified (2 rows → private).
- **Phase 4 (Chroma vector recall) — PR #8 deployed:** added a `chroma` service (chromadb/chroma:latest, token auth, host-path volume) to the app compose; `CLAUDE_MEM_CHROMA_ENABLED=true` + remote mode + `CHROMA_API_KEY` generated on-NAS. Server wired Chroma-first with FTS fallback.
  - Validated: chroma v2 heartbeat 200 from the server container; `/v1/search` 200 (empty index → empty results, since generation is off and pre-existing rows aren't indexed); **degrade path** — chroma stopped → search stays 200 via FTS, healthz 200, server healthy. First query cold-starts (~<8s: `uvx chroma-mcp` + embedding-model warmup), fast after.
  - Fixed a bogus chroma healthcheck (image has no `python`) → disabled it (server depends on chroma via `service_started`, so functionally unaffected).
- **Pilot stack:** postgres + valkey + chroma + claude-mem-server + claude-mem-worker, all up.
- **For real semantic recall:** the Chroma index is empty until generation runs (needs `ANTHROPIC_API_KEY` on the worker → server-generated observations index to Chroma via the Phase-4 write side). Existing Postgres rows would need a one-time Chroma backfill (not built).
