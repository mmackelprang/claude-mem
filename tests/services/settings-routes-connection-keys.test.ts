import { describe, it, expect } from 'bun:test';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

// Reach the private validator via a thin subclass so we don't stand up Express.
class TestableSettingsRoutes extends SettingsRoutes {
  public runValidate(body: unknown) {
    // @ts-expect-error — exercising the private validator directly.
    return this.validateSettings(body);
  }
}
const routes = new TestableSettingsRoutes({} as any);

describe('validateSettings — connection keys', () => {
  it('accepts a well-formed CLAUDE_MEM_CONNECTIONS array', () => {
    const body = { CLAUDE_MEM_CONNECTIONS: JSON.stringify([{ id: 'a', name: 'A', runtime: 'server', url: 'http://x:1', apiKey: 'k', projectId: 'p' }]) };
    expect(routes.runValidate(body).valid).toBe(true);
  });
  it('rejects CLAUDE_MEM_CONNECTIONS that is not JSON', () => {
    expect(routes.runValidate({ CLAUDE_MEM_CONNECTIONS: 'not json' }).valid).toBe(false);
  });
  it('rejects CLAUDE_MEM_CONNECTIONS that is not an array', () => {
    expect(routes.runValidate({ CLAUDE_MEM_CONNECTIONS: JSON.stringify({ id: 'x' }) }).valid).toBe(false);
  });
  it('rejects a profile with an invalid runtime', () => {
    const body = { CLAUDE_MEM_CONNECTIONS: JSON.stringify([{ id: 'a', name: 'A', runtime: 'nope', url: '', apiKey: '', projectId: '' }]) };
    expect(routes.runValidate(body).valid).toBe(false);
  });
  it('rejects an invalid CLAUDE_MEM_RUNTIME', () => {
    expect(routes.runValidate({ CLAUDE_MEM_RUNTIME: 'banana' }).valid).toBe(false);
  });
  it('accepts CLAUDE_MEM_RUNTIME server|worker', () => {
    expect(routes.runValidate({ CLAUDE_MEM_RUNTIME: 'server' }).valid).toBe(true);
    expect(routes.runValidate({ CLAUDE_MEM_RUNTIME: 'worker' }).valid).toBe(true);
  });
});
