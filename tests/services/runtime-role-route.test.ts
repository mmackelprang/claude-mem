import { describe, it, expect } from 'bun:test';
import { resolveRuntimeRole } from '../../src/services/worker/http/routes/RuntimeRoleRoutes.js';

describe('resolveRuntimeRole', () => {
  it('returns worker for CLAUDE_MEM_RUNTIME=worker', () => {
    expect(resolveRuntimeRole({ CLAUDE_MEM_RUNTIME: 'worker' } as any)).toBe('worker');
  });
  it('returns server for CLAUDE_MEM_RUNTIME=server', () => {
    expect(resolveRuntimeRole({ CLAUDE_MEM_RUNTIME: 'server' } as any)).toBe('server');
  });
  it('returns unknown for an unrecognized value', () => {
    expect(resolveRuntimeRole({ CLAUDE_MEM_RUNTIME: 'weird' } as any)).toBe('unknown');
  });
});
