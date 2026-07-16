// tests/mission-control/next-steps-feed.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryNextSteps, dedupeByLexicalSimilarity } from '../../src/services/mission-control/NextStepsFeed.js';

function seed(db: Database): void {
  db.run(`CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    next_steps TEXT,
    created_at_epoch INTEGER NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO session_summaries (memory_session_id, project, next_steps, created_at_epoch) VALUES (?, ?, ?, ?)`
  );
  insert.run('s1', 'proj', 'Fix the chroma sync packaging bug', 3000);
  insert.run('s2', 'proj', 'Fix the Chroma sync packaging bug.', 2000); // near-duplicate of s1
  insert.run('s3', 'proj', 'Write the mission control velocity view', 1000);
  insert.run('s4', 'proj', '', 500); // empty — excluded
  insert.run('s5', 'proj', null, 400); // null — excluded
}

describe('queryNextSteps', () => {
  it('returns non-empty next_steps ordered by recency, deduped lexically', () => {
    const db = new Database(':memory:');
    seed(db);
    const items = queryNextSteps(db, { project: 'proj' });
    // s1/s2 are near-duplicates → collapse to one; s3 stays; empties excluded.
    expect(items.length).toBe(2);
    expect(items[0].createdAtEpoch).toBe(3000); // most recent first
    expect(items.some(i => /velocity view/i.test(i.text))).toBe(true);
  });
});

describe('dedupeByLexicalSimilarity', () => {
  it('keeps the first (most recent) of two near-identical strings', () => {
    const deduped = dedupeByLexicalSimilarity([
      { memorySessionId: 'a', project: 'p', createdAtEpoch: 2, text: 'run the tests and commit' },
      { memorySessionId: 'b', project: 'p', createdAtEpoch: 1, text: 'Run the tests, and commit.' },
    ], 0.7);
    expect(deduped.length).toBe(1);
    expect(deduped[0].memorySessionId).toBe('a');
  });
});
