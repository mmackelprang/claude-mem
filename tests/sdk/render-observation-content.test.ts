import { describe, expect, it } from 'bun:test';

import { renderObservationContent } from '../../src/server/generation/processGeneratedResponse.js';
import type { ParsedObservation } from '../../src/sdk/parser.js';

// #20 site c — pure, non-Postgres unit test. renderObservationContent builds
// content from ONLY title/subtitle/narrative/facts and ignores
// concepts/files_read/files_modified. A concepts-only or files-only
// observation therefore renders to '' and is dropped by the empty-content
// guard in persistGeneratedObservations. These tests LOCK that current
// behavior so Phase 2's fix has a documented before/after.

function obs(overrides: Partial<ParsedObservation>): ParsedObservation {
  return {
    type: 'discovery',
    title: null,
    subtitle: null,
    narrative: null,
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

describe('renderObservationContent (#20 site c — documents the silent server-path drop)', () => {
  it('renders empty for a concepts-only observation (this is the drop)', () => {
    const out = renderObservationContent(obs({ concepts: ['auth', 'oauth'] }));
    expect(out).toBe(''); // <- current behavior; Phase 2 changes this
  });

  it('renders empty for a files-only observation (this is the drop)', () => {
    const out = renderObservationContent(
      obs({ files_read: ['a.ts'], files_modified: ['b.ts'] }),
    );
    expect(out).toBe('');
  });

  it('renders empty for a concepts+files observation (title/narrative/facts absent)', () => {
    const out = renderObservationContent(
      obs({ concepts: ['caching'], files_read: ['x.ts'] }),
    );
    expect(out).toBe('');
  });

  it('renders title and facts normally', () => {
    const out = renderObservationContent(obs({ title: 'T', facts: ['f1'] }));
    expect(out).toContain('T');
    expect(out).toContain('- f1');
  });

  it('renders subtitle and narrative normally', () => {
    const out = renderObservationContent(
      obs({ subtitle: 'sub', narrative: 'the story' }),
    );
    expect(out).toContain('sub');
    expect(out).toContain('the story');
  });

  it('renders empty for a truly empty observation (all fields absent)', () => {
    expect(renderObservationContent(obs({}))).toBe('');
  });
});
