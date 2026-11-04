import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';
import { bounded } from './modelFilters';

// Teams live in the NoSQL database (here in memory); projects, users and tokens in the models
// (here in memory too). A NoSQL project, so removing a member takes them out of its members.
const mongo = vi.hoisted(() => ({ db: null as any }));
const store: Record<string, any[]> = {};
const matchesRecord = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(bounded(name, filter) ?? (r => matchesRecord(r, filter))),
    findOne: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    create: async (doc: any) => { const { dbType: _d, ...row } = doc; rows().push(row); return row; },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matchesRecord(r, filter));
      if (row && data.$pull?.members) row.members = row.members.filter((m: any) => m.userId !== data.$pull.members.userId);
      else if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row ?? null;
    },
    delete: async (filter: any) => { const before = rows().length; store[name] = rows().filter(r => !matchesRecord(r, filter)); return before - store[name].length; },
    getConnectionIds: () => ['mongo'],
  };
  model.useDbType = () => model;
  return model;
};
vi.mock('../src/models/manager', () => ({ getModel: (name: string) => fakeModel(name), registerModel: () => {} }));
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/database/connectionManager')>()),
  initConnections: async () => {},
  getConnectedIds: () => ['mongo'],
  getConnection: () => ({ type: 'nosql', client: { db: () => mongo.db } }),
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');

const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'mongo', type: 'nosql', main: true }],
  authProvider: async (req: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer);
      if (!resolved) throw new Error('Invalid API token');
      return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
    }
    return { userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer' as const };
  },
}));
const as = (user: string) => ({
  get: (p: string) => request(app).get(`/streamby${p}`).set('x-test-user', user),
  post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  delete: (p: string) => request(app).delete(`/streamby${p}`).set('x-test-user', user),
});
const ada = as('ada');
const T = '/projects/p1/teams';
const names = (body: any) => body.teams.map((t: any) => [t.name, t.members.map((m: any) => m.username)]);

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'nosql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }, { userId: 'pat', role: 'editor', status: 'pending' }] },
    { _id: 'p2', id: 'p2', name: 'Other', dbType: 'nosql', members: [{ userId: 'ada', role: 'admin', status: 'active' }, { userId: 'zoe', role: 'editor', status: 'active' }] },
  ];
  store.users = ['ada', 'eli', 'vic', 'pat', 'zoe'].map(id => ({ _id: id, id, username: id }));
});
afterEach(() => vi.restoreAllMocks());

