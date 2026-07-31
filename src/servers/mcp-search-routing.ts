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
// Kept free of imports that start a transport or perform writes at module
// load, so it can be unit-tested WITHOUT importing mcp-server.ts, which starts
// the stdio transport at import time.
//
// The `logger` import added below preserves that goal but does NOT make this
// module import-inert, and the difference matters:
//   * utils/logger.ts starts no transport and opens no log file at import (the
//     file handle and the log level are both resolved lazily on the first
//     call), and its transitive graph is only shared/paths + shared/hook-io +
//     shared/atomic-json.
//   * BUT shared/paths.ts evaluates `export const DATA_DIR = resolveDataDir()`
//     at module load, which existsSync/readFileSync's <dataDir>/settings.json
//     and then FREEZES DATA_DIR. So importing this module now transitively
//     performs a read-only settings probe and pins the data dir — a test that
//     sets CLAUDE_MEM_DATA_DIR *after* importing this file is ignored.
//     tests/preload.ts sets it first, so this is a constraint to preserve, not
//     a live bug.
//   * The first logger call additionally reads settings.json once for the log
//     level (Logger.getLevel), memoized thereafter.
// mcp-server.ts, this module's own consumer, already imports logger (line 5),
// and tests/servers/mcp-search-routing.test.ts still imports only this file.

import { normalizePlatformSource } from '../shared/platform-source.js';
import { logger } from '../utils/logger.js';
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
const UNSUPPORTED_SERVER_FILTER_KEYS = [
  'project',
  'obs_type',
  'dateStart',
  'dateEnd',
  'offset',
  'orderBy',
  'files',
  'filePath',
  'concepts',
  'concept',
  'isFolder',
  'platform_source',
] as const satisfies ReadonlyArray<keyof SearchToolArgs>;

/** The offending keys, so the fallback log can name WHICH filter forced it. */
function unsupportedServerFilters(args: SearchToolArgs): string[] {
  return UNSUPPORTED_SERVER_FILTER_KEYS.filter(key => args[key] !== undefined);
}

/**
 * Decide whether a `search` invocation routes to the server (/v1/search) or
 * the worker (/api/search). The returned route is a pure function of the
 * arguments — no network, no throws, and no branch reads settings. The only
 * side effect is a debug log of the outcome, which lazily reads settings.json
 * once (memoized) to resolve the log level.
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

  const unsupportedFilters = unsupportedServerFilters(args);

  if (
    serverAvailable &&
    projectId !== undefined &&
    hasText &&
    typeIsObservations &&
    unsupportedFilters.length === 0
  ) {
    const request: ServerSearchObservationsRequest = {
      projectId,
      query: args.query as string,
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      ...(typeof args.platformSource === 'string' && args.platformSource.trim().length > 0
        ? { platformSource: normalizePlatformSource(args.platformSource) }
        : {}),
    };
    // Never log `query` — it is user prompt text.
    logger.debug('SEARCH', 'search routed to server (/v1/search)', undefined, {
      projectId,
      limit: request.limit ?? null,
      platformSource: request.platformSource ?? null,
    });
    return { target: 'server', request };
  }

  // The #3082 symptom ("search returns 0 results in server mode") is really
  // "the request silently fell back to the frozen local worker". Recording the
  // precondition that failed turns that into a one-line log read.
  const fallbackReasons: string[] = [];
  if (!serverAvailable) fallbackReasons.push('serverUnavailable');
  if (projectId === undefined) fallbackReasons.push('missingProjectId');
  if (!hasText) fallbackReasons.push('noQueryText');
  if (!typeIsObservations) fallbackReasons.push('nonObservationsType');
  if (unsupportedFilters.length > 0) {
    fallbackReasons.push(`unsupportedFilters(${unsupportedFilters.join(',')})`);
  }
  logger.debug('SEARCH', 'search fell back to worker (/api/search)', undefined, {
    fallbackReasons,
    type: typeof args.type === 'string' ? args.type : null,
  });

  return { target: 'worker' };
}
