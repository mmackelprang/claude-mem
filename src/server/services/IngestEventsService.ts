// SPDX-License-Identifier: Apache-2.0

// Shared event-ingest path used by both `/v1/events` (canonical) and
// `src/server/compat/SessionsObservationsAdapter.ts` (legacy translator).
// Centralizes the transactional write (event row + outbox row + lifecycle
// log) and the post-commit BullMQ enqueue so both call sites apply the
// exact same SessionGenerationPolicy and outbox-then-publish guarantees.
//
// This module MUST NOT import from src/services/worker/* — the whole point
// of Phase 9 is to give the compat adapters a translation surface that
// reaches Server beta core directly, with no worker-layer detours.

import type { CreatePostgresAgentEventInput, PostgresAgentEvent } from '../../storage/postgres/agent-events.js';
import { PostgresAgentEventsRepository } from '../../storage/postgres/agent-events.js';
import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../storage/postgres/generation-jobs.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { withPostgresTransaction } from '../../storage/postgres/pool.js';
import { logger } from '../../utils/logger.js';
import { buildServerJobId } from '../jobs/job-id.js';
import type { GenerateObservationsForEventJob } from '../jobs/types.js';
import {
  buildEnqueueEventDecision,
  scheduleDebouncedEventJob,
  type ServerSessionGenerationPolicy,
} from '../runtime/SessionGenerationPolicy.js';
import { newId } from '../../storage/postgres/utils.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';
import { hasPrivateSessionMarker, type VisibilityLevel } from '../../shared/visibility.js';

// Phase 2 (WS2 visibility seam) — the self-closing `<private-session />` switch.
// Global variant so EVERY occurrence is stripped from stored content (detection
// uses the non-global exported PRIVATE_SESSION_MARKER via hasPrivateSessionMarker).
const PRIVATE_SESSION_STRIP_REGEX = /<private-session\s*\/>/gi;

// Deep-strip the self-closing marker from any string in the event payload,
// reporting whether it was present. Server ingest path only.
function stripPrivateSessionMarkerDeep(value: unknown): { changed: boolean; value: unknown } {
  if (typeof value === 'string') {
    if (!hasPrivateSessionMarker(value)) return { changed: false, value };
    return { changed: true, value: value.replace(PRIVATE_SESSION_STRIP_REGEX, '').trim() };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const r = stripPrivateSessionMarkerDeep(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { changed, value: next } : { changed: false, value };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = stripPrivateSessionMarkerDeep(v);
      if (r.changed) changed = true;
      next[k] = r.value;
    }
    return changed ? { changed, value: next } : { changed: false, value };
  }
  return { changed: false, value };
}

// Resolve the private-session state for one incoming event (inside the ingest
// tx): strip the marker from stored content, flip the session private when the
// marker is present (persists across later turns via server_sessions.metadata),
// and inherit private for later turns of an already-private session. Returns the
// (possibly cleaned) event input and the visibility to stamp on the BullMQ payload.
async function resolvePrivateSessionVisibility(
  client: PostgresQueryable,
  input: CreatePostgresAgentEventInput,
): Promise<{ cleanedInput: CreatePostgresAgentEventInput; visibility: VisibilityLevel | null }> {
  const stripped = stripPrivateSessionMarkerDeep(input.payload ?? null);
  let isPrivate = stripped.changed;

  if (input.serverSessionId) {
    const sessionsRepo = new PostgresServerSessionsRepository(client);
    if (stripped.changed) {
      // This turn flips the session private; persist so later turns inherit it.
      await sessionsRepo.markPrivateSession({
        id: input.serverSessionId,
        projectId: input.projectId,
        teamId: input.teamId,
      });
    } else {
      // Later turn of a session that may already be private — inherit the flag.
      const session = await sessionsRepo.getByIdForScope({
        id: input.serverSessionId,
        projectId: input.projectId,
        teamId: input.teamId,
      });
      if (session && (session.metadata as Record<string, unknown>)?.privateSession === true) {
        isPrivate = true;
      }
    }
  }

  const cleanedInput = stripped.changed
    ? { ...input, payload: stripped.value }
    : input;
  return { cleanedInput, visibility: isPrivate ? 'private' : null };
}

