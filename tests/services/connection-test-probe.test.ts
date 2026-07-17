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
const OK = { status: 200, body: { status: 'ok' } };

describe('probeConnection', () => {
  it('worker runtime returns ok with no steps', async () => {
    const r = await probeConnection({ ...base, runtime: 'worker' }, { fetchImpl: stubFetch({}) as any });
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(0);
  });

  // ---- Postgres server-beta variant: auth via /v1/connect, project via /v1/projects/:id/jobs ----
  it('server-beta all-pass: /v1/connect 200 → auth ✓, /v1/projects/:id/jobs 200 → project ✓', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': OK,
        '/v1/connect': { status: 200, body: {} },
        '/v1/projects/proj/jobs': { status: 200, body: { jobs: [] } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('server-beta unknown project → /v1/projects/:id/jobs 404 → warn (still ok, not a key error)', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': OK,
        '/v1/connect': { status: 200, body: {} },
        '/v1/projects/proj/jobs': { status: 404, body: { error: 'Project not found' } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    const project = r.steps.find(s => s.step === 'project')!;
    expect(project.status).toBe('warn');
    expect(project.code).toBe('project_will_be_created');
    expect(project.message.toLowerCase()).not.toContain('key'); // 404 must never read as a key problem
  });

  it('server-beta wrong key → /v1/connect 403 → unauthorized (not incompatible)', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({ '/healthz': OK, '/v1/connect': { status: 403, body: { error: 'Forbidden' } } }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('unauthorized');
    expect(r.steps.find(s => s.step === 'project')!.status).toBe('skipped');
  });

  it('server-beta missing key → /v1/connect 401 → missing_key', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({ '/healthz': OK, '/v1/connect': { status: 401, body: {} } }) as any,
    });
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('missing_key');
  });

  // ---- Local worker variant: /v1/connect 404 → fall back to /v1/projects, project via /v1/projects/:id ----
  it('worker all-pass: /v1/connect 404 → /v1/projects 200 → auth ✓, /v1/projects/:id 200 → project ✓', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': OK,
        '/v1/connect': { status: 404, body: {} },
        '/v1/projects': { status: 200, body: { projects: [] } },
        '/v1/projects/proj': { status: 200, body: { project: { id: 'proj' } } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('worker unknown project → /v1/projects/:id 404 → warn', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': OK,
        '/v1/connect': { status: 404, body: {} },
        '/v1/projects': { status: 200, body: {} },
        '/v1/projects/proj': { status: 404, body: { error: 'NotFound' } },
      }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.find(s => s.step === 'project')!.code).toBe('project_will_be_created');
  });

  it('worker wrong key → /v1/connect 404 → /v1/projects 403 → unauthorized', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': OK,
        '/v1/connect': { status: 404, body: {} },
        '/v1/projects': { status: 403, body: { error: 'Forbidden' } },
      }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => s.step === 'authenticated')!.code).toBe('unauthorized');
    expect(r.steps.find(s => s.step === 'project')!.status).toBe('skipped');
  });

  // ---- The mislabel fix: a 404 must never be labeled a key error ----
  it('both auth endpoints 404 → incompatible_server (NOT a key error), project skipped', async () => {
    const r = await probeConnection(base, {
      fetchImpl: stubFetch({
        '/healthz': OK,
        '/v1/connect': { status: 404, body: {} },
        '/v1/projects': { status: 404, body: {} },
      }) as any,
    });
    expect(r.ok).toBe(false);
    const auth = r.steps.find(s => s.step === 'authenticated')!;
    expect(auth.code).toBe('incompatible_server');
    expect(auth.message.toLowerCase()).not.toContain('key'); // the 404→"bad key" mislabel is gone
    expect(auth.message.toLowerCase()).not.toContain('rejected');
    expect(r.steps.find(s => s.step === 'project')!.status).toBe('skipped');
  });

  it('empty key → missing_key (no auth call made)', async () => {
    const r = await probeConnection({ ...base, apiKey: '' }, {
      fetchImpl: stubFetch({ '/healthz': OK }) as any,
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
        '/healthz': OK,
        '/v1/connect': { status: 200, body: {} },
        '/v1/projects/proj/jobs': { status: 200, body: {} },
      }) as any,
    });
    expect(JSON.stringify(r)).not.toContain('sk-TOP-SECRET');
  });
});
