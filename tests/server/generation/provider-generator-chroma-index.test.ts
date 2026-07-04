// SPDX-License-Identifier: Apache-2.0
//
// Phase 4 write-side lock: a completed server-beta generation indexes its
// freshly-persisted observations to Chroma when CLAUDE_MEM_CHROMA_ENABLED is
// 'true' (UUID-keyed docs carrying actorId/visibility metadata), never touches
// Chroma when the flag is unset, and treats a Chroma failure as degraded — the
// job still completes. Postgres-gated; skips without CLAUDE_MEM_TEST_POSTGRES_URL.
// ChromaSync.addDocuments is spied so no chroma-mcp subprocess is spawned.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';
import type { ChromaDocument } from '../../../src/services/sync/ChromaSync.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const VALID_XML =
  '<observation><type>discovery</type><title>OK</title><facts><fact>a durable fact</fact></facts></observation>';

class StubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  async generate() {
    return { rawText: VALID_XML, providerLabel: this.providerLabel };
  }
}

describe('ProviderObservationGenerator — Chroma write-side indexing (Phase 4)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;
  let priorChromaEnabled: string | undefined;
  let addDocsSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    priorChromaEnabled = process.env.CLAUDE_MEM_CHROMA_ENABLED;
    addDocsSpy = spyOn(ChromaSync.prototype, 'addDocuments').mockResolvedValue(1);

    client = await pool.connect();
    schemaName = `cm_p4_chroma_idx_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const event = await storage.agentEvents.create({
      projectId, teamId, sourceAdapter: 'api', eventType: 'tool_use',
      payload: { x: 1 }, occurredAt: new Date(),
    });
    eventId = event.id;
    const job = await storage.observationGenerationJobs.create({
      projectId, teamId, sourceType: 'agent_event', sourceId: event.id,
      agentEventId: event.id, jobType: 'observation_generate_for_event',
    });
    jobId = job.id;
  });

  afterEach(async () => {
    addDocsSpy.mockRestore();
    if (priorChromaEnabled === undefined) delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
    else process.env.CLAUDE_MEM_CHROMA_ENABLED = priorChromaEnabled;
    if (client) {
      try { await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`); } catch {}
      client.release();
    }
    pool.removeAllListeners('connect');
  });

  function makeJob(): Job<GenerateObservationsForEventJob> {
    return {
      id: 'bull-1',
      data: {
        kind: 'event', team_id: teamId, project_id: projectId,
        source_type: 'agent_event', source_id: eventId, generation_job_id: jobId,
        agent_event_id: eventId, api_key_id: null, actor_id: 'human:alice',
        source_adapter: 'api',
      },
    } as unknown as Job<GenerateObservationsForEventJob>;
  }

  function makeGenerator(): ProviderObservationGenerator {
    return new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider: new StubProvider(),
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);
  }

  it('indexes UUID-keyed docs with actorId + visibility metadata when the flag is true', async () => {
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'true';
    const result = await makeGenerator().process(makeJob());
    expect(result.status).toBe('completed');
    expect(result.observationCount).toBeGreaterThan(0);

    expect(addDocsSpy).toHaveBeenCalledTimes(1);
    const docs = addDocsSpy.mock.calls[0][0] as ChromaDocument[];
    expect(docs.length).toBe(result.observationCount);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const doc of docs) {
      expect(doc.id).toMatch(uuidRe);
      expect(doc.metadata.projectId).toBe(projectId);
      expect(doc.metadata.teamId).toBe(teamId);
      expect(doc.metadata.actorId).toBe('human:alice');
      expect(typeof doc.metadata.visibility).toBe('string');
    }
  });

  it('never touches Chroma when the flag is unset (Postgres-only, today\'s behavior)', async () => {
    delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
    const result = await makeGenerator().process(makeJob());
    expect(result.status).toBe('completed');
    expect(addDocsSpy).not.toHaveBeenCalled();
  });

  it('degrades (does NOT fail the job) when Chroma indexing throws', async () => {
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'true';
    addDocsSpy.mockRejectedValue(new Error('chroma-mcp unavailable'));
    const result = await makeGenerator().process(makeJob());
    expect(result.status).toBe('completed');
    expect(addDocsSpy).toHaveBeenCalledTimes(1);

    // Observations are still canonical in Postgres despite the Chroma miss.
    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId, projectId, teamId,
    });
    expect(reloaded?.status).toBe('completed');
  });
});
