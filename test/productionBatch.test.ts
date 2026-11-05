import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';
import { bounded } from './modelFilters';

// Production cards made in bulk in a sequence, and a project's task templates given to cards.
// Production data lives in the NoSQL database (here in memory); projects in the models (here in
// memory too).
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
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row ?? null;
    },
    delete: async () => 0,
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
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');

const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
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
const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
const as = (who: { user?: string; token?: string }) => {
  const auth = (r: request.Test) => (who.token ? r.set('Authorization', `Bearer ${who.token}`) : r.set('x-test-user', who.user!));
  return {
    get: (p: string) => auth(request(app).get(`/streamby${p}`)),
    post: (p: string, body?: object) => auth(request(app).post(`/streamby${p}`)).send(body ?? {}),
    patch: (p: string, body?: object) => auth(request(app).patch(`/streamby${p}`)).send(body ?? {}),
    delete: (p: string) => auth(request(app).delete(`/streamby${p}`)),
  };
};
const ada = as({ user: 'ada' });
const eli = as({ user: 'eli' });
const vic = as({ user: 'vic' });
const P = '/projects/p1/production';
const docs = (name: string) => mongo.db.docs(name);

const sequence = async (name = 'Characters') => (await eli.post(`${P}/sequences`, { name })).body.sequence;
const template = async (body: object = {}) => (await eli.post(`${P}/task-templates`, {
  name: 'Character', tasks: ['Modeling', { name: 'Rig and animations', priority: 'high' }, { name: 'Export and upload', notes: 'glb, Draco' }], ...body,
})).body.template;
const taskNames = (shotId: string) => docs('production_tasks').filter((t: any) => t.shotId === shotId).map((t: any) => t.name);

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'World of Gwerh', dbType: 'sql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }, { userId: 'pat', role: 'editor', status: 'pending' }] },
    { _id: 'p2', id: 'p2', name: 'Other', dbType: 'sql', members: [{ userId: 'ada', role: 'admin', status: 'active' }] },
  ];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('cards made in bulk', () => {
  it('are made at once, 18 of them, each with its key, in the order given', async () => {
    const seq = await sequence();
    const team = (await ada.post('/projects/p1/teams', { name: 'Artists', memberIds: ['eli'] })).body.teams[0];
    const rows = Array.from({ length: 18 }, (_, i) => ({
      name: `Character ${i + 1}`, description: i === 0 ? 'The hero' : undefined, assignedTo: ['eli'], teamIds: [team.id],
    }));
    const made = await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: rows });
    expect(made.status).toBe(201);
    expect(made.body.shots.map((s: any) => s.key)).toEqual(Array.from({ length: 18 }, (_, i) => `WOG-${i + 1}`));
    expect(made.body.shots.map((s: any) => s.name)).toEqual(rows.map(r => r.name));
    expect(made.body.shots[0]).toMatchObject({ sequenceId: seq.id, description: 'The hero', assignedTo: ['eli'], teamIds: [team.id], status: 'todo', columnId: 'todo' });
    expect(made.body.tasks).toBe(0);
    expect(docs('production_shots')).toHaveLength(18);
    // The next card goes on after them.
    expect((await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'Villain' })).body.shot.key).toBe('WOG-19');
  });

  it('go after the cards the sequence has, in the order they were sent', async () => {
    const seq = await sequence();
    const other = await sequence('Props');
    // Cards it has: made from the board's Create (with an order), and with none given.
    await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'First', order: 0 });
    await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'Second' });
    await eli.post(`${P}/sequences/${other.id}/shots`, { name: 'Elsewhere', order: 7 });
    const sent = ['Wolf', 'Bear', 'Fox', 'Owl', 'Deer'];
    const made = await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: sent.map(name => ({ name })) });
    expect(made.body.shots.map((s: any) => s.order)).toEqual([2, 3, 4, 5, 6]);
    const listed = (await vic.get(`${P}/sequences/${seq.id}/shots`)).body.shots.map((s: any) => s.name);
    expect(listed).toEqual(['First', 'Second', ...sent]);
    // An order given is kept.
    const placed = await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: [{ name: 'Lead', order: -1 }, { name: 'Last' }] });
    expect(placed.body.shots.map((s: any) => s.order)).toEqual([-1, 7]);
  });

  it('are none of them made when a row is wrong, the answer saying which, and spend no number', async () => {
    const seq = await sequence();
    for (const [rows, row, message] of [
      [[{ name: 'Hero' }, { name: '  ' }], 1, 'Row 2: name must not be blank'],
      [[{ name: 'Hero' }, { name: 'Villain', assignedTo: ['pat'] }], 1, 'Row 2: assignedTo must be a list of members of the project'],
      [[{ name: 'Hero', teamIds: ['nope'] }], 0, 'Row 1: teamIds must be a list of teams of the project'],
      [[{ name: 'Hero', pipelineId: 'nope' }], 0, 'Row 1: pipelineId must be a pipeline of the project'],
    ] as const) {
      const res = await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: rows });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message, row });
    }
    expect(docs('production_shots')).toEqual([]);
    expect((await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'Hero' })).body.shot.key).toBe('WOG-1');
  });

  it('take 1 to 200 cards, in a sequence of the project, for its editors', async () => {
    const seq = await sequence();
    expect((await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: [] })).status).toBe(400);
    expect((await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: Array.from({ length: 201 }, (_, i) => ({ name: `C${i}` })) })).status).toBe(400);
    expect((await eli.post(`${P}/sequences/${seq.id}/shots/batch`, {})).status).toBe(400);
    expect((await eli.post(`${P}/sequences/nope/shots/batch`, { shots: [{ name: 'Hero' }] })).status).toBe(404);
    expect((await vic.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: [{ name: 'Hero' }] })).status).toBe(403);
    expect((await as({ user: 'ada' }).post(`/projects/p2/production/sequences/${seq.id}/shots/batch`, { shots: [{ name: 'Hero' }] })).status).toBe(404);
    expect(docs('production_shots')).toEqual([]);
  });

  it('made by two requests at once never share a key', async () => {
    const seq = await sequence();
    const batch = (prefix: string) => eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: Array.from({ length: 5 }, (_, i) => ({ name: `${prefix}${i}` })) });
    const [a, b] = await Promise.all([batch('A'), batch('B')]);
    const keys = [...a.body.shots, ...b.body.shots].map((s: any) => s.key);
    expect(new Set(keys).size).toBe(10);
  });

  it("get a template's tasks, each card its own", async () => {
    const seq = await sequence();
    const character = await template();
    const made = await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: [{ name: 'Hero' }, { name: 'Villain' }], templateId: character.id });
    expect(made.body.tasks).toBe(6);
    for (const card of made.body.shots) expect(taskNames(card.id)).toEqual(['Modeling', 'Rig and animations', 'Export and upload']);
    expect(docs('production_tasks').find((t: any) => t.name === 'Rig and animations')).toMatchObject({ priority: 'high', status: 'todo', notes: null });
    expect(docs('production_tasks').find((t: any) => t.name === 'Export and upload')).toMatchObject({ priority: 'medium', notes: 'glb, Draco' });
    // A template that isn't the project's makes nothing.
    expect((await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: [{ name: 'Extra' }], templateId: 'nope' })).status).toBe(400);
    expect(docs('production_shots')).toHaveLength(2);
  });
});

