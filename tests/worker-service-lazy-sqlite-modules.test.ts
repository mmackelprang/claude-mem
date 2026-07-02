import { describe, it, expect } from 'bun:test';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

const PLUGIN_DIR = join(import.meta.dir, '..', 'plugin');
const WORKER_SCRIPTS_DIR = join(PLUGIN_DIR, 'scripts');
const SESSION_STORE_PATH = join(PLUGIN_DIR, 'sqlite', 'SessionStore.js');
const WORKER_BUNDLE = join(WORKER_SCRIPTS_DIR, 'worker-service.cjs');

const require = createRequire(import.meta.url);

// #3091/#3092/#3107: worker-service.cjs reaches SessionStore via a runtime
// createRequire('../sqlite/SessionStore.js') that the build must emit as a loose
// sibling (Approach A — SessionStore pulls bun:sqlite, so it cannot be inlined
// into the SDK bundle). parseFileList, by contrast, is now a static import
// inlined into the worker bundle (Approach B), so it must resolve WITHOUT any
// plugin/sqlite/observations/files.js file existing.
describe('worker-service.cjs lazy/inlined SQLite modules (#3091/#3092/#3107)', () => {
  it('emits sqlite/SessionStore.js next to the worker bundle', () => {
    expect(existsSync(SESSION_STORE_PATH)).toBe(true);
  });

  it('resolves sqlite/SessionStore.js the same way ChromaSync.ts requires it at runtime', () => {
    const { SessionStore } = require(join(WORKER_SCRIPTS_DIR, '../sqlite/SessionStore.js'));
    expect(typeof SessionStore).toBe('function');
  });

  it('inlines parseFileList — no ../sqlite/observations/files.js require survives in the bundle', () => {
    const bundle = require('fs').readFileSync(WORKER_BUNDLE, 'utf8');
    expect(bundle).not.toContain('../sqlite/observations/files.js');
  });

  it('does not ship a loose observations/files.js (it is inlined, not emitted)', () => {
    expect(existsSync(join(PLUGIN_DIR, 'sqlite', 'observations', 'files.js'))).toBe(false);
  });
});
