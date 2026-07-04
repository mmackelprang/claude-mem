// SPDX-License-Identifier: Apache-2.0
//
// Unit test for the server vector-recall helper. We spy the repository +
// ChromaSync prototypes so no Postgres pool and no chroma-mcp subprocess are
// touched. Focus: FTS-vs-Chroma routing, rank preservation, degrade-to-FTS,
// and — OVERRIDE-A, security-critical — the visibility `where` mirror + the
// viewerActorId forwarding into the FTS fallbacks.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { ChromaObservationRecall } from '../../../src/server/recall/ChromaObservationRecall.js';
import {
  PostgresObservationRepository,
  type PostgresObservation,
} from '../../../src/storage/postgres/observations.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { logger } from '../../../src/utils/logger.js';

const scope = { projectId: 'proj-1', teamId: 'team-1' };

function makeObs(id: string, content = `content-${id}`): PostgresObservation {
  return {
    id,
    projectId: scope.projectId,
    teamId: scope.teamId,
    serverSessionId: null,
    kind: 'discovery',
    content,
    generationKey: null,
    metadata: {},
    embedding: null,
    createdByJobId: null,
    actorId: null,
    apiKeyId: null,
    visibility: 'team',
    createdAtEpoch: 1_720_000_000_000,
    updatedAtEpoch: 1_720_000_000_000,
  };
}

function makeRecall(chromaEnabled: boolean): ChromaObservationRecall {
  return new ChromaObservationRecall({ pool: {} as never, chromaEnabled });
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

describe('ChromaObservationRecall.buildWhere (visibility mirror)', () => {
  it('appends team/org-only visibility clause when no viewerActorId (private excluded)', () => {
    const where = ChromaObservationRecall.buildWhere(scope, {});
    expect(where).toEqual({
      $and: [
        { projectId: 'proj-1' },
        { teamId: 'team-1' },
        { visibility: { $in: ['team', 'org'] } },
      ],
    });
  });

  it('appends the $or (team/org OR own author) when viewerActorId is set', () => {
    const where = ChromaObservationRecall.buildWhere(scope, { viewerActorId: 'human:alice' });
    expect(where).toEqual({
      $and: [
        { projectId: 'proj-1' },
        { teamId: 'team-1' },
        { $or: [
          { visibility: { $in: ['team', 'org'] } },
          { actorId: 'human:alice' },
        ]},
      ],
    });
  });

  it('adds the narrowing actorId clause before the visibility clause', () => {
    const where = ChromaObservationRecall.buildWhere(scope, {
      actorId: 'human:bob',
      viewerActorId: 'human:bob',
    });
    expect(where).toEqual({
      $and: [
        { projectId: 'proj-1' },
        { teamId: 'team-1' },
        { actorId: 'human:bob' },
        { $or: [
          { visibility: { $in: ['team', 'org'] } },
          { actorId: 'human:bob' },
        ]},
      ],
    });
  });
});

describe('ChromaObservationRecall.search', () => {
  it('chromaEnabled:false → FTS only, never calls Chroma, forwards actorId + viewerActorId', async () => {
    const searchSpy = track(spyOn(PostgresObservationRepository.prototype, 'search')
      .mockResolvedValue([makeObs('a')]));
    const chromaSpy = track(spyOn(ChromaSync.prototype, 'queryChromaByScope')
      .mockResolvedValue({ ids: [], distances: [], metadatas: [] }));

    const recall = makeRecall(false);
    const result = await recall.search({
      projectId: scope.projectId, teamId: scope.teamId, query: 'q', limit: 20,
      filter: { actorId: 'human:bob', platformSource: 'cli', viewerActorId: 'human:alice' },
    });

    expect(result.chroma).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.observations.map(o => o.id)).toEqual(['a']);
    expect(chromaSpy).not.toHaveBeenCalled();
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][0]).toMatchObject({
      projectId: scope.projectId, teamId: scope.teamId, query: 'q', limit: 20,
      platformSource: 'cli', actorId: 'human:bob', viewerActorId: 'human:alice',
    });
  });

  it('empty query → FTS filter-only even when Chroma is enabled', async () => {
    const searchSpy = track(spyOn(PostgresObservationRepository.prototype, 'search')
      .mockResolvedValue([makeObs('a')]));
    const chromaSpy = track(spyOn(ChromaSync.prototype, 'queryChromaByScope')
      .mockResolvedValue({ ids: [], distances: [], metadatas: [] }));

    const recall = makeRecall(true);
    const result = await recall.search({
      projectId: scope.projectId, teamId: scope.teamId, query: '   ', limit: 10,
      filter: { viewerActorId: 'human:alice' },
    });

    expect(result).toMatchObject({ chroma: false, degraded: false });
    expect(chromaSpy).not.toHaveBeenCalled();
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ viewerActorId: 'human:alice' });
  });

  it('Chroma path preserves the semantic rank order of hydrated rows', async () => {
    track(spyOn(ChromaSync.prototype, 'queryChromaByScope')
      .mockResolvedValue({ ids: ['uuid-B', 'uuid-A'], distances: [0.1, 0.2], metadatas: [null, null] }));
    const getSpy = track(spyOn(PostgresObservationRepository.prototype, 'getByIdForScope')
      .mockImplementation(async ({ id }) => makeObs(id)));
    const searchSpy = track(spyOn(PostgresObservationRepository.prototype, 'search')
      .mockResolvedValue([]));

    const recall = makeRecall(true);
    const result = await recall.search({
      projectId: scope.projectId, teamId: scope.teamId, query: 'semantic', limit: 5,
      filter: { viewerActorId: 'human:alice' },
    });

    expect(result).toMatchObject({ chroma: true, degraded: false });
    expect(result.observations.map(o => o.id)).toEqual(['uuid-B', 'uuid-A']);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('Chroma returning zero ids → empty result, still chroma:true (not degraded)', async () => {
    track(spyOn(ChromaSync.prototype, 'queryChromaByScope')
      .mockResolvedValue({ ids: [], distances: [], metadatas: [] }));
    const getSpy = track(spyOn(PostgresObservationRepository.prototype, 'getByIdForScope')
      .mockResolvedValue(null));

    const recall = makeRecall(true);
    const result = await recall.search({
      projectId: scope.projectId, teamId: scope.teamId, query: 'semantic', limit: 5,
    });

    expect(result).toMatchObject({ chroma: true, degraded: false });
    expect(result.observations).toEqual([]);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('Chroma throw → degrades to FTS with viewerActorId forwarded, logs error', async () => {
    track(spyOn(ChromaSync.prototype, 'queryChromaByScope')
      .mockRejectedValue(new Error('chroma-mcp subprocess closed')));
    const searchSpy = track(spyOn(PostgresObservationRepository.prototype, 'search')
      .mockResolvedValue([makeObs('fts-1')]));
    const errSpy = track(spyOn(logger, 'error').mockImplementation(() => {}));

    const recall = makeRecall(true);
    const result = await recall.search({
      projectId: scope.projectId, teamId: scope.teamId, query: 'semantic', limit: 7,
      filter: { platformSource: 'api', actorId: 'human:bob', viewerActorId: 'human:alice' },
    });

    expect(result).toMatchObject({ chroma: false, degraded: true });
    expect(result.observations.map(o => o.id)).toEqual(['fts-1']);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][0]).toMatchObject({
      platformSource: 'api', actorId: 'human:bob', viewerActorId: 'human:alice', limit: 7,
    });
  });
});
