import { describe, it, expect, spyOn } from 'bun:test';
import { probeConnection } from '../../src/services/worker/http/routes/ConnectionTestRoutes.js';
import { logger } from '../../src/utils/logger.js';

describe('connection test — no key in logs', () => {
  it('never passes the apiKey to the logger', async () => {
    const spy = spyOn(logger, 'info');
    await probeConnection(
      { runtime: 'server', url: 'https://nas:1', apiKey: 'sk-LEAKME', projectId: 'p' },
      { fetchImpl: (async () => ({ status: 200, ok: true, json: async () => ({ status: 'ok' }) })) as any },
    );
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('sk-LEAKME');
    }
  });
});
