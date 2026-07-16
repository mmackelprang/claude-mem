import { describe, it, expect, mock } from 'bun:test';
import { probeConnection } from '../../src/services/worker/http/routes/ConnectionTestRoutes.js';

// A fetch stub keyed by URL suffix so each step is controllable.
function stubFetch(map: Record<string, { status: number; body?: unknown; throws?: string }>) {
  return mock(async (input: string) => {
    const match = Object.keys(map).find(k => input.endsWith(k));
    if (!match) throw new Error(`unexpected fetch ${input}`);
    const entry = map[match];
    if (entry.throws) { const e = new Error(entry.throws); (e as any).name = entry.throws; throw e; }
    return { status: entry.status, ok: entry.status < 400, json: async () => entry.body ?? {} } as Response;
  });
}

const base = { runtime: 'server' as const, url: 'https://nas:37700', apiKey: 'sk-good', projectId: 'proj' };

describe('probeConnection', () => {
  it('worker runtime returns ok with no steps', async () => {
    const r = await probeConnection({ ...base, runtime: 'worker' }, { fetchImpl: stubFetch({}) as any });
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(0);
  });

  it('all-pass path activates', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 200, body: { projects: [] } },
        '/v1/projects/proj': { status: 200, body: { project: { id: 'proj' } } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('unknown project → warn (still ok)', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 200, body: { projects: [] } },
        '/v1/projects/proj': { status: 404, body: { error: 'NotFound' } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    const project = r.steps.find(s => s.step === 'project')!;
    expect(project.status).toBe('warn');
    expect(project.code).toBe('project_will_be_created');
  });

  it('wrong key → 403 → auth fail, project skipped, not ok', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 403, body: { error: 'Forbidden' } },
      }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('unauthorized');
    expect(r.steps.find(s => s.step === 'project')!.status).toBe('skipped');
  });

  it('empty key → missing_key (no auth call made)', async () => {
    const r = await probeConnection({ ...base, apiKey: '' }, {
      fetchImpl: stubFetch({ '/healthz': { status: 200, body: { status: 'ok' } } }) as any,
    });
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('missing_key');
  });

  it('unreachable → step 1 fail, rest skipped', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({ '/healthz': { status: 0, throws: 'FetchError' } }) as any,
    });
    expect(r.steps[0].status).toBe('fail');
    expect(r.steps[0].code).toBe('unreachable');
  });

  it('bad url → bad_url, no fetch attempted', async () => {
    const r = await probeConnection({ ...base, url: 'file:///etc/passwd' }, { fetchImpl: stubFetch({}) as any });
    expect(r.steps[0].code).toBe('bad_url');
  });

  it('never echoes the apiKey in the response', async () => {
    const r = await probeConnection({ ...base, apiKey: 'sk-TOP-SECRET' }, {
      fetchImpl: stubFetch({
        '/healthz': { status: 200, body: { status: 'ok' } },
        '/v1/projects': { status: 200, body: {} },
        '/v1/projects/proj': { status: 200, body: {} },
      }) as any,
    });
    expect(JSON.stringify(r)).not.toContain('sk-TOP-SECRET');
  });
});
