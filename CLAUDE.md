# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to the installed plugin, restart worker
npm run verify:plugin-delivery # Check: will the hooks load the build in plugin/?
```

`build-and-sync` ends by asserting that the plugin root the hooks resolve contains the build you just
made, comparing by content hash. If it fails, the build did not reach the running plugin — fix that
before assuming your change is live. (Version strings can't answer this: a fork build and the upstream
release it descends from can both report the same version.)

## Test gate (auto-merge gate 2)

```bash
npm run test:gate          # runs the unit suite to completion and gates on the encoded baseline
```

Auto-merge policy gate 2 ("the full unit suite is green") is served by `npm run test:gate`, **not** raw
`bun test`. Raw `bun test` never completes on this fork (2 upstream files hang at bun-init + 1 crashes the
JUnit reporter). The gate excludes those 3 files (the `nonRunnable` list in `tests/known-failures.json`),
runs the rest under a wall-clock watchdog, and exits non-zero on any of: a **new failure**, a **new hang**
(watchdog fires ⇒ no XML), or an **unexpected pass** (a baselined test now passes — remove its entry).

`tests/known-failures.json` encodes the standing, environment-specific failures inherited from upstream
v13.11.0 (Windows path separators, POSIX file-mode, the #6 ComSpec spawn contract, the two source-standard
assertions) as an **expected-failure baseline**, keyed by `{ file, exact bun testcase name }` and scoped by
platform + env. It is a **fork-only** file — the mechanism edits **zero** upstream-owned test/src files
(ADR 0002 §9). The #35 privacy sentinel is modelled as a `conditionalFailures` entry: expected-red when
`CLAUDE_MEM_TEST_POSTGRES_URL` is unset, expected-green when set. Seed/refresh with
`npm run test:gate:update` (under review only — never in CI).

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

**Installed Plugin** — the hooks do *not* simply load the marketplace directory. They resolve a plugin
root through this chain and take the first hit (order is contractual; see
`src/build/hook-shell-template.ts`):

1. `$CLAUDE_PLUGIN_ROOT` / `$PLUGIN_ROOT` — if the host injects one
2. `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/` — **newest mtime first**, not highest version
3. `~/.claude/plugins/marketplaces/thedotmack/plugin` — fallback

So a `cache/<version>/` directory normally wins, and the marketplace copy is only a fallback. `npm run
verify:plugin-delivery` reports which root actually resolves.

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Important

No need to edit the changelog ever, it's generated automatically.

## Daily Maintenance

Run a daily version check across all package manifests and upgrade every dependency to its latest version — including major version bumps. Staying on the latest is the goal; do not skip majors.

- Check `package.json` (root) and all nested `package.json` files (e.g. `plugin/`, `openclaw/`) for outdated dependencies via `npm outdated`.
- Upgrade every package to `latest` (use `npm install <pkg>@latest` for each, or `npx npm-check-updates -u && npm install`). Bump majors too.
- Run `npm audit fix` to resolve advisories.
- After upgrades, run `npm run build-and-sync` and verify the worker starts and tests pass. Fix any breakage caused by major bumps in the same change.
- Commit the updated `package.json` and `package-lock.json` files.
