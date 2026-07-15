'use strict';

/**
 * mirror.cjs — cross-platform replacement for the `rsync -av --delete` calls
 * that `scripts/sync-marketplace.cjs` used to shell out to.
 *
 * WHY: rsync is not present on Windows (no Git-Bash package ships it by
 * default), so `npm run build-and-sync` — the command CLAUDE.md documents as
 * *the* build entry point, on a platform CLAUDE.md lists as supported — died at
 * the first `execSync`. The `&&` chain then skipped both the cache sync and the
 * worker restart, so a Windows dev's build was never delivered to the running
 * plugin at all.
 *
 * The two semantics of `rsync -av --delete --exclude=P` that callers depend on,
 * and that this module reproduces:
 *
 *   1. An excluded path is not COPIED from src.
 *   2. An excluded path is not DELETED from dest. This is rsync's default
 *      (`--delete` alone never removes excluded files; that needs
 *      `--delete-excluded`). It is load-bearing here and easy to get wrong: the
 *      marketplace target is a git checkout whose `.git/` and 494 MB
 *      `node_modules/` survive syncs ONLY because they are excluded. A naive
 *      "copy src, delete everything in dest that isn't in src" mirror wipes
 *      both.
 *
 * Symlinks/junctions are never followed — neither when walking src nor when
 * pruning dest. Recursing through a Windows junction is how a `node_modules`
 * tree gets destroyed by a tool that only meant to clean a directory.
 */

const fs = require('fs');
const path = require('path');

/** Escape regex metacharacters that are literal in a glob. */
function escapeLiteral(char) {
  return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a glob body to a regex source string.
 * `**` spans separators; `*` and `?` stop at one.
 */
function globToRegExpSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeLiteral(c);
    }
  }
  return out;
}

/**
 * Compile rsync/gitignore-style exclude patterns into a matcher.
 *
 * Supported subset (covers every pattern the sync scripts pass):
 *   - trailing `/`            → directory-only rule
 *   - leading `/`             → anchored at the transfer root
 *   - no interior `/`         → matches the BASENAME at any depth (`*.log`)
 *   - interior `/`            → matches the relative path, at any component
 *                               boundary (`.claude/agents`, `plugin/data`)
 *   - a leading double-star segment also matches at the root
 *
 * @param {string[]} patterns
 * @returns {(relPath: string, isDir: boolean) => boolean}
 */
function compileExcludes(patterns) {
  const rules = [];

  for (const raw of patterns) {
    if (!raw) continue;
    let p = String(raw).trim();
    if (!p || p.startsWith('#')) continue;

    let dirOnly = false;
    if (p.endsWith('/')) {
      dirOnly = true;
      p = p.slice(0, -1);
    }
    if (!p) continue;

    let anchored = false;
    if (p.startsWith('/')) {
      anchored = true;
      p = p.slice(1);
    }
    if (!p) continue;

    let source;
    if (p.startsWith('**/')) {
      // `**/x` must also match a bare `x` at the root.
      source = `(?:.*/)?${globToRegExpSource(p.slice(3))}`;
      anchored = true;
    } else if (p.includes('/')) {
      source = globToRegExpSource(p);
    } else {
      source = globToRegExpSource(p);
    }

    const prefix = anchored ? '^' : '(^|/)';
    rules.push({ re: new RegExp(`${prefix}${source}$`), dirOnly });
  }

  return function isExcluded(relPath, isDir) {
    const norm = String(relPath).split(path.sep).join('/');
    if (!norm) return false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(norm)) return true;
    }
    return false;
  };
}

