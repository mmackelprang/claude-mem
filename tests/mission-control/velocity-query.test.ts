// tests/mission-control/velocity-query.test.ts
import { describe, it, expect } from 'bun:test';
import { queryVelocity, isoWeek } from '../../src/services/mission-control/VelocityQuery.js';
import type { ParsedQueue } from '../../src/services/mission-control/BuilderQueueParser.js';
import type { MergeCommit } from '../../src/services/mission-control/shell.js';

const parsed: ParsedQueue = {
  queueRows: [{ id: 1, status: '📋', item: 'a', raw: '' }],
  backlogRows: [
    { id: 2, status: null, item: 'b', raw: '' },
    { id: 16, status: null, item: 'c', raw: '' },
  ],
  shippedRows: [
    { id: null, status: null, item: 'shipped-1', raw: '' },
    { id: null, status: null, item: 'shipped-2', raw: '' },
  ],
  tombstones: [9, 15],
  openRows: [
    { id: 1, status: '📋', item: 'a', raw: '' },
    { id: 2, status: null, item: 'b', raw: '' },
    { id: 16, status: null, item: 'c', raw: '' },
  ],
};

describe('queryVelocity', () => {
  it('reports open and shipped totals from the parsed queue', () => {
    const boundary = { listMergeCommits: (): MergeCommit[] => [] };
    const result = queryVelocity(parsed, boundary);
    expect(result.openCount).toBe(3);
    expect(result.shippedCount).toBe(2);
  });

  it('buckets merged PRs by ISO week', () => {
    const boundary = {
      listMergeCommits: (): MergeCommit[] => [
        { sha: 'a', dateIso: '2026-07-15T00:00:00Z', subject: 'Merge pull request #11 from x' },
        { sha: 'b', dateIso: '2026-07-16T00:00:00Z', subject: 'Merge pull request #14 from y' },
        { sha: 'c', dateIso: '2026-07-16T00:00:00Z', subject: 'chore: not a PR merge' },
      ],
    };
    const result = queryVelocity(parsed, boundary);
    const week = isoWeek('2026-07-16T00:00:00Z');
    const point = result.shippedByWeek.find(p => p.week === week);
    // Only the two "Merge pull request #N" subjects count; both fall in the same ISO week.
    expect(point?.shipped).toBe(2);
  });
});
