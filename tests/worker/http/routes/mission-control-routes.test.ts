// tests/worker/http/routes/mission-control-routes.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MissionControlRoutes } from '../../../../src/services/worker/http/routes/MissionControlRoutes.js';

// Minimal Express-like app double: records handlers keyed by path.
function makeMockApp() {
  const handlers = new Map<string, (req: any, res: any) => void>();
  return {
    get(path: string, handler: (req: any, res: any) => void) { handlers.set(path, handler); },
    use() { /* static — ignored */ },
    invoke(path: string, req: any) {
      let body: unknown;
      const res = { json: (b: unknown) => { body = b; }, status: () => res, setHeader: () => {}, send: () => {} };
      handlers.get(path)!(req, res);
      return body;
    },
    handlers,
  };
}

function makeDbManager() {
  const db = new Database(':memory:');
  const store = new SessionStore(db);
  // Fixture row below has no parent sdk_sessions row; disable FK enforcement.
  db.run('PRAGMA foreign_keys = OFF');
  return { getSessionStore: () => store };
}

describe('MissionControlRoutes', () => {
  it('registers the four mission-control endpoints', () => {
    const app = makeMockApp();
    const routes = new MissionControlRoutes(makeDbManager() as any, {
      ghAvailable: () => false,
      listOpenPrs: () => [],
      listMergeCommits: () => [],
    });
    routes.setupRoutes(app as any);
    for (const p of [
      '/api/mission-control/attention',
      '/api/mission-control/progress',
      '/api/mission-control/velocity',
      '/api/mission-control/next-steps',
    ]) {
      expect(app.handlers.has(p)).toBe(true);
    }
  });

  it('serves next-steps as JSON', () => {
    const dbManager = makeDbManager();
    const db = dbManager.getSessionStore().db;
    db.run(`INSERT INTO session_summaries (memory_session_id, project, next_steps, created_at, created_at_epoch)
            VALUES ('s1', 'proj', 'Ship the thing', '2026-07-16T00:00:00.000Z', 1000)`);
    const app = makeMockApp();
    const routes = new MissionControlRoutes(dbManager as any, {
      ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
    });
    routes.setupRoutes(app as any);
    const body = app.invoke('/api/mission-control/next-steps', { query: {} }) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
  });
});