describe("a project's teams", () => {
  it('an admin makes one of its members, renames it and deletes it; each change answers the teams', async () => {
    const made = await ada.post(T, { name: ' Animation ', memberIds: ['eli', 'vic', 'eli'] });
    expect(made.status).toBe(201);
    expect(names(made.body)).toEqual([['Animation', ['eli', 'vic']]]);
    const teamId = made.body.teams[0].id;

    const renamed = await ada.patch(`${T}/${teamId}`, { name: 'Layout' });
    expect(renamed.status).toBe(200);
    expect(names(renamed.body)).toEqual([['Layout', ['eli', 'vic']]]);

    expect(names((await ada.patch(`${T}/${teamId}`, { memberIds: ['ada'] })).body)).toEqual([['Layout', ['ada']]]);

    const deleted = await ada.delete(`${T}/${teamId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.teams).toEqual([]);
    expect(mongo.db.docs('project_teams')).toEqual([]);
  });

  it('any member sees them, by name', async () => {
    await ada.post(T, { name: 'Sound', memberIds: ['vic'] });
    await ada.post(T, { name: 'Animation', memberIds: [] });
    const seen = await as('vic').get(T);
    expect(seen.status).toBe(200);
    expect(names(seen.body)).toEqual([['Animation', []], ['Sound', ['vic']]]);
    expect(seen.body.teams[1].members[0]).toEqual({ userId: 'vic', username: 'vic', profilePic: null });
  });

  it('only its admins manage them; who is not in the project sees nothing', async () => {
    const teamId = (await ada.post(T, { name: 'Animation' })).body.teams[0].id;
    for (const user of ['eli', 'vic']) {
      expect((await as(user).post(T, { name: 'Mine' })).status, user).toBe(403);
      expect((await as(user).patch(`${T}/${teamId}`, { name: 'Mine' })).status, user).toBe(403);
      expect((await as(user).delete(`${T}/${teamId}`)).status, user).toBe(403);
    }
    expect((await as('pat').get(T)).status).toBe(403);
    expect((await as('zoe').get(T)).status).toBe(403);
    expect(names((await ada.get(T)).body)).toEqual([['Animation', []]]);
  });

  it("can't have someone who isn't a member of the project: a pending invitation, another project's member, a stranger", async () => {
    for (const memberIds of [['pat'], ['zoe'], ['stranger'], 'eli', [7]]) {
      const res = await ada.post(T, { name: 'Animation', memberIds });
      expect(res.status, JSON.stringify(memberIds)).toBe(400);
      expect(res.body.message).toMatch(/members of the project/);
    }
    const teamId = (await ada.post(T, { name: 'Animation', memberIds: ['eli'] })).body.teams[0].id;
    expect((await ada.patch(`${T}/${teamId}`, { memberIds: ['eli', 'zoe'] })).status).toBe(400);
    expect(mongo.db.docs('project_teams')[0].memberIds).toEqual(['eli']);
  });

  it('needs a name, not blank and not another team\'s', async () => {
    expect((await ada.post(T, {})).status).toBe(400);
    expect((await ada.post(T, { name: '  ' })).status).toBe(400);
    await ada.post(T, { name: 'Animation' });
    const twice = await ada.post(T, { name: 'animation' });
    expect(twice.status).toBe(409);
    const otherId = (await ada.post(T, { name: 'Sound' })).body.teams.find((t: any) => t.name === 'Sound').id;
    expect((await ada.patch(`${T}/${otherId}`, { name: 'ANIMATION' })).status).toBe(409);
    // Its own name, again, is fine.
    expect((await ada.patch(`${T}/${otherId}`, { name: 'Sound' })).status).toBe(200);
  });

  it("a team of another project, or one that's gone, isn't found", async () => {
    await as('ada').post('/projects/p2/teams', { name: 'Theirs' });
    const theirs = mongo.db.docs('project_teams')[0].id;
    expect((await ada.patch(`${T}/${theirs}`, { name: 'Mine' })).status).toBe(404);
    expect((await ada.delete(`${T}/${theirs}`)).status).toBe(404);
    expect(mongo.db.docs('project_teams')[0].name).toBe('Theirs');
  });

  it('who is taken out of the project leaves its teams, and only that project\'s', async () => {
    await ada.post(T, { name: 'Animation', memberIds: ['eli', 'vic'] });
    await ada.post(T, { name: 'Sound', memberIds: ['eli'] });
    store.projects[1].members.push({ userId: 'eli', role: 'editor', status: 'active' });
    await as('ada').post('/projects/p2/teams', { name: 'Theirs', memberIds: ['eli'] });

    const removed = await ada.delete('/projects/p1/members/eli');
    expect(removed.status).toBe(200);
    expect(names((await ada.get(T)).body)).toEqual([['Animation', ['vic']], ['Sound', []]]);
    expect(mongo.db.docs('project_teams').find((t: any) => t.projectId === 'p1' && t.name === 'Animation').memberIds).toEqual(['vic']);
    expect(mongo.db.docs('project_teams').find((t: any) => t.projectId === 'p2').memberIds).toEqual(['eli']);
  });

  it("shows only who is still in the project, however they left it", async () => {
    await ada.post(T, { name: 'Animation', memberIds: ['eli', 'vic'] });
    // Out of the project by another way than its Members page (its invitation set back to pending).
    store.projects[0].members.find((m: any) => m.userId === 'vic').status = 'pending';
    expect(names((await ada.get(T)).body)).toEqual([['Animation', ['eli']]]);
  });

  it('a deleted project takes its teams, and no other project\'s', async () => {
    await ada.post(T, { name: 'Animation' });
    await as('ada').post('/projects/p2/teams', { name: 'Theirs' });
    expect((await ada.delete('/projects/p1')).status).toBe(200);
    expect(mongo.db.docs('project_teams').map((t: any) => t.name)).toEqual(['Theirs']);
  });
});

describe('teams through an API token, and MCP', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const tokenFor = async (permissions: string[], userId = 'ada') =>
    (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
  const connect = async (token: string) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };

  it('list_teams lists them with their members, with members:read', async () => {
    await ada.post(T, { name: 'Animation', memberIds: ['eli', 'vic'] });
    const client = await connect(await tokenFor(['members:read']));
    expect((await client.listTools()).tools.map(t => t.name)).toContain('list_teams');
    const result: any = await client.callTool({ name: 'list_teams', arguments: { projectId: 'p1' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual([expect.objectContaining({
      name: 'Animation', members: [{ userId: 'eli', username: 'eli', profilePic: null }, { userId: 'vic', username: 'vic', profilePic: null }],
    })]);
  });

  it('a token reads them with members:read, and manages them only with members:manage', async () => {
    const reader = await tokenFor(['members:read']);
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    expect((await request(app).get(`/streamby${T}`).set(auth(reader))).status).toBe(200);
    expect((await request(app).post(`/streamby${T}`).set(auth(reader)).send({ name: 'Nope' })).status).toBe(403);
    expect((await request(app).post(`/streamby${T}`).set(auth(await tokenFor(['members:manage']))).send({ name: 'Yes' })).status).toBe(201);
  });
});
