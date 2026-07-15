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
