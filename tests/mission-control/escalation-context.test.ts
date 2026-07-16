import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { buildEscalationContext } from '../../src/services/mission-control/escalationContext.js';
import { ESCALATION_CATALOG } from '../../src/services/mission-control/escalation-catalog.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  new SessionStore(db);
  db.run('PRAGMA foreign_keys = OFF');
  return db;
}
function seed(db: Database, rows: Array<{ project: string; agentType: string; session: string; title: string; epoch: number }>) {
  const stmt = db.prepare(
    `INSERT INTO observations
       (memory_session_id, project, text, type, title, agent_type, created_at, created_at_epoch)
     VALUES (?, ?, ?, 'discovery', ?, ?, ?, ?)`
  );
  for (const r of rows) stmt.run(r.session, r.project, r.title, r.title, r.agentType, new Date(r.epoch).toISOString(), r.epoch);
}

const NOW = 10_000_000;

describe('buildEscalationContext', () => {
  it('aggregates count, latest, and "+N others" per catalog error class', () => {
    const db = makeDb();
    seed(db, [
      { project: 'claude-mem', agentType: 'builder', session: 'a', title: 'Error: listen EADDRINUSE :::37777', epoch: NOW - 3000 },
      { project: 'claude-mem', agentType: 'tester',  session: 'b', title: 'EADDRINUSE again',                 epoch: NOW - 2000 },
      { project: 'claude-mem', agentType: 'planner', session: 'c', title: 'EADDRINUSE latest',               epoch: NOW - 1000 },
    ]);
    const ctx = buildEscalationContext(db, NOW);
    expect(ctx.eaddrinuse).toBeDefined();
    expect(ctx.eaddrinuse.count).toBe(3);
    expect(ctx.eaddrinuse.latestAgentType).toBe('planner');       // most recent
    expect(ctx.eaddrinuse.otherTeamsCount).toBe(2);               // builder + tester
    expect(ctx.eaddrinuse.errorLine).toContain('EADDRINUSE');
    expect(ctx.eaddrinuse.whatTitle).toBe('Port already in use'); // joined from catalog
    expect(typeof ctx.eaddrinuse.fixText).toBe('string');
  });

  it('fail-closed: an error with no catalog entry is never surfaced', () => {
    const db = makeDb();
    seed(db, [{ project: 'p', agentType: 'builder', session: 'a', title: 'ECONNREFUSED nope', epoch: NOW - 1000 }]);
    const ctx = buildEscalationContext(db, NOW);
    expect(Object.keys(ctx)).toHaveLength(0);
  });

  it('ignores occurrences outside the recent window', () => {
    const db = makeDb();
    seed(db, [{ project: 'p', agentType: 'builder', session: 'a', title: 'EADDRINUSE old', epoch: NOW - 30 * 24 * 60 * 60 * 1000 }]);
    expect(Object.keys(buildEscalationContext(db, NOW))).toHaveLength(0);
  });

  it('every catalog entry has the four render fields', () => {
    for (const e of ESCALATION_CATALOG) {
      expect(e.key).toBeTruthy();
      expect(e.re instanceof RegExp).toBe(true);
      expect(e.whatTitle).toBeTruthy();
      expect(e.fixText).toBeTruthy();
      expect(e.docHref).toBeTruthy();
    }
  });
});
