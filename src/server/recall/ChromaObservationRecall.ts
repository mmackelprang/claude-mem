// SPDX-License-Identifier: Apache-2.0
//
// Server/team-mode vector recall. Lifts the proven cmem-sdk client.search()
// algorithm — Chroma vector query → hydrate full rows from Postgres by UUID →
// Postgres FTS fallback on any Chroma failure. Hydration is ALWAYS from
// Postgres (ADR 0001 §4-A), never local SQLite.
// (The former src/sdk/index.ts was deleted upstream in v13.11.0; the live
// equivalent of these semantics is ProviderObservationGenerator's Chroma
// indexing path. See ADR 0002 §4.4.)
//
// OVERRIDE-A (security-critical): Phase 2 visibility is LIVE. buildWhere()
// mirrors PostgresObservationRepository.search()'s predicate onto the Chroma
// `where` filter, and every FTS fallback forwards viewerActorId, so a private
// observation authored by actor B is never returned to actor A through the
// Chroma path.
import { ChromaSync } from '../../services/sync/ChromaSync.js';
import {
  PostgresObservationRepository,
  type PostgresObservation,
} from '../../storage/postgres/observations.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { logger } from '../../utils/logger.js';

export interface ChromaRecallFilter {
  actorId?: string | null;          // optional narrowing filter (body.actorId)
  platformSource?: string | null;
  // Phase 2 (LIVE): the reader's resolved actor. Drives the visibility predicate
  // on BOTH the Chroma `where` and the FTS fallback, mirroring
  // PostgresObservationRepository.search(). Null => only team/org rows visible.
  viewerActorId?: string | null;
}

export interface ChromaRecallResult {
  observations: PostgresObservation[];
  chroma: boolean;    // true when the Chroma vector path produced the rows
  degraded: boolean;  // true when Chroma was expected but failed → FTS
}

export class ChromaObservationRecall {
  private readonly repo: PostgresObservationRepository;
  // Per-project ChromaSync memo: getCollectionName()/ensureCollectionExists()
  // are cheap and idempotent; caching avoids re-running ensure per request.
  private readonly syncByProject = new Map<string, ChromaSync>();

  constructor(private readonly options: { pool: PostgresPool; chromaEnabled: boolean }) {
    this.repo = new PostgresObservationRepository(options.pool);
  }

  static buildWhere(
    scope: { projectId: string; teamId: string },
    filter: ChromaRecallFilter,
  ): Record<string, unknown> {
    const clauses: Array<Record<string, unknown>> = [
      { projectId: scope.projectId },
      { teamId: scope.teamId },
    ];
    if (filter.actorId) clauses.push({ actorId: filter.actorId });
    // Phase 2 visibility — mirror PostgresObservationRepository.search()'s
    // predicate onto Chroma metadata (docs now always carry metadata.visibility).
    // team/org rows visible to the whole tenant; private rows only to their author.
    if (filter.viewerActorId) {
      clauses.push({ $or: [
        { visibility: { $in: ['team', 'org'] } },
        { actorId: filter.viewerActorId },
      ]});
    } else {
      clauses.push({ visibility: { $in: ['team', 'org'] } });
    }
    return clauses.length === 1 ? clauses[0]! : { $and: clauses };
  }

  private getSync(projectId: string): ChromaSync {
    let sync = this.syncByProject.get(projectId);
    if (!sync) { sync = new ChromaSync(projectId); this.syncByProject.set(projectId, sync); }
    return sync;
  }

  async search(input: {
    projectId: string;
    teamId: string;
    query: string;
    limit: number;
    filter?: ChromaRecallFilter;
  }): Promise<ChromaRecallResult> {
    const { projectId, teamId, query, limit } = input;
    const filter = input.filter ?? {};

    // FTS-only when Chroma is not enabled for the server path, or when the
    // query is empty (no semantic intent). Zero behavior change vs. today.
    if (!this.options.chromaEnabled || query.trim().length === 0) {
      const observations = await this.repo.search({
        projectId, teamId, query, limit,
        platformSource: filter.platformSource ?? null,
        actorId: filter.actorId ?? null,
        viewerActorId: filter.viewerActorId ?? null,   // Phase 2 parity
      });
      return { observations, chroma: false, degraded: false };
    }

    try {
      const sync = this.getSync(projectId);
      const where = ChromaObservationRecall.buildWhere({ projectId, teamId }, filter);
      const { ids } = await sync.queryChromaByScope({ query, limit, where });
      if (ids.length === 0) return { observations: [], chroma: true, degraded: false };
      // Hydrate from Postgres, preserving Chroma's semantic rank order. The
      // `where` is the security boundary — only allowed ids come back to hydrate.
      const hydrated: PostgresObservation[] = [];
      for (const id of ids) {
        const obs = await this.repo.getByIdForScope({ id, projectId, teamId });
        if (obs) hydrated.push(obs);
      }
      return { observations: hydrated, chroma: true, degraded: false };
    } catch (err) {
      logger.error(
        'CHROMA',
        'server vector recall failed; returning degraded FTS results — investigate chroma-mcp / Chroma service',
        { projectId, teamId, query }, err as Error,
      );
      const observations = await this.repo.search({
        projectId, teamId, query, limit,
        platformSource: filter.platformSource ?? null,
        actorId: filter.actorId ?? null,
        viewerActorId: filter.viewerActorId ?? null,   // Phase 2 parity
      });
      return { observations, chroma: false, degraded: true };
    }
  }
}
