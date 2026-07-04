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

describe('observation visibility scoping (reader-scoped recall predicate)', () => {
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
    schemaName = `cm_visscope_${crypto.randomUUID().replaceAll('-', '_')}`;
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

  it('returns team/org rows plus the reader own private, and never another actor private', async () => {
    await storage.observations.create({ projectId, teamId, content: 'shared cache work', actorId: 'human:alice@org', visibility: 'team' });
    await storage.observations.create({ projectId, teamId, content: 'alice private cache note', actorId: 'human:alice@org', visibility: 'private' });
    await storage.observations.create({ projectId, teamId, content: 'bob private cache note', actorId: 'human:bob@org', visibility: 'private' });
    await storage.observations.create({ projectId, teamId, content: 'org cache rollout', actorId: 'system:ci', visibility: 'org' });

    // Alice (reader) sees: team + org + her own private = 3; not Bob's private.
    const alice = await storage.observations.search({ projectId, teamId, query: 'cache', viewerActorId: 'human:alice@org' });
    expect(alice.map(o => o.content).sort()).toEqual(['alice private cache note', 'org cache rollout', 'shared cache work'].sort());

    // No reader -> team + org only (silent-omit of ALL private).
    const anon = await storage.observations.search({ projectId, teamId, query: 'cache' });
    expect(anon.map(o => o.content).sort()).toEqual(['org cache rollout', 'shared cache work'].sort());

    // Bob sees his own private, not Alice's.
    const bob = await storage.observations.search({ projectId, teamId, query: 'cache', viewerActorId: 'human:bob@org' });
    expect(bob.some(o => o.content === 'bob private cache note')).toBe(true);
    expect(bob.some(o => o.content === 'alice private cache note')).toBe(false);
  });

  it('defaults visibility to team when omitted, and surfaces visibility on rows', async () => {
    const created = await storage.observations.create({ projectId, teamId, content: 'defaulted visibility row', actorId: 'human:alice@org' });
    expect(created.visibility).toBe('team');

    // Recall by an unrelated reader still sees a team-default row.
    const found = await storage.observations.search({ projectId, teamId, query: 'defaulted', viewerActorId: 'human:carol@org' });
    expect(found.some(o => o.content === 'defaulted visibility row')).toBe(true);
  });

  it('listByProject applies the same reader-scoped predicate as search', async () => {
    await storage.observations.create({ projectId, teamId, content: 'recent shared item', actorId: 'human:alice@org', visibility: 'team' });
    await storage.observations.create({ projectId, teamId, content: 'recent alice private', actorId: 'human:alice@org', visibility: 'private' });
    await storage.observations.create({ projectId, teamId, content: 'recent bob private', actorId: 'human:bob@org', visibility: 'private' });

    const aliceRecent = await storage.observations.listByProject({ projectId, teamId, viewerActorId: 'human:alice@org' });
    const aliceContents = aliceRecent.map(o => o.content);
    expect(aliceContents).toContain('recent shared item');
    expect(aliceContents).toContain('recent alice private');
    expect(aliceContents).not.toContain('recent bob private');

    const anonRecent = await storage.observations.listByProject({ projectId, teamId });
    const anonContents = anonRecent.map(o => o.content);
    expect(anonContents).toContain('recent shared item');
    expect(anonContents).not.toContain('recent alice private');
    expect(anonContents).not.toContain('recent bob private');
  });

  it('updateVisibilityForScope toggles team<->private within scope and 404s cross-team', async () => {
    const obs = await storage.observations.create({ projectId, teamId, content: 'toggle me', actorId: 'human:alice@org', visibility: 'team' });

    const toPrivate = await storage.observations.updateVisibilityForScope({ id: obs.id, teamId, projectId: null, visibility: 'private' });
    expect(toPrivate?.visibility).toBe('private');

    // Now only Alice recalls it.
    const anon = await storage.observations.search({ projectId, teamId, query: 'toggle' });
    expect(anon.some(o => o.id === obs.id)).toBe(false);
    const alice = await storage.observations.search({ projectId, teamId, query: 'toggle', viewerActorId: 'human:alice@org' });
    expect(alice.some(o => o.id === obs.id)).toBe(true);

    // Cross-team update returns null (404-not-403 stance).
    const otherTeam = await storage.teams.create({ name: 'team-b' });
    const cross = await storage.observations.updateVisibilityForScope({ id: obs.id, teamId: otherTeam.id, projectId: null, visibility: 'team' });
    expect(cross).toBeNull();
  });
});
