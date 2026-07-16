# Runbook — Tailscale ACL lockdown + node rename

**Goal:** restrict the tailnet so remote teammates reach ONLY the claude-mem server (`:37877`) on the NAS — not SSH, the TrueNAS UI, SMB, PiHole, etc. — and rename the node `truenas-scale` → `claude-mem-nas`. **All steps are in the Tailscale admin console** (https://login.tailscale.com/admin); nothing on the NAS changes.

## Why
The claude-mem pilot uses **host networking**, so when the NAS joined the tailnet its *entire host* (every port) became reachable to any device on the tailnet. This ACL re-restricts that to just the one service port.

## Step 1 — Apply the ACL policy
Admin console → **Access Controls**. Merge this into the policy (HuJSON):

```jsonc
{
  "hosts": { "claude-mem": "100.76.112.66" },   // NAS tailnet IP
  "groups": {
    "group:cmem-teammates": []                  // add teammate emails as you onboard
  },
  "acls": [
    // You (admin) + your own devices keep full tailnet access:
    { "action": "accept", "src": ["autogroup:admin"], "dst": ["*:*"] },
    // Teammates can reach ONLY the claude-mem server port:
    { "action": "accept", "src": ["group:cmem-teammates"], "dst": ["claude-mem:37877"] }
  ]
}
```

**Before you Save — review against your device list:**
- Assumes your tailnet = you (an Admin) + teammates you add to `group:cmem-teammates`.
- Anyone who is *neither* an admin *nor* in that group gets **no** access — if you have other members/devices, add rules for them first.
- Save applies **tailnet-wide**, immediately.
- Use the **Preview / Access Rules Tester** tab to simulate a `src → dst` before committing.

## Step 2 — Rename the node
Admin console → **Machines** → `truenas-scale` → `⋯` → **Edit machine name** → `claude-mem-nas` → Save. MagicDNS becomes `claude-mem-nas.<tailnet>.ts.net`. Update `CLAUDE_MEM_SERVER_URL` in teammate configs + `docs/ops/2026-07-04-teammate-onboarding.md` to the new name.

## Step 3 — Verify
- As admin from another of your devices: `curl http://claude-mem-nas.<tailnet>.ts.net:37877/healthz` → `{"status":"ok"}`.
- Add a throwaway test user to `group:cmem-teammates`; from their device, `:37877` works but `:22` (SSH) / the TrueNAS UI / SMB are refused.

## Notes
- With this ACL, **PiHole (and anything else) you add to the NAS stays private to you** — teammates can only reach `:37877`. So you can add PiHole without widening teammate exposure.
- Complementary to a later switch to Tailscale Serve (expose only `:37877`); the ACL still applies.
