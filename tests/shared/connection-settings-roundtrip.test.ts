import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('connection settings round-trip', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function tmpSettings(contents: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-settings-'));
    dirs.push(dir);
    const p = join(dir, 'settings.json');
    writeFileSync(p, JSON.stringify(contents));
    return p;
  }

  it('preserves CLAUDE_MEM_CONNECTIONS and CLAUDE_MEM_ACTIVE_CONNECTION through loadFromFile', () => {
    const connections = JSON.stringify([{ id: 'local-worker', name: 'Local worker', runtime: 'worker', url: '', apiKey: '', projectId: '' }]);
    const p = tmpSettings({ CLAUDE_MEM_CONNECTIONS: connections, CLAUDE_MEM_ACTIVE_CONNECTION: 'local-worker' });
    const loaded = SettingsDefaultsManager.loadFromFile(p, false);
    expect(loaded.CLAUDE_MEM_CONNECTIONS).toBe(connections);
    expect(loaded.CLAUDE_MEM_ACTIVE_CONNECTION).toBe('local-worker');
  });

  it('defaults CLAUDE_MEM_CONNECTIONS to "[]" when absent', () => {
    const p = tmpSettings({});
    const loaded = SettingsDefaultsManager.loadFromFile(p, false);
    expect(loaded.CLAUDE_MEM_CONNECTIONS).toBe('[]');
    expect(loaded.CLAUDE_MEM_ACTIVE_CONNECTION).toBe('local-worker');
  });
});
