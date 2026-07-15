#!/usr/bin/env node
'use strict';

/**
 * verify-plugin-delivery.cjs — assert the build we just synced is the build the
 * hooks will actually load.
 *
 * The silent failure this exists to prevent: `npm run build-and-sync` reported
 * success (or failed in a step whose error nobody read) while the hooks kept
 * loading a months-old plugin from a cache directory the sync never touched.
 * Nothing compared "what we built" against "what runs", so the two drifted for
 * weeks with no signal.
 *
 * Guard shape follows `assertPluginRelativeRequiresResolve()` in
 * scripts/build-hooks.js: a cheap, deterministic post-build assertion that turns
 * an invisible packaging bug into a loud build failure.
 *
 * The comparison is a CONTENT HASH, not a version string, and that distinction
 * is the whole point: a fork build and the upstream release it descends from can
 * both report the same `plugin.json` version while containing different code, so
 * a version check would happily pass on a stale install.
 */

const path = require('path');
const {
  resolvePluginRoot,
  fingerprintPluginRoot,
  listCacheDirsNewestFirst,
  WORKER_REQUIRE_FILES,
} = require('./lib/resolve-plugin-root.cjs');

const REPO_PLUGIN_DIR = path.join(__dirname, '..', 'plugin');

function formatCandidates() {
  const dirs = listCacheDirsNewestFirst();
  if (dirs.length === 0) return '    (no cache directories)';
  return dirs.map((dir, i) => `    ${i + 1}. ${dir}`).join('\n');
}

/**
 * @param {object} options
 * @param {string} [options.expectedRoot] Root the sync intended to deliver to.
 * @returns {{root:string, source:string, fingerprint:string}}
 */
function assertPluginDelivered({ expectedRoot } = {}) {
  const built = fingerprintPluginRoot(REPO_PLUGIN_DIR);
  if (!built) {
    throw new Error(
      `Plugin delivery guard FAILED — no built scripts found under ${path.join(REPO_PLUGIN_DIR, 'scripts')}. ` +
        'Run `npm run build` first.'
    );
  }

  const resolved = resolvePluginRoot({ requireFiles: WORKER_REQUIRE_FILES });
  if (!resolved) {
    throw new Error(
      'Plugin delivery guard FAILED — no installed plugin root resolves at all.\n' +
        `  Required under <root>/scripts/: ${WORKER_REQUIRE_FILES.join(', ')}\n` +
        '  The hooks would also fail to find the plugin.'
    );
  }

  const delivered = fingerprintPluginRoot(resolved.root);

  if (delivered !== built) {
    throw new Error(
      'Plugin delivery guard FAILED — the hooks will NOT load the build you just made.\n' +
        `  built (repo):       ${REPO_PLUGIN_DIR}\n` +
        `                      sha256 ${built.slice(0, 16)}…\n` +
        `  hooks will load:    ${resolved.root}  [via ${resolved.source}]\n` +
        `                      sha256 ${delivered ? delivered.slice(0, 16) + '…' : '(no scripts)'}\n` +
        (expectedRoot && path.resolve(expectedRoot) !== path.resolve(resolved.root)
          ? `  sync targeted:      ${expectedRoot}\n` +
            '                      — a DIFFERENT directory outranks it in the resolution chain.\n'
          : '') +
        '  cache candidates (newest mtime first — first match wins):\n' +
        formatCandidates() +
        '\n' +
        '  Fix: sync into the winning root, or clear the stale cache dir that outranks it.'
    );
  }

  return { root: resolved.root, source: resolved.source, fingerprint: built };
}

module.exports = { assertPluginDelivered, REPO_PLUGIN_DIR };

if (require.main === module) {
  try {
    const result = assertPluginDelivered();
    console.log('\x1b[32m%s\x1b[0m', '✓ Plugin delivery guard: hooks will load the current build');
    console.log(`  root:        ${result.root}  [via ${result.source}]`);
    console.log(`  fingerprint: sha256 ${result.fingerprint.slice(0, 16)}…`);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', error.message);
    process.exit(1);
  }
}
