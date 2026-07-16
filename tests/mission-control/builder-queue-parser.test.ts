// tests/mission-control/builder-queue-parser.test.ts
import { describe, it, expect } from 'bun:test';
import { parseBuilderQueue, BuilderQueueParseError } from '../../src/services/mission-control/BuilderQueueParser.js';

const FIXTURE = `# Builder Queue

## Queue

| # | Status | Item | Spec + Plan | Depends on | Notes |
|---|--------|------|-------------|------------|-------|
| 1 | 📋 | **First item** | [plan](x.md) | — | note |

## Backlog (not yet planned — needs a Planner pass)

| # | Item | Origin | Notes |
|---|------|--------|-------|
| 2 | Second item | origin | note |
| ~~9~~ | ✅ **Shipped as PR #11** — retired, ID not reused. | confirmed | tombstone |
| 16 | Sixteenth item | origin | note |
| ~~15~~ | ✅ **Shipped as PR #14** — retired. | confirmed | tombstone |
| 17 | Seventeenth item | origin | note |

## Recently shipped

| Item | PR | Notes |
|------|----|-------|
| Merge upstream v13.11.0 into fork | #9 | not a queue row |
| build-and-sync on Windows | #11 | shipped #9 |
`;

describe('parseBuilderQueue', () => {
  it('extracts queue, backlog, tombstones, and shipped rows', () => {
    const parsed = parseBuilderQueue(FIXTURE);
    expect(parsed.queueRows.map(r => r.id)).toEqual([1]);
    expect(parsed.backlogRows.map(r => r.id)).toEqual([2, 9, 16, 15, 17]);
    expect(parsed.tombstones).toEqual([9, 15]);
    // Recently shipped rows are UNNUMBERED — id is null.
    expect(parsed.shippedRows.length).toBe(2);
    expect(parsed.shippedRows.every(r => r.id === null)).toBe(true);
  });

  it('excludes tombstones from openRows', () => {
    const parsed = parseBuilderQueue(FIXTURE);
    expect(parsed.openRows.map(r => r.id).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 16, 17]);
    expect(parsed.openRows.map(r => r.id)).not.toContain(9);
    expect(parsed.openRows.map(r => r.id)).not.toContain(15);
  });

  it('throws loudly on markdown that has headings but yields zero rows (never a silent empty result)', () => {
    const broken = `# Builder Queue\n\n## Queue\n\n(no table here at all)\n`;
    expect(() => parseBuilderQueue(broken)).toThrow(BuilderQueueParseError);
  });

  it('throws loudly on empty input', () => {
    expect(() => parseBuilderQueue('')).toThrow(BuilderQueueParseError);
  });
});
