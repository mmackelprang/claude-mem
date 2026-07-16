import { describe, it, expect } from 'bun:test';
import { parsePrRefs } from '../../src/services/mission-control/parsePrRefs.js';

describe('parsePrRefs', () => {
  it('matches "PR #N" (case/space tolerant)', () => {
    expect(parsePrRefs('opened PR #22 and pr#17 and PR  #14')).toEqual([14, 17, 22]);
  });
  it('matches gh-resolved GitHub pull URLs', () => {
    expect(parsePrRefs('see https://github.com/mmackelprang/claude-mem/pull/24 for details')).toEqual([24]);
  });
  it('does NOT match bare #N (roadmap-row collision guard)', () => {
    expect(parsePrRefs('roadmap row #22 and issue #5')).toEqual([]);
  });
  it('dedupes across forms and sorts ascending', () => {
    expect(parsePrRefs('PR #24 then https://github.com/x/y/pull/24 then PR #9')).toEqual([9, 24]);
  });
  it('returns [] for empty/undefined', () => {
    expect(parsePrRefs('')).toEqual([]);
    // @ts-expect-error runtime guard
    expect(parsePrRefs(undefined)).toEqual([]);
  });
});
