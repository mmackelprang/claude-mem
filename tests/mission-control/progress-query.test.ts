// tests/mission-control/progress-query.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryProgress } from '../../src/services/mission-control/ProgressQuery.js';

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
