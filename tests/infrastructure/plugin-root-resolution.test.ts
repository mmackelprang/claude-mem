import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';
import { buildShellCommand } from '../../src/build/hook-shell-template.js';

const require = createRequire(import.meta.url);
const resolver = require('../../scripts/lib/resolve-plugin-root.cjs');

const WORKER_FILES = ['bun-runner.js', 'worker-service.cjs'];

let configDir: string;
let originalConfigDir: string | undefined;
let originalPluginRoot: string | undefined;

/** Create a plugin root with the files the hook's `[ -f ... ]` clauses require. */
function makeRoot(dir: string, marker: string) {
  const scripts = path.join(dir, 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const file of WORKER_FILES) {
    writeFileSync(path.join(scripts, file), `// ${marker}\n`);
  }
  return dir;
}

function touch(dir: string, whenMs: number) {
  const when = new Date(whenMs);
  utimesSync(dir, when, when);
}

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'plugin-root-'));
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  if (originalPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
  rmSync(configDir, { recursive: true, force: true });
});

function cacheVersionDir(version: string) {
  return path.join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem', version);
}

function marketplacePluginDir() {
  return path.join(configDir, 'plugins', 'marketplaces', 'thedotmack', 'plugin');
}

describe('resolvePluginRoot', () => {
  it('prefers a cache dir over the marketplace install', () => {
    makeRoot(cacheVersionDir('13.9.2'), 'cache');
    makeRoot(marketplacePluginDir(), 'marketplace');

    const resolved = resolver.resolvePluginRoot({ requireFiles: WORKER_FILES });

    expect(resolved?.source).toBe('cache');
    expect(resolved?.root).toBe(cacheVersionDir('13.9.2'));
  });

  it('picks the newest cache dir by mtime, not the highest version number', () => {
    const older = makeRoot(cacheVersionDir('13.11.0'), 'newer-version-older-mtime');
    const newer = makeRoot(cacheVersionDir('13.9.2'), 'older-version-newer-mtime');
    touch(older, Date.now() - 60_000);
    touch(newer, Date.now());

    const resolved = resolver.resolvePluginRoot({ requireFiles: WORKER_FILES });

    expect(resolved?.root).toBe(cacheVersionDir('13.9.2'));
  });

  it('lets CLAUDE_PLUGIN_ROOT outrank both cache and marketplace', () => {
    makeRoot(cacheVersionDir('13.9.2'), 'cache');
    makeRoot(marketplacePluginDir(), 'marketplace');
    const repo = makeRoot(path.join(configDir, 'repo', 'plugin'), 'repo');

    const resolved = resolver.resolvePluginRoot({
      requireFiles: WORKER_FILES,
      env: { CLAUDE_PLUGIN_ROOT: repo },
    });

    expect(resolved?.source).toBe('env');
    expect(resolved?.root).toBe(repo);
  });

  it('skips candidates missing a required script', () => {
    // Cache dir has bun-runner.js but no worker-service.cjs → must not win.
    const partial = path.join(cacheVersionDir('13.9.2'), 'scripts');
    mkdirSync(partial, { recursive: true });
    writeFileSync(path.join(partial, 'bun-runner.js'), '// partial');
    makeRoot(marketplacePluginDir(), 'marketplace');

    const resolved = resolver.resolvePluginRoot({ requireFiles: WORKER_FILES });

    expect(resolved?.source).toBe('marketplace');
  });

  it('returns null when nothing resolves', () => {
    expect(resolver.resolvePluginRoot({ requireFiles: WORKER_FILES })).toBeNull();
  });

  it('unwraps a <root>/plugin nesting like the prelude does', () => {
    makeRoot(path.join(cacheVersionDir('13.9.2'), 'plugin'), 'nested');

    const resolved = resolver.resolvePluginRoot({ requireFiles: WORKER_FILES });

    expect(resolved?.root).toBe(path.join(cacheVersionDir('13.9.2'), 'plugin'));
  });
});

describe('fingerprintPluginRoot', () => {
  it('distinguishes two roots that differ only in script CONTENT', () => {
    // The real case this guards: a fork build and the upstream release it
    // descends from can both report version 13.9.2. Only content separates them.
    const a = makeRoot(path.join(configDir, 'a'), 'fork build');
    const b = makeRoot(path.join(configDir, 'b'), 'upstream build');

    expect(resolver.fingerprintPluginRoot(a)).not.toBe(resolver.fingerprintPluginRoot(b));
  });

  it('is stable for identical content', () => {
    const a = makeRoot(path.join(configDir, 'a'), 'same');
    const b = makeRoot(path.join(configDir, 'b'), 'same');

    expect(resolver.fingerprintPluginRoot(a)).toBe(resolver.fingerprintPluginRoot(b));
  });

  it('returns null for a root with no scripts', () => {
    mkdirSync(path.join(configDir, 'empty'), { recursive: true });
    expect(resolver.fingerprintPluginRoot(path.join(configDir, 'empty'))).toBeNull();
  });
});

/**
 * The resolver is a Node MIRROR of the shell prelude's contractual fallback
 * order (src/build/hook-shell-template.ts: "The fallback chain ORDER is
 * contractual and must not change"). If the prelude's order is ever edited,
 * this test fails and points at the resolver that must be edited with it —
 * otherwise the delivery guard would validate a different chain than the hooks
 * actually use, and cheerfully pass while the hooks load something else.
 */
describe('resolver agrees with the hook shell template', () => {
  const command = buildShellCommand({
    host: 'claude-code',
    requireFile: 'bun-runner.js',
    requireFileSecondary: 'worker-service.cjs',
    trailingCommand: ['echo'],
    notFoundMessage: 'not found',
  });

  it('uses the same three sources in the same order', () => {
    const envIdx = command.indexOf('CLAUDE_PLUGIN_ROOT');
    const cacheIdx = command.indexOf('plugins/cache/thedotmack/claude-mem');
    const marketIdx = command.indexOf('plugins/marketplaces/thedotmack/plugin');

    expect(envIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeGreaterThan(envIdx);
    expect(marketIdx).toBeGreaterThan(cacheIdx);

    makeRoot(cacheVersionDir('13.9.2'), 'cache');
    makeRoot(marketplacePluginDir(), 'marketplace');
    const roots = resolver.candidateRoots({ env: { CLAUDE_PLUGIN_ROOT: '/injected' } });

    expect(roots[0]).toBe('/injected');
    expect(roots[1]).toBe(cacheVersionDir('13.9.2'));
    expect(roots[roots.length - 1]).toBe(marketplacePluginDir());
  });

  it('sorts cache dirs newest-first, matching `ls -dt`', () => {
    expect(command).toContain('ls -dt');
    expect(command).toContain('/[0-9]*/');
  });

  it('requires both worker scripts, matching the prelude -f clauses', () => {
    expect(command).toContain('[ -f "$_Q/scripts/bun-runner.js" ]');
    expect(command).toContain('[ -f "$_Q/scripts/worker-service.cjs" ]');
    expect(resolver.WORKER_REQUIRE_FILES).toEqual(['bun-runner.js', 'worker-service.cjs']);
  });
});
