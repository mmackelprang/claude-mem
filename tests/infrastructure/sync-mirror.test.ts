import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mirror, compileExcludes } = require('../../scripts/lib/mirror.cjs');

let root: string;
let src: string;
let dest: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mirror-test-'));
  src = path.join(root, 'src');
  dest = path.join(root, 'dest');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(base: string, rel: string, content = 'x') {
  const full = path.join(base, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('compileExcludes', () => {
  it('matches a bare basename pattern at any depth', () => {
    const ex = compileExcludes(['*.log']);
    expect(ex('a.log', false)).toBe(true);
    expect(ex('deep/nested/a.log', false)).toBe(true);
    expect(ex('a.txt', false)).toBe(false);
  });

  it('honours directory-only patterns', () => {
    const ex = compileExcludes(['node_modules/']);
    expect(ex('node_modules', true)).toBe(true);
    expect(ex('pkg/node_modules', true)).toBe(true);
    // A *file* named node_modules is not matched by a dir-only rule.
    expect(ex('node_modules', false)).toBe(false);
  });

  it('matches path patterns containing a separator', () => {
    const ex = compileExcludes(['.claude/agents/', 'plugin/data/']);
    expect(ex('.claude/agents', true)).toBe(true);
    expect(ex('plugin/data', true)).toBe(true);
    expect(ex('.claude/skills', true)).toBe(false);
  });

  it('treats ** as spanning separators, including at the root', () => {
    const ex = compileExcludes(['**/_tree-sitter/']);
    expect(ex('_tree-sitter', true)).toBe(true);
    expect(ex('a/b/_tree-sitter', true)).toBe(true);
  });

  it('does not let * cross a separator', () => {
    const ex = compileExcludes(['dist/*']);
    expect(ex('dist/a', false)).toBe(true);
    expect(ex('dist/a/b', false)).toBe(false);
  });
});

describe('mirror', () => {
  it('copies files and nested directories', () => {
    write(src, 'a.txt', 'hello');
    write(src, 'nested/b.txt', 'world');

    mirror({ src, dest, isExcluded: () => false });

    expect(readFileSync(path.join(dest, 'a.txt'), 'utf-8')).toBe('hello');
    expect(readFileSync(path.join(dest, 'nested/b.txt'), 'utf-8')).toBe('world');
  });

  it('deletes dest entries that are absent from src (--delete)', () => {
    write(src, 'keep.txt');
    write(dest, 'keep.txt');
    write(dest, 'stale.txt');
    write(dest, 'stale-dir/x.txt');

    mirror({ src, dest, isExcluded: () => false });

    expect(existsSync(path.join(dest, 'keep.txt'))).toBe(true);
    expect(existsSync(path.join(dest, 'stale.txt'))).toBe(false);
    expect(existsSync(path.join(dest, 'stale-dir'))).toBe(false);
  });

  /**
   * The regression that matters most. `rsync --delete --exclude=P` does NOT
   * delete P from the destination — excluding a path protects it. The
   * marketplace target is a git checkout whose .git/ and 494 MB node_modules/
   * exist ONLY in dest; a mirror that treats "not in src" as "delete" destroys
   * both, and `bun install` cannot bring .git back.
   */
  it('PROTECTS excluded dest entries from deletion even when absent from src', () => {
    write(src, 'a.txt');
    write(dest, '.git/HEAD', 'ref: refs/heads/main');
    write(dest, 'node_modules/pkg/index.js', 'module.exports={}');
    write(dest, '.in_use/12345', 'session');
    write(dest, 'stale.txt');

    const stats = mirror({
      src,
      dest,
      isExcluded: compileExcludes(['.git', 'node_modules', '.in_use']),
    });

    expect(existsSync(path.join(dest, '.git/HEAD'))).toBe(true);
    expect(existsSync(path.join(dest, 'node_modules/pkg/index.js'))).toBe(true);
    expect(existsSync(path.join(dest, '.in_use/12345'))).toBe(true);
    expect(existsSync(path.join(dest, 'stale.txt'))).toBe(false);
    expect(stats.preserved).toBeGreaterThanOrEqual(3);
  });

  it('does not copy excluded src entries', () => {
    write(src, 'a.txt');
    write(src, 'node_modules/huge/index.js');

    mirror({ src, dest, isExcluded: compileExcludes(['node_modules']) });

    expect(existsSync(path.join(dest, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(dest, 'node_modules'))).toBe(false);
  });

  it('replaces a dest file with a src directory of the same name', () => {
    write(src, 'thing/x.txt', 'dir now');
    write(dest, 'thing', 'was a file');

    mirror({ src, dest, isExcluded: () => false });

    expect(readFileSync(path.join(dest, 'thing/x.txt'), 'utf-8')).toBe('dir now');
  });

  it('skips symlinks in src rather than following them', () => {
    write(src, 'real/data.txt', 'real');
    let linked = false;
    try {
      symlinkSync(path.join(src, 'real'), path.join(src, 'link'), 'junction');
      linked = true;
    } catch {
      // Unprivileged Windows sessions cannot create links; nothing to assert.
    }
    if (!linked) return;

    const stats = mirror({ src, dest, isExcluded: () => false });

    expect(stats.skipped).toContain('link');
    expect(existsSync(path.join(dest, 'real/data.txt'))).toBe(true);
  });

  it('is idempotent — a second run copies nothing new', () => {
    write(src, 'a.txt', 'hello');
    write(src, 'nested/b.txt', 'world');

    mirror({ src, dest, isExcluded: () => false });
    const second = mirror({ src, dest, isExcluded: () => false });

    expect(second.copied).toBe(0);
    expect(second.deleted).toBe(0);
  });

  /**
   * NTFS records sub-millisecond mtimes, but `fs.utimesSync` only accepts a
   * Date (whole ms), so the copy's mtime is the source's mtime rounded. An
   * exact/floor comparison therefore judges every file changed and re-copies
   * the whole tree on every sync. Files created by writeFileSync often land on
   * a whole millisecond, which hides this — so force a fractional mtime.
   */
  it('treats a sub-millisecond mtime difference as unchanged (no full re-copy)', () => {
    write(src, 'a.txt', 'hello');
    const target = path.join(src, 'a.txt');
    const fractionalSeconds = Math.floor(Date.now() / 1000) + 0.7739375;
    utimesSync(target, fractionalSeconds, fractionalSeconds);

    const first = mirror({ src, dest, isExcluded: () => false });
    expect(first.copied).toBe(1);

    const second = mirror({ src, dest, isExcluded: () => false });
    expect(second.copied).toBe(0);
  });

  it('still re-copies when contents genuinely change', () => {
    write(src, 'a.txt', 'v1');
    mirror({ src, dest, isExcluded: () => false });

    const later = Math.floor(Date.now() / 1000) + 5;
    write(src, 'a.txt', 'v2-longer');
    utimesSync(path.join(src, 'a.txt'), later, later);

    const second = mirror({ src, dest, isExcluded: () => false });

    expect(second.copied).toBe(1);
    expect(readFileSync(path.join(dest, 'a.txt'), 'utf-8')).toBe('v2-longer');
  });

  it('throws when src does not exist rather than silently doing nothing', () => {
    expect(() => mirror({ src: path.join(root, 'nope'), dest, isExcluded: () => false })).toThrow(
      /source does not exist/
    );
  });
});
