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
  // Worker-only filter aliases. The `search` tool schema sets
  // additionalProperties:true and the worker's SearchManager.normalizeParams
  // recognizes these (files/filePath, concepts/concept, isFolder, and the
  // snake_case platform_source) as real filters. /v1/search honors none of
  // them, so a query carrying one must fall back to the worker rather than
  // silently drop the filter and return unscoped results.
  files?: unknown;
  filePath?: unknown;
  concepts?: unknown;
  concept?: unknown;
  isFolder?: unknown;
  platform_source?: unknown;
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
    args.orderBy !== undefined ||
    args.files !== undefined ||
    args.filePath !== undefined ||
    args.concepts !== undefined ||
    args.concept !== undefined ||
    args.isFolder !== undefined ||
    args.platform_source !== undefined
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
