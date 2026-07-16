# Orphaned listening-socket reproduction (Windows/Bun)

Standalone harness for the P0 in BUILDER_QUEUE row #17: whether the worker's
`127.0.0.1:37777` HTTP listen socket is inherited by the spawned `chroma-mcp`
child chain, so a worker death leaves a dead-PID process holding the port
`LISTENING` and the next start dies `EADDRINUSE`.

The harness uses **127.0.0.1:37799** (never 37777) so it never disturbs a live
worker. On non-Windows it prints `SKIP` and exits 0.

## Reproduce the leak (current build)
`bun scripts/repro/orphaned-socket-repro.ts`

- If the leak reproduces: last stdout line is `RESULT: PORT_HELD_BY_ORPHAN pid=<n>` (exit 1).
- If the port is released after the parent dies: `RESULT: PORT_FREE` (exit 0).

## Verify a prevention fix (Task 2, if/when it lands)
`REPRO_APPLY_FIX=1 bun scripts/repro/orphaned-socket-repro.ts`
Expected (if a prevention fix is applied): `RESULT: PORT_FREE` (exit 0).

Notes: If interrupted, clean up any leftover child: `taskkill /PID <child> /T /F`.

## Observed result — 2026-07-16 (Bun 1.3.5, this box)

**The harness does NOT reproduce the leak: `RESULT: PORT_FREE`, consistently.**
This was confirmed across the harness itself plus three progressively-more-faithful
variants (native passive child instead of a `bun.exe` child; production's exact
`stdio: ['pipe','pipe','inherit']`; and production's exact spawn primitive
`cross-spawn` with `shell:false`) — 12 runs, all `PORT_FREE`.

Interpretation: via the Node-compat `child_process.spawn` / `cross-spawn` path
(which is how the MCP SDK's `StdioClientTransport` spawns chroma-mcp — see
`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js`), Bun does not
leak the HTTP listen socket to spawned children on this build. Because a
grandchild can only inherit a handle the direct child received, the deep
`uvx -> uv -> chroma-mcp -> python` chain cannot leak it either.

This puts the plan's root-cause premise (Task 2: "mark the socket
non-inheritable") in question. The **defense-in-depth** tasks (real bind probe,
surfaced bind error + log-path fix, orphan reaper, crash-loop signal) remain
valid regardless of the prevention premise. The only test that would settle
whether *production* still leaks with the current Bun is killing the **live**
worker and observing `:37777` — deliberately NOT run here (it disrupts the live
session and would trigger the very bug under investigation). See the
`Blocker — #17` section in `docs/BUILDER_QUEUE.md` for the decision handed to the
maintainer.
