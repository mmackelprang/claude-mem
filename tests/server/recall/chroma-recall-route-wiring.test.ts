// SPDX-License-Identifier: Apache-2.0
//
// Phase 4 route-wiring integration lock: /v1/search + /v1/context flow through
// the injected ChromaObservationRecall (not repo.search directly), forward the
// reader's viewerActorId into the recall filter, return the recall's rows, and
// audit `via`/`degraded`. Postgres-gated like the sibling server route tests;
// skips without CLAUDE_MEM_TEST_POSTGRES_URL.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { ChromaObservationRecall, ChromaRecallResult } from '../../../src/server/recall/ChromaObservationRecall.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import type { PostgresObservation } from '../../../src/storage/postgres/observations.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('Phase 4 — /v1 read surfaces route through ChromaObservationRecall', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  let apiKeyRaw: string;
  let seeded: PostgresObservation;
  let capturedFilters: Array<Record<string, unknown> | undefined>;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_recall_wire_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;

    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId,
      actorId: 'human:alice',
      scopes: ['memories:read'],
    });

    seeded = await storage.observations.create({
      projectId, teamId, kind: 'manual',
      content: 'The recall stub row that the vector path returns.',
    });

    capturedFilters = [];
    const stubRecall = {
      search: async (input: { filter?: Record<string, unknown> }): Promise<ChromaRecallResult> => {
        capturedFilters.push(input.filter);
        return { observations: [seeded], chroma: true, degraded: false };
      },
    } as unknown as ChromaObservationRecall;

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
      runtime: 'server-beta',
      chromaRecall: stubRecall,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  async function postSearch(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKeyRaw}` },
      body: JSON.stringify({ projectId, query: 'anything semantic' }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('/v1/search returns the recall stub rows and audits via:chroma, degraded:false', async () => {
    const { status, body } = await postSearch('/v1/search');
    expect(status).toBe(200);
    expect(body.observations.map((o: { id: string }) => o.id)).toEqual([seeded.id]);

    // Reader's actor flows into the recall filter (visibility mirror parity).
    expect(capturedFilters[0]).toMatchObject({ viewerActorId: 'human:alice' });

    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE team_id = $1 AND action = 'observation.read'`,
      [teamId],
    );
    const searchRow = audit.rows
      .map((r: { details: { mode?: string; via?: string; degraded?: boolean } }) => r.details)
      .find((d) => d?.mode === 'search');
    expect(searchRow?.via).toBe('chroma');
    expect(searchRow?.degraded).toBe(false);
  });

  it('/v1/context returns the recall stub rows + concatenated context, audits via:chroma', async () => {
    const { status, body } = await postSearch('/v1/context');
    expect(status).toBe(200);
    expect(body.observations.map((o: { id: string }) => o.id)).toEqual([seeded.id]);
    expect(body.context).toContain('recall stub row');
    expect(capturedFilters[0]).toMatchObject({ viewerActorId: 'human:alice' });

    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE team_id = $1 AND action = 'observation.read'`,
      [teamId],
    );
    const contextRow = audit.rows
      .map((r: { details: { mode?: string; via?: string } }) => r.details)
      .find((d) => d?.mode === 'context');
    expect(contextRow?.via).toBe('chroma');
  });
});
