import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';

// Against a local PostgreSQL (as pg.test.ts): a SQL project's members are rows of
// streamby.project_members. Inviting a member, or asking to join, makes one pending with who
// invited it, and answering the invitation tells them.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const NAME = `test-members-${Date.now()}`;
const told = vi.hoisted(() => [] as { userId: string; type: string }[]);

vi.mock('../src/services/notification', () => ({
  createNotification: async (userId: string, type: string) => { told.push({ userId, type }); },
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
// The users are the host's (it registers their model): here, three of them, and their plans.
vi.mock('../src/models/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/models/manager')>();
  const users: Record<string, { id: string; username: string }> = {
    ada: { id: 'ada', username: 'ada' }, eli: { id: 'eli', username: 'eli' }, vic: { id: 'vic', username: 'vic' },
  };
  return {
    ...real,
    getModel: (name: string, ...rest: any[]) => (name === 'users'
      ? { findOne: async (filter: any) => users[filter?._id ?? filter?.id] ?? null }
      // The users' plans are the host's too.
      : name === 'user_subscriptions'
        ? { findOne: async () => ({ plan: 'freemium' }), create: async (doc: any) => doc }
        : (real.getModel as any)(name, ...rest)),
  };
});

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { getConnection } = await import('../src/adapters/database/connectionManager');
const { getModel } = await import('../src/models/manager');

const authProvider = async (req: any) => {
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  return { userId: user, username: user, role: 'viewer' as const };
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, authProvider,
  databases: [{ id: 'pg-members', type: 'sql', main: true, connectionString }] as any,
}));
const as = (user: string) => ({
  post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
});

let projectId = '';
const memberRow = async (userId: string) => {
  const pool = getConnection('pg-members').client as Pool;
  const { rows } = await pool.query('SELECT * FROM streamby.project_members WHERE "projectId" = $1 AND "userId" = $2', [projectId, userId]);
  return rows[0] ?? null;
};

beforeAll(async () => {
  // The router's tables first (its connections are made as it starts).
  await request(app).get('/streamby/projects/none/members').set('x-test-user', 'ada');
  const created: any = await getModel('projects').create({
    dbType: 'sql', name: NAME, description: '', image: '', allowedOrigin: [], public: true, category: 'film',
    members: [{ userId: 'ada', role: 'admin', status: 'active', archived: false }],
    dbConnections: [], storageConnections: [], integrationConnections: [],
  } as any);
  projectId = String(created._id ?? created.id);
});

afterAll(async () => {
  const pool = getConnection('pg-members').client as Pool;
  await pool.query('DELETE FROM streamby.projects WHERE name = $1', [NAME]);
});

describe('members of a SQL project', () => {
  it('an invitation makes a pending member, with who invited them; accepted, it is active and they are told', async () => {
    const invited = await as('ada').post(`/projects/${projectId}/members`, { userId: 'eli', role: 'editor' });
    expect(invited.status).toBe(201);
    expect(await memberRow('eli')).toMatchObject({ role: 'editor', status: 'pending', invitedBy: 'ada' });

    const project: any = await getModel('projects').findOne({ _id: projectId });
    expect(project.members.find((m: any) => m.userId === 'eli')).toMatchObject({ status: 'pending', invitedBy: 'ada' });

    told.length = 0;
    expect((await as('eli').patch(`/projects/${projectId}/members/eli/accept`)).status).toBe(200);
    expect(await memberRow('eli')).toMatchObject({ status: 'active' });
    expect(told).toEqual([{ userId: 'ada', type: 'member_accepted' }]);
  });

  it('an invitation rejected takes the member away, and tells who invited them', async () => {
    await as('ada').post(`/projects/${projectId}/members`, { userId: 'vic', role: 'viewer' });
    told.length = 0;
    expect((await as('vic').patch(`/projects/${projectId}/members/vic/reject`)).status).toBe(200);
    expect(await memberRow('vic')).toBeNull();
    expect(told).toEqual([{ userId: 'ada', type: 'member_rejected' }]);
  });

  it('asking to join makes a pending member, invited by themselves', async () => {
    const asked = await as('vic').post(`/projects/${projectId}/request-join`);
    expect(asked.status).toBe(201);
    expect(await memberRow('vic')).toMatchObject({ role: 'viewer', status: 'pending', invitedBy: 'vic' });
  });
});
