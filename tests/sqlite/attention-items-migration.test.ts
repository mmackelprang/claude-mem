// tests/sqlite/attention-items-migration.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

interface TableRow { name: string }
interface ColumnRow { name: string }
interface VersionRow { version: number }

describe('attention_items migration (v41)', () => {
  it('creates the attention_items table with the expected columns and indexes', () => {
    const db = new Database(':memory:');
    // Constructing SessionStore runs every migration in order.
    new SessionStore(db);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_items'")
      .all() as TableRow[];
    expect(tables.length).toBe(1);

    const columns = (db.query('PRAGMA table_info(attention_items)').all() as ColumnRow[]).map(c => c.name);
    for (const expected of [
      'id', 'created_at', 'created_at_epoch', 'type', 'summary', 'blocked_on', 'urgency',
      'source', 'ref', 'status', 'resolved_at', 'resolved_by', 'project', 'agent_type', 'agent_id', 'memory_session_id',
    ]) {
      expect(columns).toContain(expected);
    }

    const indexes = (db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attention_items'")
      .all() as TableRow[]).map(i => i.name);
    expect(indexes).toContain('ux_attention_items_source_ref');

    const version = db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(41) as VersionRow | undefined;
    expect(version?.version).toBe(41);
  });

  it('is idempotent: constructing a second SessionStore over the same db does not throw', () => {
    const db = new Database(':memory:');
    new SessionStore(db);
    expect(() => new SessionStore(db)).not.toThrow();
  });
});