describe('a task template', () => {
  it('is made, listed, changed and deleted by editors; seen by any member', async () => {
    const character = await template();
    expect(character).toMatchObject({ name: 'Character', tasks: [
      { name: 'Modeling', priority: 'medium', notes: null }, { name: 'Rig and animations', priority: 'high', notes: null }, { name: 'Export and upload', priority: 'medium', notes: 'glb, Draco' },
    ] });
    expect((await vic.get(`${P}/task-templates`)).body.templates.map((t: any) => t.name)).toEqual(['Character']);
    expect((await vic.post(`${P}/task-templates`, { name: 'Prop', tasks: ['Model'] })).status).toBe(403);
    const renamed = await eli.patch(`${P}/task-templates/${character.id}`, { name: 'Hero character', tasks: ['Sculpt'] });
    expect(renamed.body.template).toMatchObject({ name: 'Hero character', tasks: [{ name: 'Sculpt', priority: 'medium', notes: null }] });
    expect((await eli.patch(`${P}/task-templates/nope`, { name: 'X' })).status).toBe(404);
    expect((await eli.delete(`${P}/task-templates/${character.id}`)).status).toBe(200);
    expect((await vic.get(`${P}/task-templates`)).body.templates).toEqual([]);
    expect((await eli.delete(`${P}/task-templates/${character.id}`)).status).toBe(404);
  });

  it('checks what it is given', async () => {
    for (const body of [
      { tasks: ['Model'] }, { name: ' ', tasks: ['Model'] }, { name: 'X' }, { name: 'X', tasks: [] }, { name: 'X', tasks: [' '] },
      { name: 'X', tasks: [{ name: 'Model', priority: 'urgent' }] }, { name: 'X', tasks: Array.from({ length: 51 }, () => 'T') },
    ]) {
      expect((await eli.post(`${P}/task-templates`, body)).status).toBe(400);
    }
    expect(docs('production_task_templates')).toEqual([]);
  });

  it("gives a card its tasks when it's made, and cards already made theirs", async () => {
    const seq = await sequence();
    const character = await template();
    const hero = await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'Hero', templateId: character.id });
    expect(hero.status).toBe(201);
    expect(hero.body.tasks).toBe(3);
    expect(taskNames(hero.body.shot.id)).toEqual(['Modeling', 'Rig and animations', 'Export and upload']);

    const [a, b] = (await eli.post(`${P}/sequences/${seq.id}/shots/batch`, { shots: [{ name: 'Wolf' }, { name: 'Bear' }] })).body.shots;
    const applied = await eli.post(`${P}/task-templates/${character.id}/apply`, { shotIds: [a.id, b.id, a.id] });
    expect(applied.status).toBe(201);
    expect(applied.body.tasks).toBe(6);
    expect(taskNames(a.id)).toHaveLength(3);
    // Its card shows how its tasks go.
    const listed = (await vic.get(`${P}/sequences/${seq.id}/shots`)).body.shots.find((s: any) => s.id === a.id);
    expect(listed.taskSummary).toMatchObject({ done: 0, total: 3, priority: 'high' });
  });

  it("is applied only to the project's cards, or to none", async () => {
    const seq = await sequence();
    const character = await template();
    const hero = (await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'Hero' })).body.shot;
    expect((await eli.post(`${P}/task-templates/${character.id}/apply`, { shotIds: [hero.id, 'nope'] })).status).toBe(404);
    expect((await eli.post(`${P}/task-templates/${character.id}/apply`, { shotIds: [] })).status).toBe(400);
    expect((await eli.post(`${P}/task-templates/nope/apply`, { shotIds: [hero.id] })).status).toBe(404);
    expect((await vic.post(`${P}/task-templates/${character.id}/apply`, { shotIds: [hero.id] })).status).toBe(403);
    expect(docs('production_tasks')).toEqual([]);
  });

  it('changed or deleted, leaves the tasks it gave', async () => {
    const seq = await sequence();
    const character = await template();
    const hero = (await eli.post(`${P}/sequences/${seq.id}/shots`, { name: 'Hero', templateId: character.id })).body.shot;
    await eli.patch(`${P}/task-templates/${character.id}`, { tasks: ['Other'] });
    await eli.delete(`${P}/task-templates/${character.id}`);
    expect(taskNames(hero.id)).toEqual(['Modeling', 'Rig and animations', 'Export and upload']);
  });

  it('is managed by a token with production:write, and only seen with production:read', async () => {
    const reader = as({ token: await tokenFor(['production:read']) });
    const writer = as({ token: await tokenFor(['production:read', 'production:write']) });
    expect((await reader.post(`${P}/task-templates`, { name: 'Prop', tasks: ['Model'] })).status).toBe(403);
    const made = await writer.post(`${P}/task-templates`, { name: 'Prop', tasks: ['Model'] });
    expect(made.status).toBe(201);
    expect((await reader.get(`${P}/task-templates`)).body.templates).toHaveLength(1);
    expect((await writer.delete(`${P}/task-templates/${made.body.template.id}`)).status).toBe(403);
  });
});

