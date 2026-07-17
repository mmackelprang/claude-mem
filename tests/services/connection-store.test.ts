import { describe, it, expect } from 'bun:test';
import { ConnectionStore, LOCAL_WORKER_ID, IMPORTED_SERVER_ID } from '../../src/services/worker/ConnectionStore.js';

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

  // Back-compat: a pre-existing runtime=server install (installer wrote the
  // canonical keys directly; no CLAUDE_MEM_CONNECTIONS) must NOT be silently
  // reset to the local worker. loadFromFile synthesizes the defaults
  // active='local-worker' + connections='[]' for such a file.
  it('adopts legacy runtime=server canonical keys into an active server profile', () => {
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: '[]',
      CLAUDE_MEM_ACTIVE_CONNECTION: LOCAL_WORKER_ID, // the synthesized default
      CLAUDE_MEM_RUNTIME: 'server',
      CLAUDE_MEM_SERVER_URL: 'https://nas:37700',
      CLAUDE_MEM_SERVER_API_KEY: 'sk-legacy',
      CLAUDE_MEM_SERVER_PROJECT_ID: 'legacy-proj',
    } as any);
    // Server connection preserved, not wiped.
    expect(out.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(out.CLAUDE_MEM_SERVER_URL).toBe('https://nas:37700');
    expect(out.CLAUDE_MEM_SERVER_API_KEY).toBe('sk-legacy');
    expect(out.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('legacy-proj');
    // Surfaced as an active, imported server profile alongside the Local worker.
    const conns = JSON.parse(out.CLAUDE_MEM_CONNECTIONS);
    expect(conns).toHaveLength(2);
    expect(out.CLAUDE_MEM_ACTIVE_CONNECTION).toBe(IMPORTED_SERVER_ID);
    const imported = conns.find((c: any) => c.id === IMPORTED_SERVER_ID);
    expect(imported).toMatchObject({ runtime: 'server', url: 'https://nas:37700', apiKey: 'sk-legacy', projectId: 'legacy-proj' });
  });

  it('adoption is idempotent — re-applying does not add a second imported server', () => {
    const once = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: '[]', CLAUDE_MEM_ACTIVE_CONNECTION: LOCAL_WORKER_ID,
      CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: 'https://nas:37700',
      CLAUDE_MEM_SERVER_API_KEY: 'sk-legacy', CLAUDE_MEM_SERVER_PROJECT_ID: 'legacy-proj',
    } as any);
    const twice = ConnectionStore.applyToSettings(once);
    expect(JSON.parse(twice.CLAUDE_MEM_CONNECTIONS)).toHaveLength(2);
    expect(twice.CLAUDE_MEM_ACTIVE_CONNECTION).toBe(IMPORTED_SERVER_ID);
    expect(twice.CLAUDE_MEM_RUNTIME).toBe('server');
  });

  it('does NOT adopt when a server profile already exists (deliberate switch to worker with stale canonical keys)', () => {
    // User activated the Local worker while a server profile is saved; the
    // client still POSTs stale server canonical keys. This must resolve to
    // worker (the explicit choice), not fabricate a second server profile.
    const out = ConnectionStore.applyToSettings({
      CLAUDE_MEM_CONNECTIONS: JSON.stringify([server]),
      CLAUDE_MEM_ACTIVE_CONNECTION: LOCAL_WORKER_ID,
      CLAUDE_MEM_RUNTIME: 'server',
      CLAUDE_MEM_SERVER_URL: 'https://nas:37700',
      CLAUDE_MEM_SERVER_API_KEY: 'sk-123',
      CLAUDE_MEM_SERVER_PROJECT_ID: 'proj',
    } as any);
    expect(out.CLAUDE_MEM_RUNTIME).toBe('worker');
    expect(out.CLAUDE_MEM_SERVER_URL).toBe('');
    const conns = JSON.parse(out.CLAUDE_MEM_CONNECTIONS);
    expect(conns.some((c: any) => c.id === IMPORTED_SERVER_ID)).toBe(false);
    expect(conns).toHaveLength(2); // local-worker + the existing nas server
  });
});
