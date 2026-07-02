---
Title: Fix plan — `search` MCP tool is not runtime-aware in server mode (#3082)
Status: Planned (Builder to implement on Mark's fork)
Related: PR #3082 (community, OPEN), ADR 0001 §9, §10 Q3; WS2 server-beta arc
---

## Bug Report

**Summary:** Under `CLAUDE_MEM_RUNTIME=server`, the MCP `search` tool returns **0 observations** (or a confusing worker-connection error) even though the observations exist in Postgres. `observation_search` returns them fine, so the data and server are healthy — only `search` is blind.

**Severity:** High — `search` is the advertised Step-1 entry point of the documented 3-layer memory workflow (`__IMPORTANT` tool). In team/server mode it is dead, which makes memory recall via the canonical tool unusable.

**Scope:** correctness bug on existing OPEN server-beta code. Independent of the IP-boundary question (ADR §11). Purely additive routing; local/worker mode behavior is unchanged.

---

## Root Cause (verified against current `main`)

The `search` handler is hard-wired to the worker `/api/search` path and never consults `selectRuntime()`:

- `src/servers/mcp-server.ts:592-595` — the `search` handler body is literally:
  ```ts
  handler: async (args: any) => {
    const endpoint = TOOL_ENDPOINT_MAP['search'];   // '/api/search'  (line 72-73)
    return await callWorkerAPI(endpoint, args);
  }
  ```
- `/api/search` reads the **local SQLite** via the Chroma-backed `SearchOrchestrator`. In server mode the local SQLite is frozen (generated observations live in Postgres), so observation text queries return empty.
- Compounding it: when `selectRuntime() === 'server'`, MCP **skips worker auto-start** (`src/servers/mcp-server.ts:1174-1177`). So depending on whether a worker happens to be running, the user sees either **0 observations** (frozen SQLite) or an **"Error calling Worker API"** transport failure (`callWorkerAPI` catch, `mcp-server.ts:105-114`). Both are the same defect: the tool surface is not runtime-aware.

The **runtime-aware pattern already exists** for the `observation_*` / `memory_*` tools, which route to `/v1/*` via `resolveServerToolContext()` → `requireServerForObservationTool()` (`src/servers/mcp-server.ts:244-303`) and call `ctx.client.searchObservations()` (`handleObservationSearch`, `mcp-server.ts:388-408`). The fix mirrors that pattern for `search`.

Server-side recall is Postgres-FTS via `POST /v1/search` (`ServerV1PostgresRoutes.ts:945-981`), backed by `PostgresObservationRepository.search()` (`src/storage/postgres/observations.ts:154-196`). That endpoint is gated by `readAuth` (`memories:read`) and its zod body accepts `{ projectId, query, limit?, platformSource? }` (`ServerV1PostgresRoutes.ts:946-951`).

### `timeline` and `get_observations` — same class, different remedy
Both are also hard-wired to the worker (`mcp-server.ts:611-614` → `/api/timeline`; `mcp-server.ts:631-633` → `/api/observations/batch`). They are **not runtime-aware either**, so in server mode they hit the same frozen-SQLite / no-worker failure. But unlike `search`, there is **no `/v1` equivalent**: both are the SQLite-era numeric-`id` workflow, and server observations are UUID-keyed. There is no `/v1/timeline` and no numeric-id batch endpoint (route audit: `ServerV1PostgresRoutes.ts` exposes `/v1/search`, `/v1/context`, `/v1/memories`, `/v1/events*`, `/v1/jobs*`, `/v1/sessions*` — none map to timeline or numeric-id fetch). So the correct fix for these two is a **graceful, explicit guard message** under server runtime, not routing.

---

## Decision — adopt-and-extend PR #3082

**PR #3082 (alessandropcostabr) is the right design and should be credited, but it CANNOT be merged as-is.** It was authored against a pre-rename tree and references symbols that no longer exist on `main`:

| PR #3082 symbol | Current `main` symbol |
|---|---|
| `resolveServerBetaToolContext()` | `resolveServerToolContext()` (`mcp-server.ts:244`) |
| `ServerBetaSearchObservationsRequest` | `ServerSearchObservationsRequest` (`server-client.ts:154`) |
| inline guard, no try/catch (greptile flagged) | wrap via existing `formatToolError` (`mcp-server.ts:263`) |

**What we adopt from PR #3082 (unchanged):** the four-part guard philosophy — route to `/v1/search` **only** when it can serve the request faithfully (server available, non-empty text query, `type` is `observations`/unset, and no filter the endpoint can't honor); otherwise fall back to the worker. The documented "known limitation" framing is correct.

**What we extend (the delta beyond PR #3082):**
1. **Re-target to current renamed symbols** (`resolveServerToolContext`, `ServerSearchObservationsRequest`).
2. **Support `platformSource` routing.** PR #3082 treated `platformSource` as an unsupported filter (forced worker fallback). Current `/v1/search` **does** accept `platformSource` (`ServerV1PostgresRoutes.ts:950,956,964`), so a `platformSource`-scoped text query can now route to the server. This is strictly better and preserves agent-scoped recall in server mode.
3. **Extract the routing decision into a side-effect-free module** so it is unit-testable. PR #3082 inlined the logic into the handler; `mcp-server.ts` cannot be imported in a test because it starts the stdio transport at import (`main()` at `mcp-server.ts:1189`) — which is exactly why the existing `mcp-tool-schemas.test.ts` resorts to source-text assertions. A separate pure module gives us a real behavioral test.
4. **Wrap the handler in `try/catch` → `formatToolError`**, resolving greptile's "missing try/catch on the only server-beta client call without one" finding.
5. **Add the `timeline` / `get_observations` server-runtime guard** (out of scope for PR #3082, in scope for this plan per the task).

Net: **adopt-and-extend**, not a clean cherry-pick and not from-scratch.

---

## Implementation Tasks (bite-sized, literal code)

### Task 1 — New side-effect-free routing module

Create `src/servers/mcp-search-routing.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Runtime-aware routing decision for the `search` MCP tool (#3082).
//
// The `search` tool historically always called the worker `/api/search`
// (local SQLite via the Chroma-backed SearchOrchestrator). Under
// CLAUDE_MEM_RUNTIME=server the local SQLite is frozen (generated
// observations live in Postgres) and MCP does not auto-start the worker, so
// the legacy path returns 0 observations (or a worker transport error). This
// module decides, purely from the tool args and the resolved server context,
// whether the request can be served faithfully by the PG-backed /v1/search
// (the same path observation_search uses) or must fall back to the worker.
//
// Kept side-effect-free (no import that runs work at module load) so it can be
// unit-tested WITHOUT importing mcp-server.ts, which starts the stdio
// transport at import time.

import { normalizePlatformSource } from '../shared/platform-source.js';
import type { ServerSearchObservationsRequest } from '../services/hooks/server-client.js';

export interface SearchToolArgs {
  query?: unknown;
  limit?: unknown;
  project?: unknown;
  platformSource?: unknown;
  type?: unknown;
  obs_type?: unknown;
  dateStart?: unknown;
  dateEnd?: unknown;
  offset?: unknown;
  orderBy?: unknown;
}

export interface SearchRouteServer {
  target: 'server';
  request: ServerSearchObservationsRequest;
}

export interface SearchRouteWorker {
  target: 'worker';
}

export type SearchRoute = SearchRouteServer | SearchRouteWorker;

// Filters the PG-backed /v1/search cannot honor today. `platformSource` and
// `limit` are intentionally EXCLUDED — /v1/search accepts both
// (ServerV1PostgresRoutes.ts:945-965), so a query carrying only those can
// still route to the server. `project` (a project NAME filter on the worker)
// is unsupported because /v1/search is scoped to the single projectId bound to
// the API key, not an arbitrary project name.
function hasUnsupportedServerFilter(args: SearchToolArgs): boolean {
  return (
    args.project !== undefined ||
    args.obs_type !== undefined ||
    args.dateStart !== undefined ||
    args.dateEnd !== undefined ||
    args.offset !== undefined ||
    args.orderBy !== undefined
  );
}

/**
 * Decide whether a `search` invocation routes to the server (/v1/search) or
 * the worker (/api/search). Pure: no I/O, no settings reads, no throws.
 *
 * @param args           the raw MCP tool arguments
 * @param serverAvailable true when selectRuntime()==='server' AND the server
 *                        context (url+key+projectId) resolved
 * @param serverProjectId the projectId from the resolved server context
 */
export function decideSearchRoute(
  args: SearchToolArgs,
  serverAvailable: boolean,
  serverProjectId: string | undefined,
): SearchRoute {
  const hasText = typeof args.query === 'string' && args.query.trim().length > 0;
  const typeIsObservations = args.type === undefined || args.type === 'observations';
  const projectId =
    typeof serverProjectId === 'string' && serverProjectId.trim().length > 0
      ? serverProjectId
      : undefined;

  if (
    serverAvailable &&
    projectId !== undefined &&
    hasText &&
    typeIsObservations &&
    !hasUnsupportedServerFilter(args)
  ) {
    const request: ServerSearchObservationsRequest = {
      projectId,
      query: args.query as string,
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      ...(typeof args.platformSource === 'string' && args.platformSource.trim().length > 0
        ? { platformSource: normalizePlatformSource(args.platformSource) }
        : {}),
    };
    return { target: 'server', request };
  }

  return { target: 'worker' };
}
```

### Task 2 — Wire the `search` handler to the router (runtime-aware)

In `src/servers/mcp-server.ts`, add the import near the other local imports (after line 41):

```ts
import { decideSearchRoute } from './mcp-search-routing.js';
```

Replace the `search` handler (`mcp-server.ts:592-595`) with:

```ts
    handler: async (args: any) => {
      // #3082 — `search` is runtime-aware. Under RUNTIME=server the local
      // worker SQLite is frozen (generated observations live in Postgres) and
      // MCP does not auto-start the worker, so the legacy /api/search path
      // returns 0 observations (or a worker transport error). Route
      // faithfully-serviceable queries to the PG-backed /v1/search (the same
      // path observation_search uses); everything else keeps the worker path,
      // which still owns prompts, cross-project name filters, date/offset/
      // orderBy, and worker-mode installs.
      try {
        const resolution = resolveServerToolContext();
        if (resolution && resolution.available) {
          const route = decideSearchRoute(args ?? {}, true, resolution.projectId);
          if (route.target === 'server') {
            return formatJsonResult(await resolution.client.searchObservations(route.request));
          }
        }
      } catch (error) {
        return formatToolError(error);
      }
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
```

Note: `resolveServerToolContext`, `formatJsonResult`, and `formatToolError` already exist and are in scope in this module (`mcp-server.ts:244,263,282`). The `try/catch` only wraps the server path; the worker fallback keeps its own error handling inside `callWorkerAPI`.

### Task 3 — Graceful server-runtime guard for `timeline` and `get_observations`

Add a helper next to the other formatter helpers in `src/servers/mcp-server.ts` (e.g. after `formatJsonResult`, ~line 289):

```ts
function serverRuntimeUnsupportedTool(
  toolName: string,
  alternative: string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{
      type: 'text' as const,
      text: `${toolName} is a worker-runtime tool and is not available under CLAUDE_MEM_RUNTIME=server. `
        + `It reads the local SQLite numeric-id store, which server mode does not use `
        + `(server observations are UUID-keyed in Postgres). Use ${alternative}, or set `
        + `CLAUDE_MEM_RUNTIME=worker.`,
    }],
    isError: true as const,
  };
}
```

Replace the `timeline` handler (`mcp-server.ts:611-614`) with:

```ts
    handler: async (args: any) => {
      if (selectRuntime() === 'server') {
        return serverRuntimeUnsupportedTool('timeline', 'observation_search / observation_context');
      }
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
```

Replace the `get_observations` handler (`mcp-server.ts:631-633`) with:

```ts
    handler: async (args: any) => {
      if (selectRuntime() === 'server') {
        return serverRuntimeUnsupportedTool(
          'get_observations',
          'observation_search (its results already carry full content)',
        );
      }
      return await callWorkerAPIPost('/api/observations/batch', args);
    }
```

`selectRuntime` is already imported (`mcp-server.ts:36`).

### Task 4 — Behavioral unit test (asserts /v1/* under server, /api/* under worker)

Create `tests/servers/mcp-search-routing.test.ts`:

```ts
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

  it('falls back to the worker when the server context has no projectId', () => {
    expect(decideSearchRoute({ query: 'x' }, true, undefined).target).toBe('worker');
  });
});
```

### Task 5 — Source-wiring guard (regression protection, existing style)

Add to `tests/servers/mcp-tool-schemas.test.ts` (mirrors the file's existing source-text guards) so the runtime-aware wiring can't be silently reverted:

```ts
  it('search handler is runtime-aware (routes to /v1 via decideSearchRoute) — #3082', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const searchSection = src.slice(src.indexOf("name: 'search'"), src.indexOf("name: 'timeline'"));
    expect(searchSection).toContain('decideSearchRoute');
    expect(searchSection).toContain('resolveServerToolContext');
    expect(searchSection).toContain('searchObservations');
    expect(src).toContain("import { decideSearchRoute } from './mcp-search-routing.js'");
  });

  it('timeline and get_observations guard against server runtime — #3082', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const timelineSection = src.slice(src.indexOf("name: 'timeline'"), src.indexOf("name: 'get_observations'"));
    const getObsSection = src.slice(src.indexOf("name: 'get_observations'"), src.indexOf("name: 'session_start_context'"));
    expect(timelineSection).toContain("selectRuntime() === 'server'");
    expect(getObsSection).toContain("selectRuntime() === 'server'");
  });
```

---

## Verification

- `bunx tsc --noEmit` (or the repo's typecheck task) clean.
- `bun test tests/servers/mcp-search-routing.test.ts tests/servers/mcp-tool-schemas.test.ts` green.
- `npm run build-and-sync`, then spawn the built MCP server with `CLAUDE_MEM_RUNTIME=server` and a valid server context:
  - `tools/call search {"query":"..."}` → returns Postgres observations (previously 0 / error).
  - `tools/call search {"query":"...","type":"prompts"}` → falls back to worker.
  - `tools/call timeline {"anchor":1}` → returns the explicit server-runtime guard message (not a raw worker-connection error).
- Worker mode regression: with `CLAUDE_MEM_RUNTIME` unset/`worker`, all three tools behave exactly as before.

## Self-review

- **No placeholders / TBD** — every task carries literal code.
- **Spec coverage** — search routing (Tasks 1-2), timeline/get_observations (Task 3), tests (Tasks 4-5).
- **Type consistency** — `ServerSearchObservationsRequest` optional `limit?: number`, `platformSource?: string | null`; `normalizePlatformSource(string): string`; decision fn only emits keys when present, matching `handleObservationSearch`.
- **Prime-invariant** — worker/local path is byte-for-byte unchanged when runtime≠server.

## Open decision for Mark (before Builder implements)

- **Q1.** Ship the `platformSource` routing extension (item 2 of the delta), or stay conservative and match PR #3082 exactly (platformSource → worker fallback)? Recommendation: ship it — `/v1/search` already accepts it and it preserves agent-scoped recall in server mode. Low risk.
