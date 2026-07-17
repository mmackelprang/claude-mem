// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  PostgresServerSessionsRepository,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import {
  buildSummaryJobId,
  buildSummaryJobPayload,
} from '../../../src/server/runtime/SessionGenerationPolicy.js';
import { processSessionSummaryResponse } from '../../../src/server/generation/processGeneratedResponse.js';
import {
  createIsolatedSchema,
  poolForSchema,
  dropSchema,
} from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

// #5 — flipped true inside the real markPrivateSession test; the always-on
// sentinel at the bottom of this file asserts the P0 privacy guard actually
// executed this run.
let privacyGuardRan = false;

describe('SessionGenerationPolicy (pure)', () => {
  it('summary job id is deterministic per server_session_id', () => {
    const a = buildSummaryJobId({ serverSessionId: 's1', teamId: 't', projectId: 'p' });
    const b = buildSummaryJobId({ serverSessionId: 's1', teamId: 't', projectId: 'p' });
    const c = buildSummaryJobId({ serverSessionId: 's2', teamId: 't', projectId: 'p' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain(':');
  });

  // Phase 2 (WS2 visibility seam) — the summary lane must thread a private
  // session's visibility onto its payload so the end-of-session SUMMARY
  // observation is stamped 'private' rather than defaulting to 'team' and
  // leaking to the team feed. Symmetric to the event lane.
  it('buildSummaryJobPayload carries an explicit private visibility', () => {
    const payload = buildSummaryJobPayload({
      serverSessionId: 's1',
      teamId: 't',
      projectId: 'p',
      generationJobId: 'j1',
      visibility: 'private',
    });
    expect(payload.visibility).toBe('private');
    expect(payload.kind).toBe('summary');
    expect(payload.server_session_id).toBe('s1');
  });

  it('buildSummaryJobPayload defaults visibility to null when unset', () => {
    const payload = buildSummaryJobPayload({
      serverSessionId: 's1',
      teamId: 't',
      projectId: 'p',
      generationJobId: 'j1',
    });
    // null (not undefined/'team') so the generator chokepoint resolves the
    // config-driven default instead of the payload forcing a visibility.
    expect(payload.visibility).toBeNull();
  });
});

describe.skipIf(!testDatabaseUrl)('PostgresServerSessionsRepository + Postgres', () => {
  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let sessions: PostgresServerSessionsRepository;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    // createIsolatedSchema opens its own client, CREATE SCHEMAs, and closes it.
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_phase6');
    // poolForSchema pins search_path via the libpq startup packet, so EVERY
    // pooled connection — including the one processSessionSummaryResponse opens
    // from `pool` — lands in schemaName. This is the #8 fix.
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    sessions = new PostgresServerSessionsRepository(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    if (client) client.release();
    if (pool) await pool.end();
    if (schemaName) await dropSchema(testDatabaseUrl!, schemaName);
  });

  it('create is idempotent on legacy no-platform external_session_id', async () => {
    const a = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });
    const b = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });
    expect(a.id).toBe(b.id);
    expect(a.externalSessionId).toBe('ext-1');
  });

  it('create scopes external_session_id by normalized platformSource', async () => {
    const cursor = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'shared-ext-runtime',
      platformSource: 'Cursor',
    });
    const cursorAgain = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'shared-ext-runtime',
      platformSource: 'cursor-cli',
    });
    const codex = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'shared-ext-runtime',
      platformSource: 'Codex CLI',
    });

    expect(cursorAgain.id).toBe(cursor.id);
    expect(cursor.platformSource).toBe('cursor');
    expect(codex.platformSource).toBe('codex');
    expect(codex.id).not.toBe(cursor.id);
  });

  it('endSession is idempotent and never duplicates summary jobs', async () => {
    const session = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });

    const ended1 = await sessions.endSession({ id: session.id, projectId, teamId });
    expect(ended1?.endedAtEpoch).not.toBeNull();
    const firstEndedAt = ended1!.endedAtEpoch;

    // Re-end: should preserve original ended_at because of COALESCE.
    const ended2 = await sessions.endSession({ id: session.id, projectId, teamId });
    expect(ended2?.endedAtEpoch).toBe(firstEndedAt);

    // Now create a summary outbox row twice — UNIQUE on
    // (team_id, project_id, source_type, source_id, job_type) collapses.
    const job1 = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_session_summary',
    });
    const job2 = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_session_summary',
    });
    expect(job2.id).toBe(job1.id);
  });

  it('listUnprocessedEvents excludes events with completed jobs', async () => {
    const session = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });

    const eventA = await storage.agentEvents.create({
      projectId,
      teamId,
      serverSessionId: session.id,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 1 },
      occurredAt: new Date(Date.now() - 2000),
    });
    const eventB = await storage.agentEvents.create({
      projectId,
      teamId,
      serverSessionId: session.id,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 2 },
      occurredAt: new Date(),
    });

    // Create a job for eventA and mark it completed.
    const completedJob = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: eventA.id,
      agentEventId: eventA.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_for_event',
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: completedJob.id,
      projectId,
      teamId,
      status: 'processing',
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: completedJob.id,
      projectId,
      teamId,
      status: 'completed',
    });

    const unprocessed = await sessions.listUnprocessedEvents({
      teamId,
      projectId,
      serverSessionId: session.id,
    });
    expect(unprocessed.map(e => e.id)).toEqual([eventB.id]);
  });

  it('markPrivateSession persists privateSession=true on session metadata (summary-lane inheritance)', async () => {
    privacyGuardRan = true; // #5 — record that the P0 privacy net executed this run
    // Upstream deleted ServerSessionRuntimeRepository; sessions.create() is the
    // supported way to obtain a session (it upserts on externalSessionId). The
    // assertion below is unchanged — this test guards ADR 0002 §4.3.3.
    const session = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-private',
    });

    // Before: a fresh session is not private, so EndSessionService would resolve
    // no visibility and the summary would default to 'team'.
    const before = await sessions.getByIdForScope({ id: session.id, projectId, teamId });
    expect((before?.metadata as Record<string, unknown>)?.privateSession).not.toBe(true);

    await sessions.markPrivateSession({ id: session.id, projectId, teamId });

    // After: the flag EndSessionService reads to stamp visibility='private' on the
    // summary payload is present. This is the exact metadata field the fix keys on.
    const after = await sessions.getByIdForScope({ id: session.id, projectId, teamId });
    expect((after?.metadata as Record<string, unknown>)?.privateSession).toBe(true);
  });

  it('cross-tenant getByIdForScope returns null', async () => {
    const otherTeam = await storage.teams.create({ name: 'other' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'other-p' });
    const otherSession = await sessions.create({
      teamId: otherTeam.id,
      projectId: otherProject.id,
      externalSessionId: 'other-1',
    });

    // Trying to read other team's session under our scope returns null.
    const result = await sessions.getByIdForScope({
      id: otherSession.id,
      teamId,
      projectId,
    });
    expect(result).toBeNull();
  });

  it('processSessionSummaryResponse persists kind=summary observation idempotently', async () => {
    const session = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-summary',
    });
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_session_summary',
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId,
      teamId,
      status: 'processing',
    });

    const summaryXml = `<summary>
      <request>investigate session</request>
      <investigated>queries and traces</investigated>
      <learned>system behavior</learned>
      <completed>analysis</completed>
      <next_steps>plan refactor</next_steps>
      <notes>none</notes>
    </summary>`;

    const outcome1 = await processSessionSummaryResponse({
      pool,
      job,
      rawText: summaryXml,
      providerLabel: 'claude',
    });
    expect(outcome1.kind).toBe('completed');
    if (outcome1.kind === 'completed') {
      expect(outcome1.observations.length).toBeGreaterThan(0);
      expect(outcome1.observations[0]!.kind).toBe('summary');
    }

    // Idempotent: replaying does not produce new observations because the
    // job is already in completed state.
    const outcome2 = await processSessionSummaryResponse({
      pool,
      job,
      rawText: summaryXml,
      providerLabel: 'claude',
    });
    expect(outcome2.kind).toBe('completed');
    if (outcome2.kind === 'completed') {
      expect(outcome2.observations.length).toBe(0);
    }
  });
});

// #5 [P0] — guard-of-the-guard. This test is PURE (no Postgres) and NEVER gated, so a P0 privacy
// safety-net can never silently pass by not running. See
// docs/superpowers/specs/2026-07-17-postgres-privacy-guard-fail-loud-design.md (Option C).
describe('P0 privacy guard-of-the-guard (always runs)', () => {
  it('the R2 summary-lane privacy net (markPrivateSession) actually executed this run', () => {
    if (!testDatabaseUrl) {
      throw new Error(
        'P0 privacy guard did not run: set CLAUDE_MEM_TEST_POSTGRES_URL to execute the R2 ' +
          'summary-lane privacy net (markPrivateSession) in server-session-runtime.test.ts. ' +
          'A P0 privacy test must never silently pass by not running (Backlog #5, ADR 0002 §4.3.3).',
      );
    }
    // URL set: prove the real guard ran. Fails if it was skipped, deleted, or renamed away.
    expect(privacyGuardRan).toBe(true);
  });
});
