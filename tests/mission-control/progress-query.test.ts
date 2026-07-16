// tests/mission-control/progress-query.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryProgress, queryTeamSessions } from '../../src/services/mission-control/ProgressQuery.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function makeProgressDb() {
  const db = new Database(':memory:');
  new SessionStore(db);
  db.run('PRAGMA foreign_keys = OFF');
  return db;
}

function seed(db: Database): void {
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT,
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    agent_type TEXT,
    agent_id TEXT,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, agent_type, agent_id, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Two observations for builder on 2026-07-16, one discovery + one bugfix.
  insert.run('s1', 'proj', 'discovery', 'builder', 'b-1', '2026-07-16T10:00:00.000Z', Date.parse('2026-07-16T10:00:00.000Z'));
  insert.run('s1', 'proj', 'bugfix', 'builder', 'b-1', '2026-07-16T11:00:00.000Z', Date.parse('2026-07-16T11:00:00.000Z'));
  // One for planner on the same day.
  insert.run('s2', 'proj', 'feature', 'planner', 'p-1', '2026-07-16T12:00:00.000Z', Date.parse('2026-07-16T12:00:00.000Z'));
}

describe('queryProgress', () => {
  it('groups observations by agent × day and counts by type', () => {
    const db = new Database(':memory:');
    seed(db);
    const rows = queryProgress(db, { by: 'agent', granularity: 'day' });
    const builder = rows.find(r => r.agentType === 'builder' && r.bucket === '2026-07-16');
    expect(builder).toBeDefined();
    expect(builder!.total).toBe(2);
    expect(builder!.byType).toEqual({ discovery: 1, bugfix: 1 });

    const planner = rows.find(r => r.agentType === 'planner');
    expect(planner!.total).toBe(1);
    expect(planner!.byType).toEqual({ feature: 1 });
  });

  it('returns an empty result for the human axis (no actor data yet)', () => {
    const db = new Database(':memory:');
    seed(db);
    expect(queryProgress(db, { by: 'human' })).toEqual([]);
  });
});

function seedObs(db: any, rows: Array<{ session: string; project: string; agentType: string; type: string; epoch: number }>) {
  const stmt = db.prepare(
    `INSERT INTO observations
       (memory_session_id, project, text, type, agent_type, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(r.session, r.project, `obs ${r.type}`, r.type, r.agentType, new Date(r.epoch).toISOString(), r.epoch);
  }
}

describe('ProgressQuery — project grouping + sessions', () => {
  it('carries project on each bucket and preserves byType', () => {
    const db = makeProgressDb();
    seedObs(db, [
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'feature', epoch: 2000 },
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'bugfix', epoch: 2001 },
      { session: 's2', project: 'other', agentType: 'planner', type: 'decision', epoch: 2002 },
    ]);
    const buckets = queryProgress(db, {});
    expect(buckets.every(b => 'project' in b)).toBe(true);
    const cm = buckets.filter(b => b.project === 'claude-mem');
    expect(cm.length).toBeGreaterThan(0);
    const merged = cm.reduce((acc, b) => { for (const [k, v] of Object.entries(b.byType)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {} as Record<string, number>);
    expect(merged.feature).toBe(1);
    expect(merged.bugfix).toBe(1);
  });

  it('counts DISTINCT sessions per (project, agentType), not per type', () => {
    const db = makeProgressDb();
    seedObs(db, [
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'feature', epoch: 3000 },
      { session: 's1', project: 'claude-mem', agentType: 'builder', type: 'bugfix', epoch: 3001 }, // same session, 2nd type
      { session: 's2', project: 'claude-mem', agentType: 'builder', type: 'feature', epoch: 3002 },
    ]);
    const teams = queryTeamSessions(db, {});
    const builder = teams.find(t => t.project === 'claude-mem' && t.agentType === 'builder')!;
    expect(builder.sessions).toBe(2); // s1, s2 — NOT 3 (the two types of s1 collapse)
  });

  it('honors sinceEpoch on both queries', () => {
    const db = makeProgressDb();
    seedObs(db, [
      { session: 'old', project: 'p', agentType: 'builder', type: 'feature', epoch: 1000 },
      { session: 'new', project: 'p', agentType: 'builder', type: 'feature', epoch: 5000 },
    ]);
    expect(queryTeamSessions(db, { sinceEpoch: 4000 })[0].sessions).toBe(1);
    expect(queryProgress(db, { sinceEpoch: 4000 }).length).toBe(1);
  });
});
