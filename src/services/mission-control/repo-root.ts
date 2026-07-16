// src/services/mission-control/repo-root.ts

/**
 * Resolve the repository root for Mission Control's filesystem-backed sources:
 *   - velocity  → docs/BUILDER_QUEUE.md
 *   - reviews   → docs/superpowers/specs/** (Proposed-spec mining)
 *   - questions → docs/**                   (doc Open-Questions mining)
 *
 * DEFERRED — Backlog #24. `getPackageRoot()` returns the plugin *install* root
 * (where `plugin/` is deployed), which does NOT ship `docs/`. Reading repo docs
 * through it silently resolves the wrong tree on a deployed global worker, so we
 * gate those three sources OFF here rather than leave a dangling
 * `getPackageRoot()`-for-repo-files call. Returning `null` puts velocity in a
 * clearly-labeled "deferred" state and makes spec/doc mining a no-op (empty
 * specFiles), while the SQLite + `gh` panes ship in Phase 1.
 *
 * #24 will pick a resolution strategy (env `CLAUDE_MEM_PROJECT_ROOT` vs cwd/git
 * auto-detect vs dev-only) and implement it here — a one-function change that
 * RE-ENABLES velocity + spec/doc mining without rewriting the miner, the
 * queries, or the routes.
 */
export function resolveRepoRoot(): string | null {
  return null; // Phase 1: deferred to Backlog #24.
}

/** Human-readable label for a repo-root-gated (deferred) source. */
export const REPO_ROOT_DEFERRED_REASON =
  'Deferred — needs repo-root resolution (follow-up #24)';
