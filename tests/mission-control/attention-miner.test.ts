// tests/mission-control/attention-miner.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { runAttentionMine, readOpenAttentionItems } from '../../src/services/mission-control/AttentionMiner.js';
import type { OpenPr } from '../../src/services/mission-control/shell.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  new SessionStore(db); // creates attention_items (v41) + observations + session_summaries
  // Fixture rows below are inserted without parent sdk_sessions rows; disable FK
  // enforcement so the bare inserts succeed regardless of connection pragmas.
  db.run('PRAGMA foreign_keys = OFF');
  return db;
}

// Seed an error observation stamped at `epoch` so tests can place it inside or
// outside the miner's 7-day escalation window relative to a fixed `now` — never
// relying on the literal wall-clock date being within the window.
function seedErrorObservation(db: Database, epoch: number): void {
  const insert = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, agent_type, agent_id, created_at, created_at_epoch, narrative, title)
     VALUES (?, ?, 'discovery', NULL, NULL, ?, ?, ?, ?)`
  );
  insert.run('s1', 'proj', new Date(epoch).toISOString(), epoch,
    'The worker is unreachable: EADDRINUSE on 127.0.0.1:37777', 'Worker down');
}

// A fixed reference time used across tests. The escalation window is [now-7d, now],
// so an observation seeded at NOW is always in-window regardless of the real clock.
const NOW = Date.parse('2026-07-16T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const SPEC = {
  path: 'docs/superpowers/specs/2026-07-16-example-design.md',
  content: '# Design\n\n- **Status:** Proposed\n\n## Open Questions\n\n- Should we cache the result?\n',
};

describe('runAttentionMine', () => {
  it('mines open PRs, proposed specs, error observations, and open questions', () => {
    const db = freshDb();
    seedErrorObservation(db, NOW);
    const boundary = {
      ghAvailable: () => true,
      listOpenPrs: (): OpenPr[] => [{ number: 42, title: 'Add feature', url: 'https://x/42' }],
    };
    const result = runAttentionMine(db, boundary, { specFiles: [SPEC], now: NOW });
    expect(result.ghAvailable).toBe(true);
    const items = readOpenAttentionItems(db);
    expect(items.some(i => i.type === 'review' && i.ref === 'pr:42')).toBe(true);
    expect(items.some(i => i.type === 'review' && i.ref.startsWith('spec:'))).toBe(true);
    expect(items.some(i => i.type === 'escalation')).toBe(true);
    expect(items.some(i => i.type === 'question')).toBe(true);
  });

  it('is idempotent: two passes over identical state produce no duplicates', () => {
    const db = freshDb();
    const boundary = {
      ghAvailable: () => true,
      listOpenPrs: (): OpenPr[] => [{ number: 42, title: 'Add feature', url: 'https://x/42' }],
    };
    runAttentionMine(db, boundary, { specFiles: [SPEC] });
    runAttentionMine(db, boundary, { specFiles: [SPEC] });
    const items = readOpenAttentionItems(db);
    const prItems = items.filter(i => i.ref === 'pr:42');
    expect(prItems.length).toBe(1);
  });

  it('auto-resolves a review when its PR is no longer open (merged/closed)', () => {
    const db = freshDb();
    const withPr = {
      ghAvailable: () => true,
      listOpenPrs: (): OpenPr[] => [{ number: 42, title: 'Add feature', url: 'https://x/42' }],
    };
    runAttentionMine(db, withPr, {});
    expect(readOpenAttentionItems(db).some(i => i.ref === 'pr:42')).toBe(true);

    const withoutPr = { ghAvailable: () => true, listOpenPrs: (): OpenPr[] => [] };
    const result = runAttentionMine(db, withoutPr, {});
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(readOpenAttentionItems(db).some(i => i.ref === 'pr:42')).toBe(false);
  });

  it('degrades gracefully when gh is unavailable (specs/errors still mined)', () => {
    const db = freshDb();
    seedErrorObservation(db, NOW);
    const boundary = {
      ghAvailable: () => false,
      listOpenPrs: (): OpenPr[] => [],
    };
    const result = runAttentionMine(db, boundary, { specFiles: [SPEC], now: NOW });
    expect(result.ghAvailable).toBe(false);
    const items = readOpenAttentionItems(db);
    expect(items.some(i => i.ref.startsWith('spec:'))).toBe(true);
    expect(items.some(i => i.type === 'escalation')).toBe(true);
  });

  it('does NOT wipe existing spec/question items when spec mining is gated off (#24)', () => {
    const db = freshDb();
    const boundary = { ghAvailable: () => true, listOpenPrs: (): OpenPr[] => [] };

    // Pass 1: mining enabled (default) → spec-review + question items are raised.
    runAttentionMine(db, boundary, { specFiles: [SPEC], now: NOW });
    const before = readOpenAttentionItems(db);
    expect(before.some(i => i.type === 'review' && i.ref.startsWith('spec:'))).toBe(true);
    expect(before.some(i => i.type === 'question')).toBe(true);

    // Pass 2: repo-root gated off — specFiles=[] AND specMiningEnabled=false.
    // The gated pass observed nothing about specs, so it must NOT auto-resolve
    // the still-open spec/question items (the distinction the ghAvailable guard
    // already makes for PR reviews).
    const result = runAttentionMine(db, boundary, { specFiles: [], specMiningEnabled: false, now: NOW });
    const after = readOpenAttentionItems(db);
    expect(after.some(i => i.type === 'review' && i.ref.startsWith('spec:'))).toBe(true);
    expect(after.some(i => i.type === 'question')).toBe(true);
    // Nothing spec/question-related was resolved by the gated pass.
    expect(result.resolved).toBe(0);
  });

  it('auto-resolves an escalation once its error signature leaves the recent window', () => {
    const db = freshDb();
    const boundary = { ghAvailable: () => true, listOpenPrs: (): OpenPr[] => [] };

    // Pass 1: the error observation is inside the window → escalation is raised.
    seedErrorObservation(db, NOW);
    runAttentionMine(db, boundary, { now: NOW });
    expect(readOpenAttentionItems(db).some(i => i.type === 'escalation')).toBe(true);

    // Pass 2: run 8 days later. The observation (stamped at NOW) now falls outside
    // the 7-day window, so its signature is absent from the scan → auto-resolve.
    const later = NOW + 8 * DAY_MS;
    const result = runAttentionMine(db, boundary, { now: later });
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(readOpenAttentionItems(db).some(i => i.type === 'escalation')).toBe(false);
  });
});
