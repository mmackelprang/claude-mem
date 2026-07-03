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
