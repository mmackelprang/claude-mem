// tests/worker/http/routes/mission-control-routes.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MissionControlRoutes } from '../../../../src/services/worker/http/routes/MissionControlRoutes.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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

  it('velocity returns a deferred state (does not read a repo-root file) in Phase 1', () => {
    // Velocity is gated on resolveRepoRoot() (#24). It must never crash or read
    // getPackageRoot()/docs/BUILDER_QUEUE.md — just report deferred.
    const app = makeMockApp();
    const routes = new MissionControlRoutes(makeDbManager() as any, {
      ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
    }, null); // repoRoot: null ⇒ deferred, deterministic regardless of the bun-test cwd
    routes.setupRoutes(app as any);
    const body = app.invoke('/api/mission-control/velocity', { query: {} }) as {
      deferred?: boolean; reason?: string; openCount: number | null; shippedByWeek: unknown[];
    };
    expect(body.deferred).toBe(true);
    expect(typeof body.reason).toBe('string');
    expect(body.openCount).toBeNull();
    expect(Array.isArray(body.shippedByWeek)).toBe(true);
  });

  it('attention reports specMiningDeferred so the pane can label the gated sources', () => {
    const app = makeMockApp();
    const routes = new MissionControlRoutes(makeDbManager() as any, {
      ghAvailable: () => false, listOpenPrs: () => [], listMergeCommits: () => [],
    }, null); // repoRoot: null ⇒ deferred, deterministic regardless of the bun-test cwd
    routes.setupRoutes(app as any);
    const body = app.invoke('/api/mission-control/attention', { query: {} }) as {
      items: unknown[]; ghAvailable: boolean; specMiningDeferred: boolean;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.specMiningDeferred).toBe(true); // gated off in Phase 1 (#24)
  });
});

const FIXTURE_QUEUE = `# Builder Queue

## Queue

| # | Status | Item | Spec + Plan | Depends on | Notes |
|---|--------|------|-------------|------------|-------|
| 1 | 📋 | **First item** | [plan](x.md) | — | note |

## Recently shipped

| Item | PR | Notes |
|------|----|-------|
| Something shipped | #99 | note |
`;

function makeFixtureRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-route-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'BUILDER_QUEUE.md'), FIXTURE_QUEUE);
  return root;
}

const RESOLVED_BOUNDARY = {
  ghAvailable: () => false,
  listOpenPrs: () => [],
  listMergeCommits: () => [],
  repoWebInfo: () => ({ repoWebBase: 'https://github.com/acme/repo', defaultBranch: 'main' }),
};

describe('MissionControlRoutes — Phase 1b payloads', () => {
  it('velocity returns real counts (not deferred), independent of an empty git series (F3)', () => {
    const root = makeFixtureRepo();
    try {
      const app = makeMockApp();
      const routes = new MissionControlRoutes(makeDbManager() as any, RESOLVED_BOUNDARY, root);
      routes.setupRoutes(app as any);
      const body = app.invoke('/api/mission-control/velocity', { query: {} }) as {
        deferred?: boolean; openCount: number | null; shippedCount: number | null; shippedByWeek: unknown[];
      };
      expect(body.deferred).toBeUndefined();
      expect(body.openCount).toBe(1);
      expect(body.shippedCount).toBe(1);
      expect(body.shippedByWeek).toEqual([]); // empty git ⇒ empty series, counts survive
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('attention exposes link base + escalationContext and specMiningDeferred:false when resolved', () => {
    const root = makeFixtureRepo();
    try {
      const app = makeMockApp();
      const routes = new MissionControlRoutes(makeDbManager() as any, RESOLVED_BOUNDARY, root);
      routes.setupRoutes(app as any);
      const body = app.invoke('/api/mission-control/attention', { query: {} }) as {
        specMiningDeferred: boolean; repoWebBase: string | null; defaultBranch: string | null; escalationContext: Record<string, unknown>;
      };
      expect(body.specMiningDeferred).toBe(false);
      expect(body.repoWebBase).toBe('https://github.com/acme/repo');
      expect(body.defaultBranch).toBe('main');
      expect(typeof body.escalationContext).toBe('object');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('progress returns buckets + sessions + prs and honors ?since', () => {
    const dbManager = makeDbManager();
    const db = dbManager.getSessionStore().db;
    db.run(`INSERT INTO observations (memory_session_id, project, text, type, title, agent_type, created_at, created_at_epoch)
            VALUES ('s1','claude-mem','opened PR #42','feature','opened PR #42','builder','2026-07-16T00:00:00.000Z', 5000)`);
    const app = makeMockApp();
    const routes = new MissionControlRoutes(dbManager as any, RESOLVED_BOUNDARY, null);
    routes.setupRoutes(app as any);
    const body = app.invoke('/api/mission-control/progress', { query: { since: '4000' } }) as {
      buckets: Array<{ project: string | null }>; sessions: Array<{ sessions: number }>; prs: Array<{ prNumbers: number[] }>;
    };
    expect(body.buckets.some(b => b.project === 'claude-mem')).toBe(true);
    expect(body.sessions.some(s => s.sessions === 1)).toBe(true);
    expect(body.prs.some(p => p.prNumbers.includes(42))).toBe(true);
  });
});
