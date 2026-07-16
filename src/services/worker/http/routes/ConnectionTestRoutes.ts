// SPDX-License-Identifier: Apache-2.0
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';

export type StepStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type StepName = 'reachable' | 'authenticated' | 'project';

export interface StepResult {
  step: StepName;
  status: StepStatus;
  code: string;
  http?: number;
  latencyMs?: number;
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  runtime: 'worker' | 'server';
  steps: StepResult[];
  checkedAt: string;
  totalMs: number;
  timeoutSeconds: number;
}

export const connectionTestSchema = z.object({
  runtime: z.enum(['worker', 'server']),
  url: z.string(),
  apiKey: z.string(),
  projectId: z.string(),
}).passthrough();

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Join a base URL and a path without double slashes. */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

function isClaudeMemHealth(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as any).status === 'ok';
}

/** GET with a hard per-step timeout; classifies transport failures. */
async function timedGet(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: any; latencyMs: number } | { error: 'timeout' | 'tls' | 'network' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const latencyMs = Date.now() - started;
    let body: any = {};
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body, latencyMs };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (name === 'AbortError') return { error: 'timeout' };
    if (msg.includes('certificate') || msg.includes('tls') || msg.includes('ssl')) return { error: 'tls' };
    return { error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure 3-step probe. No persistence. The apiKey is used ONLY to build the
 * Authorization header — it is never returned in ProbeResult and never logged.
 */
export async function probeConnection(
  input: { runtime: 'worker' | 'server'; url: string; apiKey: string; projectId: string },
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const startedAll = Date.now();
  const steps: StepResult[] = [];
  const host = hostOf(input.url);

  const finish = (): ProbeResult => {
    const ok = steps.every(s => s.status === 'pass' || s.status === 'warn');
    // Structured log — NEVER includes apiKey.
    logger.info('WORKER', 'connection test probe', { host, ok, codes: steps.map(s => `${s.step}:${s.code}`) });
    return { ok, runtime: 'server', steps, checkedAt: new Date().toISOString(), totalMs: Date.now() - startedAll, timeoutSeconds };
  };

  if (input.runtime === 'worker') {
    return { ok: true, runtime: 'worker', steps: [], checkedAt: new Date().toISOString(), totalMs: 0, timeoutSeconds };
  }

  const skip = (step: StepName): StepResult => ({
    step, status: 'skipped', code: 'skipped_upstream_failed', message: 'Skipped — fix the step above first.',
  });

  // ---- Step 1: reachable ----
  let scheme = '';
  try { scheme = new URL(input.url).protocol; } catch { /* handled below */ }
  if (scheme !== 'http:' && scheme !== 'https:') {
    steps.push({ step: 'reachable', status: 'fail', code: 'bad_url', message: 'That doesn’t look like a valid URL. Expected e.g. http://nas.lan:37700.' });
    steps.push(skip('authenticated'), skip('project'));
    return finish();
  }

  const health = await timedGet(fetchImpl, joinUrl(input.url, '/healthz'), {}, timeoutMs);
  if ('error' in health) {
    const code = health.error === 'timeout' ? 'timeout' : health.error === 'tls' ? 'tls_error' : 'unreachable';
    const message =
      code === 'timeout' ? `${host} didn’t respond in ${timeoutSeconds}s. Check the address and that it’s reachable from here.`
      : code === 'tls_error' ? `Reached ${host} but its TLS certificate was rejected.`
      : `Couldn’t reach ${host}. Is the server running and on this network?`;
    steps.push({ step: 'reachable', status: 'fail', code, message });
    steps.push(skip('authenticated'), skip('project'));
    return finish();
  }
  if (health.status !== 200 || !isClaudeMemHealth(health.body)) {
    steps.push({ step: 'reachable', status: 'fail', code: 'not_claude_mem', http: health.status, message: `Reached ${host}, but it doesn’t look like a claude-mem server.` });
    steps.push(skip('authenticated'), skip('project'));
    return finish();
  }
  steps.push({ step: 'reachable', status: 'pass', code: 'ok', http: 200, latencyMs: health.latencyMs, message: `Server responded (200) in ${health.latencyMs} ms.` });

  // ---- Step 2: authenticated (GET /v1/projects, scope memories:read) ----
  if (!input.apiKey) {
    steps.push({ step: 'authenticated', status: 'fail', code: 'missing_key', message: 'This server requires an API key. Add one to continue.' });
    steps.push(skip('project'));
    return finish();
  }
  const authHeaders = { Authorization: `Bearer ${input.apiKey}`, 'X-Api-Key': input.apiKey };
  const auth = await timedGet(fetchImpl, joinUrl(input.url, '/v1/projects'), authHeaders, timeoutMs);
  if ('error' in auth) {
    const code = auth.error === 'timeout' ? 'timeout' : 'unreachable';
    steps.push({ step: 'authenticated', status: 'fail', code, message: `Couldn’t complete the auth check against ${host}.` });
    steps.push(skip('project'));
    return finish();
  }
  if (auth.status === 401) {
    steps.push({ step: 'authenticated', status: 'fail', code: 'missing_key', http: 401, message: 'This server requires an API key. Add one to continue.' });
    steps.push(skip('project'));
    return finish();
  }
  if (auth.status >= 400) {
    // Real server: 403 = invalid key OR insufficient scope (indistinguishable here).
    steps.push({ step: 'authenticated', status: 'fail', code: 'unauthorized', http: auth.status, message: `The server rejected the API key (${auth.status}). Double-check the key.` });
    steps.push(skip('project'));
    return finish();
  }
  steps.push({ step: 'authenticated', status: 'pass', code: 'ok', http: auth.status, message: 'API key accepted.' });

  // ---- Step 3: project valid (GET /v1/projects/:id) ----
  if (!input.projectId) {
    steps.push({ step: 'project', status: 'fail', code: 'missing_project', message: 'Enter a project ID for this connection.' });
    return finish();
  }
  const proj = await timedGet(fetchImpl, joinUrl(input.url, `/v1/projects/${encodeURIComponent(input.projectId)}`), authHeaders, timeoutMs);
  if ('error' in proj) {
    steps.push({ step: 'project', status: 'fail', code: 'timeout', message: `Couldn’t verify the project against ${host}.` });
    return finish();
  }
  if (proj.status === 200) {
    steps.push({ step: 'project', status: 'pass', code: 'ok', http: 200, message: `Project “${input.projectId}” is ready.` });
  } else if (proj.status === 404) {
    steps.push({ step: 'project', status: 'warn', code: 'project_will_be_created', http: 404, message: `Project “${input.projectId}” is new — it’ll be created on the first capture.` });
  } else if (proj.status === 403) {
    steps.push({ step: 'project', status: 'fail', code: 'project_forbidden', http: 403, message: `This key can’t write to project “${input.projectId}” (403).` });
  } else {
    steps.push({ step: 'project', status: 'fail', code: 'project_forbidden', http: proj.status, message: `Couldn’t verify project “${input.projectId}” (${proj.status}).` });
  }
  return finish();
}

export class ConnectionTestRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.post('/api/connection/test', validateBody(connectionTestSchema), this.handleTest.bind(this));
  }

  private handleTest = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { runtime, url, apiKey, projectId } = req.body as z.infer<typeof connectionTestSchema>;
    const result = await probeConnection({ runtime, url, apiKey, projectId });
    res.json(result); // ProbeResult carries no apiKey field by construction.
  });
}
