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
  parseFlagArgs,
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
    // Treat a valueless --actor as "not provided" rather than storing an empty
    // author id.
    expect(resolveServerApiKeyCliActorId({ actor: '' })).toBe(DEFAULT_SERVER_CLI_ACTOR_ID);
    expect(resolveServerApiKeyCliActorId({ actor: '   ' })).toBe(DEFAULT_SERVER_CLI_ACTOR_ID);
  });

  it('trims surrounding whitespace from the provided actor', () => {
    expect(resolveServerApiKeyCliActorId({ actor: '  bob  ' })).toBe('bob');
  });

  it('falls back to the default when parseArgs yields a boolean actor', () => {
    // node's parseArgs under `strict: false` yields the BOOLEAN `true` for a
    // trailing bare `--actor`, even though the flag is declared type:'string'.
    // The resolver must not call .trim() on that. Regression guard: the
    // pre-merge hand-rolled parser degraded gracefully here and the v13.11.0
    // parseArgs rewrite would otherwise throw TypeError. See ADR 0002 §4.5.
    expect(resolveServerApiKeyCliActorId({ actor: true })).toBe(DEFAULT_SERVER_CLI_ACTOR_ID);
  });
});

// These drive the REAL parser rather than hand-built literals. The `actor`
// entry in parseFlagArgs' options allowlist is load-bearing: upstream v13.11.0
// replaced a hand-rolled generic parser (which captured any `--foo bar`) with
// node's parseArgs + a declared allowlist. Our fork never touched that region,
// so git reported NO conflict — dropping `actor` from the allowlist would
// silently degrade `--actor` with nothing to catch it (ADR 0002 §4.5, R5).
describe('parseFlagArgs — WS2 author seam allowlist', () => {
  it('captures `--actor <id>` as a string value, not a positional', () => {
    expect(parseFlagArgs(['create', '--actor', 'mark']).actor).toBe('mark');
    expect(parseFlagArgs(['create', '--actor=mark']).actor).toBe('mark');
  });

  it('end-to-end: `--actor mark` resolves to the mark author id', () => {
    expect(resolveServerApiKeyCliActorId(parseFlagArgs(['create', '--actor', 'mark']))).toBe('mark');
  });

  it('end-to-end: a trailing bare `--actor` degrades to the default, never throws', () => {
    expect(() => resolveServerApiKeyCliActorId(parseFlagArgs(['create', '--actor']))).not.toThrow();
    expect(resolveServerApiKeyCliActorId(parseFlagArgs(['create', '--actor']))).toBe(
      DEFAULT_SERVER_CLI_ACTOR_ID,
    );
  });

  it('end-to-end: no --actor resolves to the backward-compatible default', () => {
    expect(resolveServerApiKeyCliActorId(parseFlagArgs(['create']))).toBe(
      DEFAULT_SERVER_CLI_ACTOR_ID,
    );
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
