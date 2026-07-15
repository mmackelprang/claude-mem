#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');
const os = require('os');

const { mirror, compileExcludes, readGitignorePatterns } = require('./lib/mirror.cjs');
const { assertPluginDelivered } = require('./verify-plugin-delivery.cjs');
const { marketplaceRoot, cacheRoot } = require('./lib/resolve-plugin-root.cjs');

const ROOT_DIR = path.join(__dirname, '..');
const INSTALLED_PATH = marketplaceRoot();
const CACHE_BASE_PATH = cacheRoot();

/**
 * Excludes for the repo-root → marketplace mirror. These are NOT just
 * "don't copy" rules — an excluded path is also protected from deletion (see
 * scripts/lib/mirror.cjs). The marketplace target is a git checkout, so `.git`
 * and `node_modules` surviving the sync depends on them being listed here.
 */
const MARKETPLACE_EXCLUDES = [
  '.git',
  'bun.lock',
  'package-lock.json',
  'scripts/package.json',
  'scripts/node_modules',
];

/**
 * Excludes for the plugin/ → cache/<version> mirror.
 *
 * The rsync this replaced passed only `--exclude=.git` here (plugin/ has no
 * .gitignore, so the gitignore-derived list was empty). Two deliberate
 * additions, because the literal behaviour is harmful on a live install:
 *
 *   - node_modules: plugin/node_modules is ~494 MB. Copying it on every build
 *     is pure waste — the `bun install` below reconstructs it in place, and
 *     excluding it also protects the cache's existing tree from the prune.
 *   - .in_use: a directory of PID-named lockfiles the host writes to mark which
 *     live sessions are using this cache version. It does not exist in plugin/,
 *     so an unprotected prune DELETES it — dropping the host's reference count
 *     for a version that sessions are actively running out of.
 */
const CACHE_EXCLUDES = ['.git', 'node_modules', '.in_use'];

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) return null;
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(ROOT_DIR, 'plugin', '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(pluginJsonPath, 'utf-8')).version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', `Failed to read plugin version: ${error.message}`);
    process.exit(1);
  }
}

function summarize(label, stats) {
  const parts = [`${stats.copied} copied`, `${stats.deleted} deleted`, `${stats.preserved} preserved`];
  console.log(`  ${label}: ${parts.join(', ')}`);
  if (stats.skipped.length > 0) {
    console.log(`  ${label}: skipped ${stats.skipped.length} symlink(s): ${stats.skipped.slice(0, 5).join(', ')}`);
  }
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Syncing would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use the claude-mem UI on the configured worker port to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force sync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

try {
  const version = getPluginVersion();
  const cacheVersionPath = path.join(CACHE_BASE_PATH, version);

  console.log(`Syncing repo → marketplace (${INSTALLED_PATH})...`);
  summarize(
    'marketplace',
    mirror({
      src: ROOT_DIR,
      dest: INSTALLED_PATH,
      isExcluded: compileExcludes([...MARKETPLACE_EXCLUDES, ...readGitignorePatterns(ROOT_DIR)]),
    })
  );

  console.log('Running bun install in marketplace...');
  // Was: execSync('cd ~/.claude/... && bun install'). `~` is a shell-ism that
  // cmd.exe — npm's default script shell on Windows — does not expand, so this
  // failed with "The system cannot find the path specified." even once rsync
  // was out of the picture. Pass an absolute cwd instead of asking a shell.
  execFileSync('bun', ['install'], { cwd: INSTALLED_PATH, stdio: 'inherit', shell: true });

  console.log(`Syncing plugin → cache (${cacheVersionPath})...`);
  summarize(
    'cache',
    mirror({
      src: path.join(ROOT_DIR, 'plugin'),
      dest: cacheVersionPath,
      isExcluded: compileExcludes([...CACHE_EXCLUDES, ...readGitignorePatterns(path.join(ROOT_DIR, 'plugin'))]),
    })
  );

  console.log(`Running bun install in cache (version ${version})...`);
  execFileSync('bun', ['install'], { cwd: cacheVersionPath, stdio: 'inherit', shell: true });

  // The sync is only "done" if the hooks will actually load what we just wrote.
  // Copying files to a directory nothing reads is the failure mode this catches.
  const delivered = assertPluginDelivered({ expectedRoot: cacheVersionPath });

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');
  console.log(`  hooks will load: ${delivered.root}  [via ${delivered.source}]`);
  console.log(`  fingerprint:     sha256 ${delivered.fingerprint.slice(0, 16)}…`);
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', `Sync failed: ${error.message}`);
  process.exit(1);
}