function buildEventBullmqPayload(input: {
  outboxId: string;
  event: PostgresAgentEvent;
  apiKeyId: string | null;
  actorId: string | null;
  sourceAdapter: string | null;
  requestId: string | null;
  visibility?: VisibilityLevel | null;
}): GenerateObservationsForEventJob {
  return {
    kind: 'event',
    team_id: input.event.teamId,
    project_id: input.event.projectId,
    source_type: 'agent_event',
    source_id: input.event.id,
    generation_job_id: input.outboxId,
    agent_event_id: input.event.id,
    api_key_id: input.apiKeyId,
    actor_id: input.actorId,
    source_adapter: input.sourceAdapter ?? input.event.sourceAdapter ?? 'api',
    request_id: input.requestId,
    // Phase 2 — only present when the session is private; otherwise omitted so
    // the generator chokepoint resolves the config-driven default.
    ...(input.visibility ? { visibility: input.visibility } : {}),
  };
}

const EVENT_JOB_TYPE = 'observation_generate_for_event';

export type EnqueueOutcome = 'enqueued' | 'queued_only' | 'skipped';

export interface IngestEventsServiceOptions {
  pool: PostgresPool;
  // Lazy queue resolver so the service does not depend on the queue manager
  // type and tests can swap in a fake. When this returns null, the outbox
  // row stays `queued` and Phase 3 startup reconciliation will publish it.
  resolveEventQueue: () => EventQueueLike | null;
  sessionPolicy?: ServerSessionGenerationPolicy;
}

export interface EventQueueLike {
  add(jobId: string, payload: unknown, options?: unknown): Promise<unknown>;
}

export interface IngestEventResult {
  event: PostgresAgentEvent;
  outbox: PostgresObservationGenerationJob | null;
  enqueueState: EnqueueOutcome;
}

export interface IngestEventOptions {
  generate?: boolean;
  source?: string;
  // Phase 11 — identity context that flows from the HTTP auth boundary into
  // the BullMQ payload and audit log. None of these are auth gates: the
  // worker reloads and re-validates from Postgres before any side effect.
  apiKeyId?: string | null;
  actorId?: string | null;
  sourceAdapter?: string | null;
  // Phase 12 — opaque correlation id minted at the HTTP middleware so
  // generator logs and audit rows can pivot back to the originating request.
  requestId?: string | null;
}

export class IngestEventsService {
  constructor(private readonly options: IngestEventsServiceOptions) {}

  async ingestOne(
    input: CreatePostgresAgentEventInput,
    opts: IngestEventOptions = {},
  ): Promise<IngestEventResult> {
    const generate = opts.generate ?? true;
    const source = opts.source ?? 'http_post_v1_events';

    const txResult = await withPostgresTransaction(this.options.pool, async (client) => {
      const eventsRepo = new PostgresAgentEventsRepository(client);
      // Phase 2 — <private-session /> proactive switch (server ingest path only).
      const privacy = await resolvePrivateSessionVisibility(client, input);
      const inserted = await eventsRepo.create({
        ...privacy.cleanedInput,
        actorId: opts.actorId ?? null,
        apiKeyId: opts.apiKeyId ?? null,
      });

      if (!generate) {
        return { event: inserted, outbox: null as PostgresObservationGenerationJob | null };
      }

      const jobsRepo = new PostgresObservationGenerationJobRepository(client);
      const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
      // Pre-generate the outbox id so we can build the BullMQ payload (which
      // references generation_job_id) and persist it on the row. Reconciliation
      // and operator retry rely on this persisted payload to re-enqueue a
      // payload that passes assertServerGenerationJobPayload at the worker.
      const outboxId = newId();
      const bullmqPayload = buildEventBullmqPayload({
        outboxId,
        event: inserted,
        apiKeyId: opts.apiKeyId ?? null,
        actorId: opts.actorId ?? null,
        sourceAdapter: opts.sourceAdapter ?? null,
        requestId: opts.requestId ?? null,
        visibility: privacy.visibility,
      });
      const outbox = await jobsRepo.create({
        id: outboxId,
        projectId: inserted.projectId,
        teamId: inserted.teamId,
        sourceType: 'agent_event',
        sourceId: inserted.id,
        agentEventId: inserted.id,
        serverSessionId: inserted.serverSessionId,
        jobType: EVENT_JOB_TYPE,
        bullmqJobId: buildServerJobId({
          kind: 'event',
          team_id: inserted.teamId,
          project_id: inserted.projectId,
          source_type: 'agent_event',
          source_id: inserted.id,
        }),
        payload: bullmqPayload as unknown as Record<string, unknown>,
      });
      await eventsLogRepo.append({
        generationJobId: outbox.id,
        projectId: outbox.projectId,
        teamId: outbox.teamId,
        eventType: 'queued',
        statusAfter: outbox.status,
        attempt: outbox.attempts,
        details: { source },
      });
      return { event: inserted, outbox };
    });

    let enqueueState: EnqueueOutcome = 'skipped';
    if (txResult.outbox) {
      enqueueState = await this.publishEventJob(txResult.event, txResult.outbox, opts);
    }
    return { event: txResult.event, outbox: txResult.outbox, enqueueState };
  }

