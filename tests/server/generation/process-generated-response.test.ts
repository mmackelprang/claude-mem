// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import {
  processGeneratedResponse,
  markGenerationFailed,
} from '../../../src/server/generation/processGeneratedResponse.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import {
  createIsolatedSchema,
  poolForSchema,
  dropSchema,
} from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe.skipIf(!testDatabaseUrl)('processGeneratedResponse + markGenerationFailed', () => {
  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;

  beforeEach(async () => {
    // The generation path reads the active ModeManager mode; load it so this
    // file runs standalone instead of relying on another test file's side effect.
    ModeManager.getInstance().loadMode('code');
    // createIsolatedSchema opens its own client, CREATE SCHEMAs, and closes it.
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_phase5');
    // poolForSchema pins search_path via the libpq startup packet, so EVERY
    // pooled connection — including the one processGeneratedResponse opens from
    // `pool` via withPostgresTransaction — lands in schemaName. This replaces
    // the fire-and-forget pool.on('connect', …) monkey-patch this file used to
    // carry (the exact anti-pattern pg-isolation.ts:10–15 was written to kill).
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team-a' });
    const project = await storage.projects.create({ teamId: team.id, name: 'proj-a' });
    teamId = team.id;
    projectId = project.id;

    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { tool: 'bash', input: 'ls' },
      occurredAt: new Date(),
    });
    eventId = event.id;

    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    jobId = job.id;
  });

  afterEach(async () => {
    if (client) client.release();
    if (pool) await pool.end();
    if (schemaName) await dropSchema(testDatabaseUrl!, schemaName);
  });

  async function reloadJob() {
    return await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
  }

  it('persists observation, links source, and marks job completed for valid XML', async () => {
    const xml = `
      <observation>
        <type>discovery</type>
        <title>Tool ran</title>
        <facts><fact>command was ls</fact></facts>
      </observation>
    `;
    const job = await reloadJob();
    expect(job).toBeTruthy();

    // Lock first, like the real generator does.
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });

    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.generationKey).toMatch(/^generation:v1:/);
    }

    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('completed');

    // observation_sources row exists
    const sources = await storage.observationSources.listByObservationForScope({
      observationId: outcome.kind === 'completed' ? outcome.observations[0]!.id : '',
      projectId,
      teamId,
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceType).toBe('agent_event');
    expect(sources[0]!.sourceId).toBe(eventId);
    expect(sources[0]!.generationJobId).toBe(jobId);
  });

  it('records token + observation usage when metering is enabled', async () => {
    const prev = process.env.CLAUDE_MEM_USAGE_METERING;
    process.env.CLAUDE_MEM_USAGE_METERING = '1';
    try {
      const xml = `
        <observation>
          <type>discovery</type>
          <title>Metered</title>
          <facts><fact>token metering</fact></facts>
        </observation>
      `;
      await storage.observationGenerationJobs.transitionStatus({ id: jobId, projectId, teamId, status: 'processing' });
      const fresh = (await reloadJob())!;
      const outcome = await processGeneratedResponse({
        pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
        job: fresh,
        rawText: xml,
        providerLabel: 'fake',
        modelId: 'fake-1',
        tokensUsed: 1234,
      });
      expect(outcome.kind).toBe('completed');

      const usage = await pool.query(
        `SELECT kind, SUM(quantity)::bigint AS total FROM usage_events WHERE team_id = $1 GROUP BY kind`,
        [teamId],
      );
      const byKind: Record<string, number> = {};
      for (const r of usage.rows) byKind[r.kind] = Number(r.total);
      expect(byKind.tokens).toBe(1234);
      expect(byKind.observation).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_USAGE_METERING;
      else process.env.CLAUDE_MEM_USAGE_METERING = prev;
    }
  });

  it('does NOT record usage when metering is disabled', async () => {
    const prev = process.env.CLAUDE_MEM_USAGE_METERING;
    delete process.env.CLAUDE_MEM_USAGE_METERING;
    try {
      const xml = `<observation><type>discovery</type><title>x</title><facts><fact>f</fact></facts></observation>`;
      await storage.observationGenerationJobs.transitionStatus({ id: jobId, projectId, teamId, status: 'processing' });
      const fresh = (await reloadJob())!;
      await processGeneratedResponse({
        pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
        job: fresh, rawText: xml, providerLabel: 'fake', modelId: 'fake-1', tokensUsed: 999,
      });
      const n = await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE team_id = $1`, [teamId]);
      expect(n.rows[0]?.n).toBe(0);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_MEM_USAGE_METERING = prev;
    }
  });

  it('replaying the same job yields exactly one observation (idempotency)', async () => {
    const xml = `<observation><type>discovery</type><title>Same</title><facts><fact>same</fact></facts></observation>`;

    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });

    const fresh = (await reloadJob())!;
    const first = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
    });
    expect(first.kind).toBe('completed');

    // Manually move job back to processing to simulate retry
    // (in practice retry would create a new job invocation, but the
    // idempotency guard is at the observation level via generation_key).
    // The terminal-status check inside processGeneratedResponse will
    // short-circuit the second call cleanly, demonstrating that retries
    // do not re-write observations.
    const second = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
    });
    expect(second.kind).toBe('completed');

    // Verify exactly one observation row exists — the replay did NOT write a
    // second. Count the table directly rather than via listByProject:
    // processGeneratedResponse fails CLOSED to visibility='private' when the
    // caller omits visibility (processGeneratedResponse.ts:340), and
    // listByProject hides private rows from a null viewer — so the
    // visibility-filtered read would report 0 even though the single row exists.
    // The idempotency invariant under test is "one row, not two", which the raw
    // count expresses without depending on the read-path visibility policy.
    const count = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM observations WHERE project_id = $1 AND team_id = $2',
      [projectId, teamId],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('marks job completed with no observation when the response is a skip_summary', async () => {
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: '<skip_summary reason="all_events_private" />',
      providerLabel: 'fake',
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(0);
      expect(outcome.privateContentDetected).toBe(true);
    }

    const list = await storage.observations.listByProject({ projectId, teamId });
    expect(list).toHaveLength(0);

    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('completed');
  });

  it('returns parse_error and does not write observations for malformed XML', async () => {
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: 'this is just prose without any xml',
      providerLabel: 'fake',
    });
    expect(outcome.kind).toBe('parse_error');

    const list = await storage.observations.listByProject({ projectId, teamId });
    expect(list).toHaveLength(0);

    // Job still in processing — caller (ProviderObservationGenerator) is
    // responsible for transitioning to failed/retry.
    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('processing');
  });

  it('markGenerationFailed routes to retry when retryable and attempts left', async () => {
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    await markGenerationFailed({
      pool: pool as unknown as Parameters<typeof markGenerationFailed>[0]['pool'],
      job: fresh,
      reason: 'transient',
      classification: 'transient',
      retryable: true,
    });
    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('queued');
  });

  it('stamps actor_id + api_key_id on the generated observation row', async () => {
    // Inline valid-observation XML, matching this file's existing per-test
    // pattern (e.g. :193, :208) — the file does not export a shared fixture.
    const xml = `<observation><type>discovery</type><title>Alice deployed cache</title><facts><fact>alice deployed the cache layer</fact></facts></observation>`;
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'test',
      actorId: 'human:alice@org',
      apiKeyId: null, // no FK row minted in this harness; null exercises the nullable path
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    const obs = outcome.observations[0]!;
    const row = await client.query(
      'SELECT actor_id, api_key_id FROM observations WHERE id = $1',
      [obs.id],
    );
    expect(row.rows[0]?.actor_id).toBe('human:alice@org');
    expect(row.rows[0]?.api_key_id).toBeNull();
    // and the repo mapping surfaces it
    expect(obs.actorId).toBe('human:alice@org');
  });
});
