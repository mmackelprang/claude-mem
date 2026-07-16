import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { runCommand } from './shell.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { logger } from '../../utils/logger.js';

/**
 * Resolve the Mission Control repository root for the filesystem- and git-backed
 * sources (velocity → docs/BUILDER_QUEUE.md + git merge series; reviews →
 * docs/superpowers/specs/** + gh pr list; questions → docs/** Open-Questions).
 *
 * Strategy (#24): env CLAUDE_MEM_PROJECT_ROOT → settings.json key →
 * `git rev-parse --show-toplevel` → null. A candidate validates iff it contains
 * docs/BUILDER_QUEUE.md (the canonical roadmap file) so a deployed worker whose
 * cwd is an upstream checkout does NOT false-resolve. A set-but-invalid
 * env/settings value logs one loud WARN and falls through to null. Memoized.
 */
function isMissionControlRepo(root: string): boolean {
  return existsSync(path.join(root, 'docs', 'BUILDER_QUEUE.md'));
}

function readSettingsProjectRoot(): string | null {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return null;
    const raw = parseJsonWithBom<Record<string, any>>(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    const settings = raw.env ?? raw;
    const val = settings.CLAUDE_MEM_PROJECT_ROOT;
    return typeof val === 'string' && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function gitToplevel(): string | null {
  const result = runCommand(['git', 'rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

function resolve(): string | null {
  const envRoot = process.env.CLAUDE_MEM_PROJECT_ROOT?.trim();
  if (envRoot) {
    if (isMissionControlRepo(envRoot)) return envRoot;
    logger.warn('WORKER',
      'CLAUDE_MEM_PROJECT_ROOT is set but does not contain docs/BUILDER_QUEUE.md — Mission Control velocity + spec/doc mining stay deferred',
      { path: envRoot });
    return null;
  }
  const settingsRoot = readSettingsProjectRoot();
  if (settingsRoot) {
    if (isMissionControlRepo(settingsRoot)) return settingsRoot;
    logger.warn('WORKER',
      'settings.json CLAUDE_MEM_PROJECT_ROOT does not contain docs/BUILDER_QUEUE.md — Mission Control velocity + spec/doc mining stay deferred',
      { path: settingsRoot });
    return null;
  }
  const top = gitToplevel();
  if (top && isMissionControlRepo(top)) return top;
  return null;
}

let cache: { root: string | null } | undefined;

export function resolveRepoRoot(): string | null {
  if (cache === undefined) cache = { root: resolve() };
  return cache.root;
}

/** Test-only: clear the memoized resolution so env/settings changes re-resolve. */
export function resetRepoRootCache(): void {
  cache = undefined;
}

/** Human-readable label for a repo-root-gated (deferred) source. */
export const REPO_ROOT_DEFERRED_REASON =
  'Deferred — needs repo-root resolution (follow-up #24)';
