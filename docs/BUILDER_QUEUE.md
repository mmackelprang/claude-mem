# Builder Queue

> Work items scoped + planned by Planner, ready for Builder to ship one PR per row.
> Builder: branch from `main`, implement per the linked plan, run all gates in the plan's § Verification,
> open a PR, and (per the auto-merge policy) merge on green. Do not re-plan — surface drift instead.
>
> **Last updated:** 2026-07-02 (Planner)

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

_(none yet)_
