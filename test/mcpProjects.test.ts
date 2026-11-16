import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';
import { bounded } from './modelFilters';

// A project's details changed by an agent (update_project) as by its settings in the UI, and
// archived in its user's own list. Projects, users, plans and tokens live in the models (in
// memory); a project's permissions in the NoSQL database (in memory too).
const mongo = vi.hoisted(() => ({ db: null as any }));
const store: Record<string, any[]> = {};
const matches = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(bounded(name, filter) ?? (r => matches(r, filter))),
    findOne: async (filter: any) => rows().find(r => matches(r, filter)) ?? null,
    create: async (doc: any) => { const { dbType: _d, ...row } = doc; rows().push(row); return row; },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matches(r, filter));
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row ?? null;
    },
    delete: async (filter: any) => { const before = rows().length; store[name] = rows().filter(r => !matches(r, filter)); return before - store[name].length; },
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
  storageProviders: [],
  // The bucket only signs where to upload a project's image.
  adapter: { getPresignedProjectImageUrl: async (projectId: string) => ({ url: `https://bucket.example/${projectId}/project-image?signed` }) } as any,
  databases: [{ id: 'mongo', type: 'nosql', main: true }],
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
  put: (p: string, body?: object) => request(app).put(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
});
const ada = as('ada');
const eli = as('eli');

const WRITE = ['project:read', 'project:update'] as const;
const tokenFor = async (userId: string, permissions: readonly string[] = WRITE) =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
const projectTokenFor = async (projectId: string) =>
  (await createApiToken({ kind: 'project', userId: 'ada', projectId }, { name: 'ci', permissions: WRITE as any, expiresInDays: 30 }, { databases: [] } as any)).token;

let server: http.Server;
let base = '';
const connect = async (token: string) => {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const call = (client: Client, name: string, args: object) => client.callTool({ name, arguments: args as any }) as Promise<any>;
const textOf = (result: any) => result.content?.[0]?.text as string;
const project = () => store.projects.find(p => p.id === 'p1');

beforeEach(async () => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Echoforge', description: 'A DAW', public: true, category: 'music', dbType: 'nosql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }] },
  ];
  store.users = ['ada', 'eli', 'vic'].map(id => ({ _id: id, id, username: id }));
  store.user_subscriptions = [{ user_id: 'ada', plan: 'subscriber' }, { user_id: 'eli', plan: 'freemium' }];
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

