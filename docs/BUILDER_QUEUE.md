# Builder Queue

> Work items scoped + planned by Planner, ready for Builder to ship one PR per row.
> Builder: branch from `main`, implement per the linked plan, run all gates in the plan's § Verification,
> open a PR, and (per the auto-merge policy) merge on green. Do not re-plan — surface drift instead.
>
> **Last updated:** 2026-07-15 (Builder)

## Legend

- 📋 queued · 🚧 in flight · ✅ shipped · ⛔ blocked

## Queue

| # | Status | Item | Spec + Plan | Depends on | Notes |
|---|--------|------|-------------|------------|-------|
| 1 | 📋 | **Fix observation → Chroma vector sync packaging bug** — ship `plugin/sqlite/SessionStore.js` + inline `parseFileList`; add a static packaging guard; make MODULE_NOT_FOUND-class errors visible. Consolidates PRs #3102/#3108/#3116; closes #3091/#3092/#3107. | [`docs/bug-fixes/2026-07-02-chroma-observation-sync-packaging.md`](bug-fixes/2026-07-02-chroma-observation-sync-packaging.md) | — | Fresh consolidated branch, `Co-authored-by:` bionicbutterfly13 + KaizenPrompt + Garcia6l20. **Hybrid** approach: B (static-inline) for `parseFileList`, A (emit + `files` allowlist) for `SessionStore`. **Exclude** #3116's folder-`CLAUDE.md`/`HybridSearchStrategy` changes → item #2. High severity (headline feature broken on every 13.9.x install). |

## Backlog (not yet planned — needs a Planner pass)

| # | Item | Origin | Notes |
|---|------|--------|-------|
| 2 | Empty folder `CLAUDE.md` + `HybridSearchStrategy.isFolder` / metadata-fallback fix | Split out of PR #3116 (Garcia6l20) | Query folder observations by project-relative path; forward `isFolder` through `HybridSearchStrategy.findByFile`; return full metadata on file/folder lookups regardless of Chroma state; never write empty/skeleton folder `CLAUDE.md`. Distinct bug from item #1 — needs its own spec, review, and folder-context UAT. |
| 3 | Workstream 2 — multi-user / cross-team memory (ADR-first) | `HANDOFF_multiuser_and_packaging.md` | Architecture-first; shared store, ID namespacing, author/scoping, auth, migration that does not regress single-user local mode. Investigate existing server mode (`CLAUDE_MEM_SERVER_URL`, `scripts/server-service.cjs`) before designing new. |
| 4 | Workstream 3 — validate cross-session recall empirically | `HANDOFF_multiuser_and_packaging.md` | After item #1 lands and observations flow, confirm prior-session observations are recalled/injected, `observation_search` returns `observation` docs, and project scoping holds across ≥2 projects. |

## Recently shipped

| # | Item | PR | Notes |
|---|------|----|-------|
| 5 | **`build-and-sync` never delivered a build on Windows** — three independent barriers, each fatal on its own. | #10 | See below. |

### Item #5 — the three barriers (for the record)

This was mis-scoped in earlier notes as a single "rsync is Unix-only" problem. Fixing rsync alone would
**not** have delivered the build; all three had to go:

1. **`rsync` is not installed on Windows.** `scripts/sync-marketplace.cjs` shelled out to it, so
   `build-and-sync` died at step 2. The `&&` chain then skipped the cache sync *and* the worker restart.
2. **`cd ~/…` does not work in npm's Windows shell.** Two separate sites (`bun install` inside the sync
   script, and the `build-and-sync` worker-restart tail) used `cd ~/…`. npm's default script shell on
   Windows is cmd.exe, which does not expand `~` — both failed with "The system cannot find the path
   specified." **independently of the rsync breakage**, so installing rsync would have moved the failure,
   not fixed it.
3. **Nothing verified that the sync's output is what the hooks load.** The hook resolution order
   (`$CLAUDE_PLUGIN_ROOT` → newest-mtime `cache/<version>/` → marketplace) is contractual, and
   `sync-marketplace` did already target `cache/<version>` — but no check compared the built artifact
   against the resolved one, so a sync that never ran, or landed somewhere outranked by a staler cache
   dir, was completely silent. `scripts/verify-plugin-delivery.cjs` now fails the build on any mismatch.

**Not a barrier, contrary to earlier notes:** "sync targets the marketplace dir but the cache dir wins."
`sync-marketplace.cjs` has synced to `cache/<version>` since at least `56db0681`; that step was simply
never reached because barrier 1 aborted the script first.

**Resolution-order decision:** left unchanged (option (a) — sync into the `cache/<version>` dir the hooks
already prefer). The order is pinned as contractual in `src/build/hook-shell-template.ts` and asserted
byte-for-byte by `tests/infrastructure/plugin-distribution.test.ts`. Setting a machine-wide
`CLAUDE_PLUGIN_ROOT` was rejected: it would repoint **every** Claude Code session on the box at the live
working tree, so a mid-edit or half-built state would become the running plugin for every session at once.
