'use strict';

/**
 * resolve-plugin-root.cjs — answer "which plugin directory will the hooks
 * actually load?" from Node, using the same contractual fallback chain the
 * generated shell prelude uses.
 *
 * The chain is defined once in `src/build/hook-shell-template.ts` and is
 * explicitly contractual ("The fallback chain ORDER is contractual and must not
 * change"); `tests/infrastructure/plugin-distribution.test.ts` pins the emitted
 * command strings byte-for-byte. This module MIRRORS that order for tooling —
 * it does not define it. If the template's order ever changes, this must change
 * with it, and `tests/infrastructure/plugin-root-resolution.test.ts` asserts the
 * two stay in agreement.
 *
 * Order:
 *   1. $CLAUDE_PLUGIN_ROOT / $PLUGIN_ROOT   (host-injected env)
 *   2. <config>/plugins/cache/thedotmack/claude-mem/<v>/   newest mtime first
 *   3. <config>/plugins/marketplaces/thedotmack/plugin     (marketplace install)
 *
 * A candidate only counts if every `requireFiles` entry exists under its
 * `scripts/`, matching the prelude's `[ -f "$_Q/scripts/X" ]` test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** Files the worker hooks require; mirrors the hooks.json `[ -f ... ]` clauses. */
const WORKER_REQUIRE_FILES = ['bun-runner.js', 'worker-service.cjs'];

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function cacheRoot() {
  return path.join(configDir(), 'plugins', 'cache', 'thedotmack', 'claude-mem');
}

function marketplaceRoot() {
  return path.join(configDir(), 'plugins', 'marketplaces', 'thedotmack');
}

// Version-ish cache dirs, newest mtime first — the Node twin of the prelude's
// mtime-sorted `ls -dt` over the cache root's numeric-prefixed version dirs.
function listCacheDirsNewestFirst(root = cacheRoot()) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[0-9]/.test(name))
    .map((name) => path.join(root, name))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * The prelude accepts either `<root>` or `<root>/plugin`, preferring the latter
 * when it holds a `scripts/` dir:
 *   [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R"
 */
function normalizeCandidate(candidate) {
  const nested = path.join(candidate, 'plugin', 'scripts');
  try {
    if (fs.statSync(nested).isDirectory()) return path.join(candidate, 'plugin');
  } catch {
    /* fall through */
  }
  return candidate;
}

/** Ordered candidate roots, before the requireFiles filter. */
function candidateRoots({ env = process.env } = {}) {
  const injected = env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT || '';
  return [
    ...(injected ? [injected] : []),
    ...listCacheDirsNewestFirst(),
    path.join(marketplaceRoot(), 'plugin'),
  ];
}

/**
 * @returns {{root: string, source: 'env'|'cache'|'marketplace', candidate: string}|null}
 */
function resolvePluginRoot({ requireFiles = WORKER_REQUIRE_FILES, env = process.env } = {}) {
  const injected = env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT || '';
  const cacheDirs = listCacheDirsNewestFirst();

  for (const candidate of candidateRoots({ env })) {
    const root = normalizeCandidate(candidate);
    const ok = requireFiles.every((file) => fs.existsSync(path.join(root, 'scripts', file)));
    if (!ok) continue;

    let source = 'marketplace';
    if (injected && candidate === injected) source = 'env';
    else if (cacheDirs.includes(candidate)) source = 'cache';

    return { root, source, candidate };
  }
  return null;
}

/**
 * Content fingerprint of a plugin root's `scripts/` JS surface.
 *
 * Deliberately content-based, NOT version-based: two builds can carry the same
 * `plugin.json` version and different code (e.g. a fork build and the upstream
 * release it forked from both report 13.9.2), so a version check cannot tell
 * you which one is installed. The hash can.
 */
function fingerprintPluginRoot(root) {
  const scriptsDir = path.join(root, 'scripts');
  let names;
  try {
    names = fs.readdirSync(scriptsDir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith('.js') || n.endsWith('.cjs')).sort();
  if (files.length === 0) return null;

  const hash = crypto.createHash('sha256');
  for (const name of files) {
    hash.update(name);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(scriptsDir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = {
  WORKER_REQUIRE_FILES,
  configDir,
  cacheRoot,
  marketplaceRoot,
  listCacheDirsNewestFirst,
  normalizeCandidate,
  candidateRoots,
  resolvePluginRoot,
  fingerprintPluginRoot,
};
