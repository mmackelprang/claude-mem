#!/usr/bin/env node
'use strict';

/**
 * restart-installed-worker.cjs — restart the worker that the hooks will load.
 *
 * Replaces the `build-and-sync` tail:
 *   (cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:restart)
 *
 * Two problems with that form:
 *
 *   1. `~` is a POSIX shell-ism. npm's default script shell on Windows is
 *      cmd.exe, which does not expand it — the step failed with "The system
 *      cannot find the path specified." independently of the rsync breakage
 *      earlier in the chain.
 *   2. It restarted the MARKETPLACE copy, which is not necessarily the copy the
 *      hooks load. The resolution chain prefers a cache/<version> directory over
 *      the marketplace install, so this could leave a freshly synced cache build
 *      on disk while restarting a different binary.
 *
 * Resolving the root first fixes both: we restart exactly the plugin the hooks
 * resolve, on any platform, with no shell involved in path handling.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { resolvePluginRoot, WORKER_REQUIRE_FILES } = require('./lib/resolve-plugin-root.cjs');

function main() {
  const resolved = resolvePluginRoot({ requireFiles: WORKER_REQUIRE_FILES });

  if (!resolved) {
    console.error(
      '\x1b[31m%s\x1b[0m',
      'Cannot restart worker: no installed plugin root resolves.\n' +
        `  Required under <root>/scripts/: ${WORKER_REQUIRE_FILES.join(', ')}\n` +
        '  Run `npm run sync-marketplace` first.'
    );
    process.exit(1);
  }

  const workerService = path.join(resolved.root, 'scripts', 'worker-service.cjs');
  console.log(`Restarting worker from ${resolved.root} [via ${resolved.source}]...`);

  try {
    execFileSync('bun', [workerService, 'restart'], { stdio: 'inherit', shell: true });
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', `Worker restart failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
