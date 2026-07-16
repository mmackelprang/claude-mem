import { describe, it, expect } from 'bun:test';
import { computeEffectiveRole } from '../../src/ui/viewer/hooks/useRuntimeRole.js';

describe('computeEffectiveRole', () => {
  it('a definite probe wins over any override', () => {
    expect(computeEffectiveRole('server', 'worker')).toBe('server');
    expect(computeEffectiveRole('worker', 'server')).toBe('worker');
  });
  it('falls back to override when the probe is unknown', () => {
    expect(computeEffectiveRole('unknown', 'server')).toBe('server');
  });
  it('defaults to worker when unknown and no override', () => {
    expect(computeEffectiveRole('unknown', null)).toBe('worker');
  });
});