/** Parse a .gitignore into exclude patterns (negations are not supported). */
function readGitignorePatterns(baseDir) {
  const file = path.join(baseDir, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}

/**
 * Tolerance for the mtime quick-check, in milliseconds.
 *
 * NTFS timestamps have sub-millisecond resolution (e.g. mtimeMs
 * 1784138421773.9375), but `fs.utimesSync` takes a `Date`, which carries only
 * whole milliseconds — so the mtime we stamp on the copy is the source's mtime
 * rounded (…773.9375 → …774). Comparing exactly (or with `Math.floor`) then
 * reports every single file as changed on the next run, and the "incremental"
 * sync re-copies the entire tree every time, forever.
 *
 * The discrepancy is bounded by the rounding we ourselves perform, so treating
 * mtimes equal at millisecond resolution is exact for our purposes, not a fudge.
 */
const MTIME_TOLERANCE_MS = 1;

function sameMtime(a, b) {
  return Math.abs(a.mtimeMs - b.mtimeMs) <= MTIME_TOLERANCE_MS;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** Remove a path without ever recursing through a symlink/junction. */
function removeEntry(target, stat) {
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch {
      // A Windows directory junction needs rmdir, not unlink.
      fs.rmdirSync(target);
    }
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Mirror `src` onto `dest` with rsync `-a --delete` semantics for the subset
 * this repo uses.
 *
 * @returns {{copied:number, deleted:number, preserved:number, skipped:string[]}}
 */
function mirror({ src, dest, isExcluded = () => false }) {
  if (!fs.existsSync(src)) {
    throw new Error(`mirror: source does not exist: ${src}`);
  }
  fs.mkdirSync(dest, { recursive: true });

  const stats = { copied: 0, deleted: 0, preserved: 0, skipped: [] };

  /**
   * Protection test for the PRUNE pass — deliberately type-agnostic.
   *
   * The copy pass asks `isExcluded(rel, isDir)` with the real type, so a
   * directory-only rule (`plugin/data/`) correctly declines to match a file.
   * Reusing that for prune would be a trap: there, `isDir` comes from whatever
   * currently occupies the name in DEST. If `plugin/data` is a junction or a
   * stray file rather than a real directory, a `dirOnly` rule stops matching,
   * the path loses its protection, and we delete data the exclude list exists
   * to preserve. Asking "would ANY rule match this name, as a file or as a
   * directory?" removes the type from the decision entirely.
   *
   * This is intentionally MORE conservative than rsync, which would delete a
   * file named `data` despite an `--exclude=data/` rule. Refusing to delete a
   * path the caller named is the safe direction to err in a tool that prunes a
   * live install; the cost is only that a protected name is never reclaimed.
   */
  const isProtected = (rel) => isExcluded(rel, true) || isExcluded(rel, false);

  /**
   * Delete one dest-only entry, preserving anything protected at or beneath it.
   *
   * A flat "not in src → rm -rf" prune has a hole: a dest-only DIRECTORY is
   * removed wholesale, taking any protected descendants with it. The exclude
   * list names `plugin/data`, not `plugin`, so `plugin` itself looks
   * unprotected — deleting it destroys `plugin/data` anyway. That only stays
   * hidden while the parent happens to exist in src (as `plugin/` does today);
   * it becomes data loss the moment it doesn't. rsync has the same rule: it
   * will not remove a directory that still holds protected content.
   *
   * Symlinks/junctions are removed as links and never recursed into, so a
   * junction pointing outside the tree can never leak this deletion to its
   * target.
   *
   * @returns {boolean} true if the entry was KEPT (protected, or holds
   *   protected content), false if it was deleted.
   */
  function pruneDestEntry(fullPath, rel, st) {
    if (isProtected(rel)) {
      stats.preserved++;
      return true;
    }

    if (st.isSymbolicLink() || !st.isDirectory()) {
      removeEntry(fullPath, st);
      stats.deleted++;
      return false;
    }

    let children;
    try {
      children = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch {
      children = [];
    }

    let keptAny = false;
    for (const child of children) {
      const childFull = path.join(fullPath, child.name);
      const childSt = lstatOrNull(childFull);
      if (!childSt) continue;
      if (pruneDestEntry(childFull, `${rel}/${child.name}`, childSt)) keptAny = true;
    }

    if (keptAny) return true;

    fs.rmdirSync(fullPath);
    stats.deleted++;
    return false;
  }

  function walk(rel) {
    const srcDir = rel ? path.join(src, rel) : src;
    const destDir = rel ? path.join(dest, rel) : dest;

    const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
    const srcNames = new Set(srcEntries.map((e) => e.name));

    // --- prune: delete dest entries absent from src, EXCEPT excluded ones.
    let destEntries = [];
    try {
      destEntries = fs.readdirSync(destDir, { withFileTypes: true });
    } catch {
      destEntries = [];
    }
    for (const entry of destEntries) {
      if (srcNames.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(destDir, entry.name);
      const st = lstatOrNull(full);
      if (!st) continue;
      pruneDestEntry(full, childRel, st);
    }

    // --- copy: src → dest, skipping excluded entries.
    for (const entry of srcEntries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      const st = lstatOrNull(srcPath);
      if (!st) continue;

      const isSymlink = st.isSymbolicLink();
      const isDir = st.isDirectory() && !isSymlink;

      if (isExcluded(childRel, isDir)) continue;

      if (isSymlink) {
        // Never follow. Recreating links reliably on Windows needs privileges
        // we may not have, so record and move on rather than guess.
        stats.skipped.push(childRel);
        continue;
      }

      const destStat = lstatOrNull(destPath);

      if (isDir) {
        // Replace a non-directory sitting where a directory belongs.
        if (destStat && (!destStat.isDirectory() || destStat.isSymbolicLink())) {
          removeEntry(destPath, destStat);
        }
        fs.mkdirSync(destPath, { recursive: true });
        walk(childRel);
        continue;
      }

      if (destStat && (destStat.isDirectory() || destStat.isSymbolicLink())) {
        removeEntry(destPath, destStat);
      }

      // Skip unchanged files (rsync's size+mtime quick check).
      if (destStat && destStat.isFile() && destStat.size === st.size && sameMtime(destStat, st)) {
        continue;
      }

      fs.copyFileSync(srcPath, destPath);
      fs.utimesSync(destPath, st.atime, st.mtime);
      stats.copied++;
    }
  }

  walk('');
  return stats;
}

module.exports = { mirror, compileExcludes, readGitignorePatterns };
