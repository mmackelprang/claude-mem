import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveRepoRoot, resetRepoRootCache } from '../../src/services/mission-control/repo-root.js';
import { logger } from '../../src/utils/logger.js';

function makeRepo(withQueue: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-root-'));
  if (withQueue) {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'BUILDER_QUEUE.md'), '# Builder Queue\n');
  }
  return root;
}

const ENV_KEY = 'CLAUDE_MEM_PROJECT_ROOT';
let savedEnv: string | undefined;
const cleanup: string[] = [];

beforeEach(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; resetRepoRootCache(); });
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
  resetRepoRootCache();
  for (const dir of cleanup.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('resolveRepoRoot', () => {
  it('returns the env-var path when it contains docs/BUILDER_QUEUE.md', () => {
    const root = makeRepo(true); cleanup.push(root);
    process.env[ENV_KEY] = root; resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(root);
  });

  it('returns null (deferred) — not the wrong tree — when the env var is set but invalid', () => {
    const root = makeRepo(false); cleanup.push(root); // no docs/BUILDER_QUEUE.md
    process.env[ENV_KEY] = root; resetRepoRootCache();
    expect(resolveRepoRoot()).toBeNull();
  });

  it('logs exactly one WARN when the env var is set but invalid (loud, not silent)', () => {
    const root = makeRepo(false); cleanup.push(root);
    process.env[ENV_KEY] = root; resetRepoRootCache();
    const warn = spyOn(logger, 'warn');
    try {
      expect(resolveRepoRoot()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const [, message] = warn.mock.calls[0];
      expect(String(message)).toContain('CLAUDE_MEM_PROJECT_ROOT');
    } finally { warn.mockRestore(); }
  });

  it('memoizes: a second call does not re-resolve', () => {
    const root = makeRepo(true); cleanup.push(root);
    process.env[ENV_KEY] = root; resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(root);
    process.env[ENV_KEY] = '/nonexistent/other'; // no reset ⇒ memo must persist
    expect(resolveRepoRoot()).toBe(root);
  });

  it('returns a string-or-null terminal state when nothing is explicitly set', () => {
    resetRepoRootCache();
    const result = resolveRepoRoot();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