  async ingestBatch(
    inputs: CreatePostgresAgentEventInput[],
    opts: IngestEventOptions = {},
  ): Promise<IngestEventResult[]> {
    const generate = opts.generate ?? true;
    const source = opts.source ?? 'http_post_v1_events_batch';

    const txResults = await withPostgresTransaction(this.options.pool, async (client) => {
      const eventsRepo = new PostgresAgentEventsRepository(client);
      const jobsRepo = new PostgresObservationGenerationJobRepository(client);
      const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
      const acc: { event: PostgresAgentEvent; outbox: PostgresObservationGenerationJob | null }[] = [];
      for (const input of inputs) {
        // Phase 2 — <private-session /> proactive switch (server ingest path only).
        // Sequential within one tx, so an earlier event flipping the session
        // private is visible to later events sharing that session.
        const privacy = await resolvePrivateSessionVisibility(client, input);
        const event = await eventsRepo.create({
          ...privacy.cleanedInput,
          actorId: opts.actorId ?? null,
          apiKeyId: opts.apiKeyId ?? null,
        });
        if (!generate) {
          acc.push({ event, outbox: null });
          continue;
        }
        const outboxId = newId();
        const bullmqPayload = buildEventBullmqPayload({
          outboxId,
          event,
          apiKeyId: opts.apiKeyId ?? null,
          actorId: opts.actorId ?? null,
          sourceAdapter: opts.sourceAdapter ?? null,
          requestId: opts.requestId ?? null,
          visibility: privacy.visibility,
        });
        const outbox = await jobsRepo.create({
          id: outboxId,
          projectId: event.projectId,
          teamId: event.teamId,
          sourceType: 'agent_event',
          sourceId: event.id,
          agentEventId: event.id,
          serverSessionId: event.serverSessionId,
          jobType: EVENT_JOB_TYPE,
          bullmqJobId: buildServerJobId({
            kind: 'event',
            team_id: event.teamId,
            project_id: event.projectId,
            source_type: 'agent_event',
            source_id: event.id,
          }),
          payload: bullmqPayload as unknown as Record<string, unknown>,
        });
        await eventsLogRepo.append({
          generationJobId: outbox.id,
          projectId: outbox.projectId,
          teamId: outbox.teamId,
          eventType: 'queued',
          statusAfter: outbox.status,
          attempt: outbox.attempts,
          details: { source },
        });
        acc.push({ event, outbox });
      }
      return acc;
    });

    return Promise.all(txResults.map(async ({ event, outbox }) => {
      const enqueueState: EnqueueOutcome = outbox
        ? await this.publishEventJob(event, outbox, opts)
        : 'skipped';
      return { event, outbox, enqueueState };
    }));
  }

  private async publishEventJob(
    event: PostgresAgentEvent,
    outbox: PostgresObservationGenerationJob,
    opts: IngestEventOptions = {},
  ): Promise<'enqueued' | 'queued_only'> {
    const queue = this.options.resolveEventQueue();
    if (!queue) {
      return 'queued_only';
    }
    const policyOptions: { policy?: ServerSessionGenerationPolicy; debounceWindowMs?: number } = {};
    if (this.options.sessionPolicy !== undefined) {
      policyOptions.policy = this.options.sessionPolicy;
    }
    // Phase 2 — the persisted outbox payload is canonical for visibility (it was
    // stamped inside the ingest tx). Read it back so the immediately-enqueued
    // BullMQ job.data carries the same visibility the reconciliation path would.
    const persistedVisibility =
      (outbox.payload as { visibility?: VisibilityLevel | null } | undefined)?.visibility ?? null;
    const decision = buildEnqueueEventDecision(
      {
        event,
        outbox,
        apiKeyId: opts.apiKeyId ?? null,
        actorId: opts.actorId ?? null,
        sourceAdapter: opts.sourceAdapter ?? event.sourceAdapter ?? null,
        // Phase 12 — flow request_id into the BullMQ payload so the worker
        // can emit it in [generation] logs and the audit row.
        requestId: opts.requestId ?? null,
        visibility: persistedVisibility,
      },
      policyOptions,
    );
    if (!decision.shouldEnqueue) {
      return 'queued_only';
    }
    try {
      await scheduleDebouncedEventJob(queue as never, decision);
      return 'enqueued';
    } catch (error) {
      logger.warn('SYSTEM', 'failed to publish event generation job to BullMQ', {
        outboxId: outbox.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'queued_only';
    }
  }
}
