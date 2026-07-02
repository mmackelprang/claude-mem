import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

describe('observation author scoping (FTS search actorId filter)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_authorscope_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team-a' });
    const project = await storage.projects.create({ teamId: team.id, name: 'proj-a' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
  });

  it('filters by actor_id and leaves an unfiltered search as a superset', async () => {
    await storage.observations.create({
      projectId, teamId, content: 'alice deployed the cache layer',
      actorId: 'human:alice@org',
    });
    await storage.observations.create({
      projectId, teamId, content: 'bob deployed the cache layer',
      actorId: 'human:bob@org',
    });

    const all = await storage.observations.search({ projectId, teamId, query: 'deployed cache' });
    expect(all.length).toBe(2);

    const aliceOnly = await storage.observations.search({
      projectId, teamId, query: 'deployed cache', actorId: 'human:alice@org',
    });
    expect(aliceOnly.length).toBe(1);
    expect(aliceOnly[0]!.actorId).toBe('human:alice@org');

    // tenant isolation still holds under the author filter
    const wrongTeam = await storage.observations.search({
      projectId, teamId, query: 'deployed cache', actorId: 'human:nobody@org',
    });
    expect(wrongTeam.length).toBe(0);
  });
});
