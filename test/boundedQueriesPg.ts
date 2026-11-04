import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { runScenario, seedProjects, prefix } from './boundedQueriesScenario';

// The routes of the bounded queries' scenario against a local PostgreSQL, in a database of its own
// made as an existing one is: a project's id and its members' "projectId" of different types (an
// older StreamBy made them uuid; a newer one, text), so the queries must compare them as text.
// Its teams live in the NoSQL database (in memory: see the test files' mocks). The database is
// dropped after.
const server = 'postgresql://postgres:postgres@localhost:5432';

export type Variant = {
  name: string;
  // The types the database keeps them in.
  projectId: 'uuid' | 'text';
  memberProjectId: 'uuid' | 'text';
};

export function pgSuite(variant: Variant) {
  const database = `streamby_bq_${variant.projectId}_${variant.memberProjectId}_${Date.now()}`;
  const connectionString = `${server}/${database}`;
  const PG = `pg-${database}`;
  const STAMP = `pg${Date.now()}`;
  const users = { ada: randomUUID(), eli: randomUUID(), vic: randomUUID(), ghost: randomUUID() };
  const app = express();
  app.use(express.json());
  let pool: Pool;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const admin = new Pool({ connectionString: `${server}/postgres` });
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();

    // The host's accounts, and StreamBy's tables as an existing database has them.
    const direct = new Pool({ connectionString });
    await direct.query(`
      CREATE SCHEMA accounts;
      CREATE TABLE accounts.users (id UUID PRIMARY KEY, username TEXT NOT NULL, "profilePic" TEXT);
      CREATE SCHEMA streamby;
      CREATE TABLE streamby.projects (
        id ${variant.projectId} PRIMARY KEY DEFAULT gen_random_uuid()${variant.projectId === 'text' ? '::text' : ''},
        name VARCHAR(255) NOT NULL, description TEXT, image TEXT, "dbType" VARCHAR(50) NOT NULL DEFAULT 'sql',
        "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE streamby.project_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "projectId" ${variant.memberProjectId} NOT NULL, "userId" VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL DEFAULT 'member', status VARCHAR(50) NOT NULL DEFAULT 'active', archived BOOLEAN NOT NULL DEFAULT FALSE,
        "archivedBy" VARCHAR(255), "archivedAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE ("projectId", "userId")
      );
      CREATE TABLE streamby.exports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "projectId" UUID NOT NULL, status VARCHAR(50) NOT NULL DEFAULT 'pending',
        "filePath" TEXT, "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (const [name, id] of Object.entries(users).filter(([name]) => name !== 'ghost')) {
      await direct.query('INSERT INTO accounts.users (id, username) VALUES ($1, $2)', [id, `${prefix(STAMP)}-${name}`]);
    }

    const { createStreamByRouter } = await import('../src/middleware/createRouter');
    app.use('/streamby', createStreamByRouter({
      storageProviders: [], adapter: {} as any, databases: [{ id: PG, type: 'sql', main: true, connectionString }],
      authProvider: async (req: any) => {
        const user = req.headers['x-test-user'];
        if (!user) throw new Error('No session');
        return { userId: user, username: user, role: 'viewer' as const };
      },
    }));
    // Its first request waits for its startup (which brings the tables up to date).
    await request(app).get('/streamby/projects').set('x-test-user', users.ada);

    // As the database keeps them, whatever startup could migrate: an existing database's rows
    // may keep it from making them alike.
    const defaultId = `gen_random_uuid()${variant.projectId === 'text' ? '::text' : ''}`;
    await direct.query(`
      ALTER TABLE streamby.project_members DROP CONSTRAINT IF EXISTS project_members_projectid_fkey;
      ALTER TABLE streamby.projects ALTER COLUMN id DROP DEFAULT;
      ALTER TABLE streamby.projects ALTER COLUMN id TYPE ${variant.projectId} USING id::${variant.projectId};
      ALTER TABLE streamby.projects ALTER COLUMN id SET DEFAULT ${defaultId};
      ALTER TABLE streamby.project_members ALTER COLUMN "projectId" TYPE ${variant.memberProjectId} USING "projectId"::${variant.memberProjectId};
    `);
    const { rows } = await direct.query(
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE table_schema = 'streamby' AND ((table_name = 'projects' AND column_name = 'id') OR (table_name = 'project_members' AND column_name = 'projectId'))`,
    );
    expect(Object.fromEntries(rows.map(r => [r.table_name, r.data_type]))).toEqual({ projects: variant.projectId, project_members: variant.memberProjectId });
    await direct.end();

    const { getConnection } = await import('../src/adapters/database/connectionManager');
    pool = getConnection(PG).client as Pool;
    pool.on('error', () => {});
  }, 60_000);

  afterAll(async () => {
    // Dropping the database ends its connections, the ones checked out of the pool too (startup
    // keeps one): not an error of the test's.
    for (const client of (pool as any)?._clients ?? []) client.on('error', () => {});
    const admin = new Pool({ connectionString: `${server}/postgres` });
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  afterEach(() => vi.restoreAllMocks());

  describe(`in PostgreSQL (a project's id ${variant.projectId}, its members' "projectId" ${variant.memberProjectId})`, () => {
    it('lists, explores, changes projects, searches users and answers teams and members as before', async () => {
      const projects = await seedProjects('sql', STAMP, users);
      await runScenario(app, STAMP, { users, projects });
    });

    it('answers the lists of projects with 200', async () => {
      for (const path of ['/projects', '/projects/explore']) {
        expect((await request(app).get(`/streamby${path}`).set('x-test-user', users.ada)).status).toBe(200);
      }
    });

    it("reads N projects' members in one query, not one per project", async () => {
      const { getModel } = await import('../src/models/manager');
      const stamp = `${STAMP}n`;
      const member = randomUUID();
      const Project = getModel('projects');
      for (const name of ['one', 'two', 'three']) {
        await Project.create({ dbType: 'sql', name: `${prefix(stamp)}-${name}`, members: [{ userId: member, role: 'admin', status: 'active', archived: false }] } as any);
      }
      const query = vi.spyOn(pool, 'query');
      const found = await Project.find({ memberUserId: member });
      expect(found.map((p: any) => p.members.map((m: any) => m.userId))).toEqual([[member], [member], [member]]);
      const memberReads = query.mock.calls.filter(([sql]) => /FROM "streamby"\."project_members" WHERE "projectId"/.test(String(sql)));
      expect(memberReads).toHaveLength(1);
    });

    it("asks for a member's projects by their memberships, and has an index for it", async () => {
      const { getModel } = await import('../src/models/manager');
      const query = vi.spyOn(pool, 'query');
      await getModel('projects').find({ memberUserId: users.ada });
      const sqls = query.mock.calls.map(([sql]) => String(sql));
      expect(sqls.some(sql => /FROM "streamby"\."projects" WHERE id::text IN \(SELECT "projectId"::text FROM "streamby"\."project_members" WHERE "userId"::text = \$1\)/.test(sql))).toBe(true);
      expect(sqls.some(sql => /^SELECT \* FROM "streamby"\."projects"\s*$/.test(sql))).toBe(false);
      const { rows } = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'streamby' AND tablename = 'project_members' AND indexname = 'project_members_userid_idx'`);
      expect(rows).toHaveLength(1);
    });

    it("doesn't change the host's accounts table", async () => {
      const { rows } = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'accounts' AND tablename = 'users'`);
      expect(rows.map(r => r.indexname)).toEqual(['users_pkey']);
    });
  });
}