describe("a project's details", () => {
  it('are all PATCH /projects/:id changes: its members and the rest are refused, nothing saved', async () => {
    for (const body of [
      { members: [{ userId: 'eli', role: 'admin', status: 'active' }] },
      { name: 'Ok', $push: { members: { userId: 'mal', role: 'admin' } } },
      { dbType: 'sql' }, {}, { name: '  ' }, { public: 'no' }, { allowedOrigin: 'x' }, { category: 3 }, { name: 'Ok', baseUpdatedAt: 'yesterday' },
    ]) {
      expect((await eli.patch('/projects/p1', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(project()).toMatchObject({ name: 'Echoforge', dbType: 'nosql' });
    expect(project().members.find((m: any) => m.userId === 'eli').role).toBe('editor');
  });

  it("are saved as the UI's settings send them, and say when", async () => {
    const saved = await eli.patch('/projects/p1', { name: ' Harmowave ', description: 'AI for your DAW', allowedOrigin: ['https://x.dev'], public: true, category: null });
    expect(saved.status).toBe(200);
    expect(saved.body.project).toMatchObject({ id: 'p1', name: 'Harmowave', description: 'AI for your DAW', category: null });
    expect(saved.body.project.updatedAt).toBeTruthy();
    expect(saved.body.projects.map((p: any) => p.name)).toEqual(['Harmowave']);
  });

  it('are saved on the project as it was read: not over a save since', async () => {
    // Never saved since it had an updatedAt: read as null.
    expect((await eli.patch('/projects/p1', { name: 'First', baseUpdatedAt: null })).status).toBe(200);
    const read = (await eli.get('/projects/p1')).body.project.updatedAt;
    expect((await ada.patch('/projects/p1', { description: 'Ada was here', baseUpdatedAt: read })).status).toBe(200);
    const stale = await eli.patch('/projects/p1', { name: 'Second', baseUpdatedAt: read });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/saved since it was read/);
    expect(project()).toMatchObject({ name: 'First', description: 'Ada was here' });
  });

  it('go private only with a subscriber plan, as a new private project does', async () => {
    expect((await eli.patch('/projects/p1', { public: false })).status).toBe(403);
    expect((await ada.patch('/projects/p1', { public: false })).status).toBe(200);
    // Already private: saving its form again isn't making it private.
    expect((await eli.patch('/projects/p1', { name: 'Still private', public: false })).status).toBe(200);
  });
});

describe('update_project', () => {
  it('renames a project, and the new name shows in the Dashboard and in Explore', async () => {
    const agent = await connect(await tokenFor('eli'));
    const read = JSON.parse(textOf(await call(agent, 'get_project', { projectId: 'p1' })));
    const renamed = await call(agent, 'update_project', { projectId: 'p1', baseUpdatedAt: read.updatedAt ?? null, name: 'Harmowave', description: 'The AI layer for your DAW' });
    expect(renamed.isError).toBeFalsy();
    expect(JSON.parse(textOf(renamed))).toMatchObject({ id: 'p1', name: 'Harmowave', description: 'The AI layer for your DAW', category: 'music' });
    expect((await eli.get('/projects')).body.projects.map((p: any) => p.name)).toEqual(['Harmowave']);
    expect((await eli.get('/projects/explore')).body.projects.map((p: any) => p.name)).toContain('Harmowave');
  });

  it('is told when the project was saved since it read it, and changes nothing', async () => {
    const agent = await connect(await tokenFor('eli'));
    await ada.patch('/projects/p1', { description: 'Changed in the UI' });
    const stale = await call(agent, 'update_project', { projectId: 'p1', baseUpdatedAt: null, name: 'Harmowave' });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/saved since it was read/);
    expect(project().name).toBe('Echoforge');
  });

  it('is refused to an editor where its admins keep it to themselves, as in the UI', async () => {
    await ada.put('/projects/p1/permissions', { roles: { 'project:update': 'admin' } });
    const fromUi = await eli.patch('/projects/p1', { name: 'Nope' });
    expect(fromUi.status).toBe(403);
    const refused = await call(await connect(await tokenFor('eli')), 'update_project', { projectId: 'p1', baseUpdatedAt: null, name: 'Nope' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(fromUi.body.message);
    // A viewer, wherever: never.
    expect((await call(await connect(await tokenFor('vic')), 'update_project', { projectId: 'p1', baseUpdatedAt: null, name: 'Nope' })).isError).toBe(true);
    // Its admin still does.
    expect((await call(await connect(await tokenFor('ada')), 'update_project', { projectId: 'p1', baseUpdatedAt: null, name: 'Harmowave' })).isError).toBeFalsy();
    expect(project().name).toBe('Harmowave');
  });

  it("sets a new image: where to upload it, then the project's image", async () => {
    const agent = await connect(await tokenFor('ada'));
    const asked = JSON.parse(textOf(await call(agent, 'request_project_image_upload', { projectId: 'p1' })));
    expect(asked.upload).toEqual({ url: 'https://bucket.example/p1/project-image?signed', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    expect(asked.imageUrl).toMatch(/\/streamby\/p1\/image\?v=/);
    const updated = await call(agent, 'update_project', { projectId: 'p1', baseUpdatedAt: null, image: asked.imageUrl });
    expect(updated.isError).toBeFalsy();
    expect(project().image).toBe(asked.imageUrl);
  });
});

describe('archive_project', () => {
  it("archives a project in its user's own list and brings it back, the others' lists as they were", async () => {
    // A viewer too: it's their own list.
    const agent = await connect(await tokenFor('vic'));
    expect((await agent.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['update_project', 'request_project_image_upload', 'archive_project']));
    const archived = await call(agent, 'archive_project', { projectId: 'p1', archived: true });
    expect(archived.isError).toBeFalsy();
    expect(JSON.parse(textOf(archived))).toMatchObject({ archived: true });
    expect(project().members.map((m: any) => [m.userId, !!m.archived])).toEqual([['ada', false], ['eli', false], ['vic', true]]);
    expect((await call(agent, 'archive_project', { projectId: 'p1', archived: false })).isError).toBeFalsy();
    expect(project().members.find((m: any) => m.userId === 'vic').archived).toBe(false);
  });

  it("isn't a project's token's: it has no list of its own", async () => {
    const tools = (await (await connect(await projectTokenFor('p1'))).listTools()).tools.map(t => t.name);
    expect(tools).toContain('update_project');
    expect(tools).not.toContain('archive_project');
  });
});
