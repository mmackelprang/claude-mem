# Runbook — PiHole ad-blocker on the NAS

**Status:** INSTALLED + verified (2026-07-06). Ad-blocking active (~78k domains). **Final step is Mark's: point the router's DHCP DNS at the NAS.**

## What was deployed
- TrueNAS **custom app `pihole`** (`pihole/pihole:latest`), bridge networking, `NET_ADMIN`.
- **DNS:** `192.168.86.47:53` (TCP+UDP) — bound to the *specific* LAN IP to avoid the Docker internal DNS on `10.20.233.1:53`. (The **catalog** PiHole app was rejected because its `host_ips` only accepts `0.0.0.0`/`::`, and `0.0.0.0:53` would collide with the Docker DNS the claude-mem containers rely on — hence the custom app.)
- **Web admin:** `http://192.168.86.47:8081/admin` (port 8081, since TrueNAS UI owns 80/443).
- Upstream DNS: `1.1.1.1;8.8.8.8`. Blocklist: default gravity. Config persisted at `/mnt/datapool/apps/pihole/etc-pihole`.
- Admin password: `/mnt/datapool/apps/pihole-secrets/web_password` (chmod 600).

## Verified
`doubleclick.net` → `0.0.0.0` (blocked); `github.com` → real IP (allowed); gravity = 78,188 domains; web admin `302`; container healthy.

## Final step — make it network-wide (router; Mark)
Router admin → **LAN / DHCP settings → DNS server** → set primary to **`192.168.86.47`**. Every device using PiHole after its next DHCP lease renewal. **Leave the secondary DNS empty (or also `192.168.86.47`)** — a public secondary (e.g. `8.8.8.8`) lets devices bypass PiHole.

## Caveats / follow-ups
- **Per-client stats:** under bridge networking, PiHole may attribute all queries to the Docker gateway IP (collapsed per-device dashboard). Blocking still works for every device. For true per-device stats, switch PiHole to **macvlan** (its own LAN IP) — more involved; ask if wanted.
- **DNS is now a dependency:** if the NAS/PiHole goes down and it's your only DHCP DNS, LAN name resolution stops. Consider a secondary resolver for resilience.
- The Tailscale ACL (see the ACL runbook) already keeps PiHole private to you — teammates can only reach `:37877`.
