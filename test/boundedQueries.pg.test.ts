import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { FakeDb } from './fakeMongo';
import { runScenario, seedProjects, prefix } from './boundedQueriesScenario';

// The same routes against a local PostgreSQL (as pg.test.ts), its projects' members rows of
// project_members; teams live in the NoSQL database, here in memory beside it. The accounts'
// users table is the host's: made here when the database hasn't one, and dropped after.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const PG = 'pg-bounded';
const nosql = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/adapters/database/connectionManager')>();
  return {
    ...original,
    getConnectedIds: () => [...original.getConnectedIds(), 'teams-nosql'],
    getConnection: (id: string) => (id === 'teams-nosql' ? { id, type: 'nosql', client: { db: () => nosql.db } } : original.getConnection(id)),
  };
});
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));
vi.mock('../src/middleware/routes/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/routes/subscription')>()),
  ensureSubscription: (req: any, _res: any, next: any) => { req.subscription = 'subscriber'; next(); },
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { getConnection } = await import('../src/adapters/database/connectionManager');
const { getModel } = await import('../src/models/manager');

const STAMP = `pg${Date.now()}`;
nosql.db = new FakeDb();
// Made once the accounts' table is there (see beforeAll): StreamBy connects, and makes its
// indexes, as its router is made.
const app = express();
app.use(express.json());
const makeRouter = () => app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: PG, type: 'sql', main: true, connectionString }],
  authProvider: async (req: any) => {
    const user = req.headers['x-test-user'];
    if (!user) throw new Error('No session');
    return { userId: user, username: user, role: 'viewer' as const };
  },
}));

const pool = () => getConnection(PG).client as Pool;
let madeAccounts = false;
const users = { ada: randomUUID(), eli: randomUUID(), vic: randomUUID(), ghost: randomUUID() };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // The accounts' table first: StreamBy's startup indexes its usernames when it's there.
  const direct = new Pool({ connectionString });
  madeAccounts = !(await direct.query(`SELECT to_regclass('accounts.users') AS t`)).rows[0].t;
  if (madeAccounts) await direct.query(`CREATE SCHEMA IF NOT EXISTS accounts; CREATE TABLE accounts.users (id UUID PRIMARY KEY, username TEXT NOT NULL, "profilePic" TEXT)`);
  for (const [name, id] of Object.entries(users).filter(([name]) => name !== 'ghost')) {
    await direct.query('INSERT INTO accounts.users (id, username) VALUES ($1, $2)', [id, `${prefix(STAMP)}-${name}`]);
  }
  await direct.end();
  makeRouter();
  // Its first request waits for it to be connected.
  await (await import('supertest')).default(app).get('/streamby/projects').set('x-test-user', users.ada);
});

afterAll(async () => {
  await pool().query('DELETE FROM streamby.projects WHERE name LIKE $1', [`${prefix(STAMP)}-%`]);
  if (madeAccounts) await pool().query('DROP TABLE accounts.users; DROP SCHEMA IF EXISTS accounts');
  else await pool().query('DELETE FROM accounts.users WHERE id = ANY($1::uuid[])', [Object.values(users)]);
});
afterEach(() => vi.restoreAllMocks());

describe('in PostgreSQL', () => {
  it('lists, explores, changes projects, searches users and answers teams as before', async () => {
    const projects = await seedProjects('sql', STAMP, users);
    await runScenario(app, STAMP, { users, projects });
  });

  it("reads N projects' members in one query, not one per project", async () => {
    const stamp = `${STAMP}n`;
    const member = randomUUID();
    const Project = getModel('projects');
    for (const name of ['one', 'two', 'three']) {
      await Project.create({ dbType: 'sql', name: `${prefix(stamp)}-${name}`, members: [{ userId: member, role: 'admin', status: 'active', archived: false }] } as any);
    }
    const query = vi.spyOn(pool(), 'query');
    const found = await Project.find({ memberUserId: member });
    expect(found.map((p: any) => p.members.map((m: any) => m.userId))).toEqual([[member], [member], [member]]);
    const memberReads = query.mock.calls.filter(([sql]) => /FROM "streamby"\."project_members" WHERE "projectId"/.test(String(sql)));
    expect(memberReads).toHaveLength(1);
    await pool().query('DELETE FROM streamby.projects WHERE name LIKE $1', [`${prefix(stamp)}-%`]);
  });

  it("asks for a member's projects by their memberships, and has an index for it", async () => {
    const query = vi.spyOn(pool(), 'query');
    await getModel('projects').find({ memberUserId: users.ada });
    expect(query.mock.calls.map(([sql]) => String(sql)).some(sql => /SELECT \* FROM "streamby"\."projects" WHERE id IN \(SELECT "projectId" FROM "streamby"\."project_members" WHERE "userId" = \$1\)/.test(sql))).toBe(true);
    expect(query.mock.calls.map(([sql]) => String(sql)).some(sql => /^SELECT \* FROM "streamby"\."projects"\s*$/.test(sql))).toBe(false);
    const { rows } = await pool().query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'streamby' AND tablename = 'project_members' AND indexname = 'project_members_userid_idx'`);
    expect(rows).toHaveLength(1);
  });

  it("indexes the accounts' usernames for the search, as it starts", async () => {
    const { rows } = await pool().query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'accounts' AND tablename = 'users' AND indexname = 'users_username_trgm_idx'`);
    expect(rows).toHaveLength(1);
  });
});
