// SPDX-License-Identifier: Apache-2.0
//
// #23 — settings.json file-mode hardening.
//
// `~/.claude-mem/settings.json` can hold a live CLAUDE_MEM_SERVER_API_KEY. Two
// writers touch it: persistServerSettings (server-bootstrap) and mergeSettings
// (installer). Both must land the file at mode 0600 on POSIX so a co-tenant
// user cannot read the key, and both run a best-effort Windows ACL tightening
// (chmod is a POSIX no-op on Windows).
//
// These tests lock those invariants so a future refactor that drops the 0600
// (or the create-path window) fails CI. All I/O is against per-test temp dirs —
// never the real ~/.claude-mem.

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { persistServerSettings } from '../../src/services/hooks/server-bootstrap.js';
import { mergeSettings } from '../../src/npx-cli/commands/install.js';
import { restrictSettingsFileForWindows } from '../../src/shared/settings-file-permissions.js';

const isWin = process.platform === 'win32';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  dirs.length = 0;
});

function tempSettingsPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'cmem-settings-'));
  dirs.push(d);
  return join(d, 'settings.json');
}

describe('persistServerSettings file mode (#23)', () => {
  it('writes the API key into settings.json', () => {
    const p = tempSettingsPath();
    persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj', serverBaseUrl: 'http://localhost:37877' });
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_test');
    expect(parsed.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj');
  });

  // Regression guard: the existing chmod(0o600) at server-bootstrap.ts must not
  // silently regress. chmod is a no-op on Windows, so this asserts on POSIX only.
  (isWin ? it.skip : it)('is mode 0600 on POSIX (chmod is a no-op on Windows)', () => {
    const p = tempSettingsPath();
    persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj', serverBaseUrl: 'http://localhost:37877' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe('mergeSettings create-path file mode (#23)', () => {
  it('creates settings.json with the merged keys', () => {
    const p = tempSettingsPath();
    const wrote = mergeSettings({ CLAUDE_MEM_SERVER_API_KEY: 'cmem_merge', CLAUDE_MEM_RUNTIME: 'server' }, p);
    expect(wrote).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_merge');
    expect(parsed.CLAUDE_MEM_RUNTIME).toBe('server');
  });

  // Closes the POSIX pre-chmod umask window: a freshly created settings.json
  // must land at 0600, not the process umask (~0644). POSIX only.
  (isWin ? it.skip : it)('freshly-created settings.json is mode 0600 on POSIX', () => {
    const p = tempSettingsPath();
    mergeSettings({ CLAUDE_MEM_SERVER_API_KEY: 'cmem_merge' }, p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe('restrictSettingsFileForWindows (#23)', () => {
  it('is a no-op that never throws on POSIX (skipped on Windows)', () => {
    if (isWin) return; // covered by the Windows-only case below
    const p = tempSettingsPath();
    persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj' });
    expect(() => restrictSettingsFileForWindows(p)).not.toThrow();
  });

  // On Windows the best-effort icacls tightening must run without throwing even
  // if icacls is missing/denied — the install path must never fail on it.
  (isWin ? it : it.skip)('runs without throwing on Windows', () => {
    const p = tempSettingsPath();
    persistServerSettings(p, { apiKey: 'cmem_test', projectId: 'proj', serverBaseUrl: 'http://localhost:37877' });
    expect(() => restrictSettingsFileForWindows(p)).not.toThrow();
    // A missing path must also be non-fatal (icacls returns non-zero, we ignore).
    expect(() => restrictSettingsFileForWindows(join(tmpdir(), 'cmem-does-not-exist.json'))).not.toThrow();
  });
});
