import { describe, it, expect } from 'bun:test';
import { parseConnections, serializeConnections, withLocalWorker, LOCAL_WORKER_ID } from '../../src/ui/viewer/lib/connections.js';

describe('connections lib', () => {
  it('round-trips profiles', () => {
    const profiles = [{ id: 'a', name: 'A', runtime: 'server' as const, url: 'http://x:1', apiKey: 'k', projectId: 'p' }];
    expect(parseConnections(serializeConnections(profiles))).toEqual(profiles);
  });
  it('drops malformed entries', () => {
    expect(parseConnections('[{"id":1}]')).toEqual([]);
    expect(parseConnections('not json')).toEqual([]);
  });
  it('withLocalWorker prepends the undeletable worker', () => {
    const out = withLocalWorker([]);
    expect(out[0].id).toBe(LOCAL_WORKER_ID);
  });
});
