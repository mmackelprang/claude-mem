import { Database } from 'bun:sqlite';
import { describe, it, expect } from 'bun:test';
import { queryIngestStatus } from '../../src/services/worker/http/routes/IngestStatusRoutes.js';

function seed(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, created_at_epoch INTEGER)`);
  return db;
}

describe('queryIngestStatus', () => {
  it('reports no data when empty', () => {
    const r = queryIngestStatus(seed() as any, 24 * 3600, 1_000_000);
    expect(r.lastObservationAt).toBeNull();
    expect(r.countLastWindow).toBe(0);
  });
  it('counts only observations inside the window and returns the latest epoch', () => {
    const db = seed();
    const now = 1_000_000;
    db.run(`INSERT INTO observations (created_at_epoch) VALUES (?)`, [now - 10]);       // in window
    db.run(`INSERT INTO observations (created_at_epoch) VALUES (?)`, [now - 100_000]);  // outside 1h window
    const r = queryIngestStatus(db as any, 3600, now); // 1h window
    expect(r.countLastWindow).toBe(1);
    expect(r.lastObservationAt).toBe(now - 10);
  });
});
