// SPDX-License-Identifier: Apache-2.0
//
// #3082 — the `search` MCP tool must route to the PG-backed /v1/search under
// CLAUDE_MEM_RUNTIME=server and to the worker /api/search otherwise. We test
// the pure routing decision directly (mcp-server.ts cannot be imported: it
// starts the stdio transport at import time).

import { describe, it, expect } from 'bun:test';
import { decideSearchRoute } from '../../src/servers/mcp-search-routing.js';

const PROJECT = 'proj-uuid-1';

describe('decideSearchRoute (#3082 runtime-aware search)', () => {
  it('routes a plain text observation query to the server (/v1/search) under server runtime', () => {
    const route = decideSearchRoute({ query: 'auth bug' }, true, PROJECT);
    expect(route.target).toBe('server');
    if (route.target === 'server') {
      expect(route.request).toEqual({ projectId: PROJECT, query: 'auth bug' });
    }
  });

  it('forwards limit and platformSource to /v1/search (extension beyond PR #3082)', () => {
    const route = decideSearchRoute(
      { query: 'auth bug', limit: 5, platformSource: 'claude' },
      true,
      PROJECT,
    );
    expect(route.target).toBe('server');
    if (route.target === 'server') {
      expect(route.request.limit).toBe(5);
      expect(route.request.platformSource).toBe('claude');
    }
  });

  it('falls back to the worker (/api/search) when the runtime is not server', () => {
    expect(decideSearchRoute({ query: 'auth bug' }, false, PROJECT).target).toBe('worker');
  });

  it('falls back to the worker for prompt/session-typed queries', () => {
    expect(decideSearchRoute({ query: 'x', type: 'prompts' }, true, PROJECT).target).toBe('worker');
    expect(decideSearchRoute({ query: 'x', type: 'sessions' }, true, PROJECT).target).toBe('worker');
  });

  it('falls back to the worker for filter-only (no text) queries', () => {
    expect(decideSearchRoute({ project: 'claude-mem' }, true, PROJECT).target).toBe('worker');
  });

  it('falls back to the worker for filters /v1/search cannot honor', () => {
    const unsupported: Array<Record<string, unknown>> = [
      { query: 'x', project: 'other' },
      { query: 'x', obs_type: 'decision' },
      { query: 'x', dateStart: '2026-01-01' },
      { query: 'x', dateEnd: '2026-02-01' },
      { query: 'x', offset: 20 },
      { query: 'x', orderBy: 'date_asc' },
    ];
    for (const args of unsupported) {
      expect(decideSearchRoute(args, true, PROJECT).target).toBe('worker');
    }
  });

  it('falls back to the worker for worker-only filter aliases /v1/search cannot honor', () => {
    // additionalProperties:true lets these through; the worker recognizes them
    // (SearchManager.normalizeParams) but /v1/search silently ignores them, so
    // a text query carrying one must stay on the worker to avoid unscoped results.
    const aliasFiltered: Array<Record<string, unknown>> = [
      { query: 'x', files: 'a.ts' },
      { query: 'x', filePath: 'a.ts' },
      { query: 'x', concepts: 'auth' },
      { query: 'x', concept: 'auth' },
      { query: 'x', isFolder: 'true' },
      { query: 'x', platform_source: 'codex' },
    ];
    for (const args of aliasFiltered) {
      expect(decideSearchRoute(args, true, PROJECT).target).toBe('worker');
    }
  });

  it('falls back to the worker when the server context has no projectId', () => {
    expect(decideSearchRoute({ query: 'x' }, true, undefined).target).toBe('worker');
  });
});
