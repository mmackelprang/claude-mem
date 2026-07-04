// SPDX-License-Identifier: Apache-2.0
//
// `server api-key create --actor <id>` — Phase 1 author attribution.
//
// The CLI create path historically hardcoded actor_id to `system:server-cli`,
// so every CLI-issued key resolved to the same author. The optional `--actor`
// flag lets an operator provision teammate keys with distinct author
// identities. These tests cover both halves of the fix:
//   1. Flag resolution (always runs): `--actor alice` -> 'alice'; absent -> default.
//   2. Column storage (Postgres-gated): the resolved actor is written to the
//      `api_keys.actor_id` column that ServerV1PostgresRoutes reads back for
//      author attribution.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  DEFAULT_SERVER_CLI_ACTOR_ID,
  resolveServerApiKeyCliActorId,
} from '../../../src/server/runtime/ServerService.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';

describe('resolveServerApiKeyCliActorId', () => {
  it('returns the provided --actor value', () => {
    expect(resolveServerApiKeyCliActorId({ actor: 'alice' })).toBe('alice');
  });

  it('defaults to system:server-cli when --actor is absent', () => {
    expect(resolveServerApiKeyCliActorId({})).toBe('system:server-cli');
    expect(resolveServerApiKeyCliActorId({})).toBe(DEFAULT_SERVER_CLI_ACTOR_ID);
  });

  it('falls back to the default for an empty/whitespace --actor', () => {
    // parseFlagArgs yields '' when `--actor` is passed as the trailing flag
    // with no value; treat that as "not provided" rather than storing an
    // empty author id.
    expect(resolveServerApiKeyCliActorId({ actor: '' })).toBe(DEFAULT_SERVER_CLI_ACTOR_ID);
    expect(resolveServerApiKeyCliActorId({ actor: '   ' })).toBe(DEFAULT_SERVER_CLI_ACTOR_ID);
  });

  it('trims surrounding whitespace from the provided actor', () => {
    expect(resolveServerApiKeyCliActorId({ actor: '  bob  ' })).toBe('bob');
  });
});

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;
function newKeyHash() {
  const raw = `cmem_${randomBytes(24).toString('hex')}`;
  return createHash('sha256').update(raw).digest('hex');
}

describe('api-key create stores the resolved actor_id', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_actor_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
    client.release();
    await pool.end();
  });

  async function readActorId(id: string): Promise<string | null> {
    const res = await client.query<{ actor_id: string | null }>(
      'SELECT actor_id FROM api_keys WHERE id = $1',
      [id],
    );
    return res.rows[0]?.actor_id ?? null;
  }

  it("create --actor alice stores actor_id='alice'", async () => {
    const actorId = resolveServerApiKeyCliActorId({ actor: 'alice' });
    const created = await storage.auth.createApiKey({
      keyHash: newKeyHash(),
      teamId,
      projectId,
      scopes: ['memories:read'],
      actorId,
    });
    expect(await readActorId(created.id)).toBe('alice');
  });

  it("create without --actor stores actor_id='system:server-cli'", async () => {
    const actorId = resolveServerApiKeyCliActorId({});
    const created = await storage.auth.createApiKey({
      keyHash: newKeyHash(),
      teamId,
      projectId,
      scopes: ['memories:read'],
      actorId,
    });
    expect(await readActorId(created.id)).toBe('system:server-cli');
  });
});
