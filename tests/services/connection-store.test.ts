import { describe, it, expect } from 'bun:test';
import { ConnectionStore, LOCAL_WORKER_ID } from '../../src/services/worker/ConnectionStore.js';

const server = { id: 'nas', name: 'NAS', runtime: 'server' as const, url: 'https://nas:37700', apiKey: 'sk-123', projectId: 'proj' };

describe('ConnectionStore.applyToSettings', () => {
  it('seeds an undeletable Local worker profile when connections is empty', () => {
    const out = ConnectionStore.applyToSettings({ CLAUDE_MEM_CONNECTIONS: '[]', CLAUDE_MEM_ACTIVE_CONNECTION: '' } as any);
    const conns = JSON.parse(out.CLAUDE_MEM_CONNECTIONS);
    expect(conns).toHaveLength(1);
    expect(conns[0].id).toBe(LOCAL_WORKER_ID);
    expect(conns[0].runtime).toBe('worker');
    expect(out.CLAUDE_MEM_ACTIVE_CONNECTION).toBe(LOCAL_WORKER_ID);
  });

  it('writes canonical keys from the active server profile', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: 'nas',
    } as any);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(out.CLAUDE_MEM_SERVER_URL).toBe('https://nas:37700');
    expect(out.CLAUDE_MEM_SERVER_API_KEY).toBe('sk-123');
    expect(out.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj');
  });

  it('clears server canonical keys when the active profile is the local worker', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: LOCAL_WORKER_ID, // seeded worker + nas
    } as any);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('worker');
    expect(out.CLAUDE_MEM_SERVER_URL).toBe('');
    expect(out.CLAUDE_MEM_SERVER_API_KEY).toBe('');
    expect(out.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('');
  });

  it('falls back to the local worker when the active id is unknown', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: 'ghost',
    } as any);
    expect(out.CLAUDE_MEM_ACTIVE_CONNECTION).toBe(LOCAL_WORKER_ID);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('worker');
  });

  it('is idempotent — re-applying does not duplicate the local worker', () => {
    const once = ConnectionStore.applyToSettings({ CLAUDE_MEM_CONNECTIONS: '[]', CLAUDE_MEM_ACTIVE_CONNECTION: '' } as any);
    const twice = ConnectionStore.applyToSettings(once);
    expect(JSON.parse(twice.CLAUDE_MEM_CONNECTIONS)).toHaveLength(1);
  });
});