describe('from the MCP server', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const call = async (client: Client, name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: args as any });
    return { error: result.isError ? result.content[0].text as string : null, data: result.isError ? null : JSON.parse(result.content[0].text || 'null') };
  };

  it('makes several cards in one call, a template, and gives its tasks to cards', async () => {
    const seq = await sequence();
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const token = await tokenFor(['production:read', 'production:write'], 'eli');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const made = await call(client, 'create_shots', { projectId: 'p1', sequenceId: seq.id, shots: [{ name: 'Hero', assignedTo: ['eli'] }, { name: 'Villain' }, { name: 'Wolf' }] });
    expect(made.error).toBeNull();
    expect(made.data.shots.map((s: any) => s.key)).toEqual(['WOG-1', 'WOG-2', 'WOG-3']);

    const character = await call(client, 'create_task_template', { projectId: 'p1', name: 'Character', tasks: ['Modeling', { name: 'Rig', priority: 'high' }] });
    expect(character.data).toMatchObject({ name: 'Character', tasks: [{ name: 'Modeling' }, { name: 'Rig', priority: 'high' }] });
    expect((await call(client, 'list_task_templates', { projectId: 'p1' })).data.map((t: any) => t.id)).toEqual([character.data.id]);
    const applied = await call(client, 'apply_task_template', { projectId: 'p1', templateId: character.data.id, shotIds: made.data.shots.map((s: any) => s.id) });
    expect(applied.data.tasks).toBe(6);
    // Without production:delete, a template isn't deleted.
    const tools = (await client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(expect.arrayContaining(['create_shots', 'list_task_templates', 'create_task_template', 'update_task_template', 'apply_task_template']));
    expect(tools).not.toContain('delete_task_template');
    await client.close();
  });
});
