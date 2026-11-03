import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Production data lives in the NoSQL database (here in memory); projects, their workflows and
// tokens in the models (here in memory too).
const mongo = vi.hoisted(() => ({ db: null as any }));
const store: Record<string, any[]> = {};
const matchesRecord = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matchesRecord(r, filter)),
    findOne: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    create: async (doc: any) => { const { dbType: _d, ...row } = doc; rows().push(row); return row; },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matchesRecord(r, filter));
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
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

const authProvider = async (req: any) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (!bearer?.startsWith(API_TOKEN_PREFIX)) throw new Error('No session');
  const resolved = await resolveApiToken(bearer);
  if (!resolved) throw new Error('Invalid API token');
  return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({ storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider }));

const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;

let server: http.Server;
let base = '';
beforeEach(async () => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
});

const connect = async (token: string) => {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const call = (client: Client, name: string, args: object) => client.callTool({ name, arguments: args as any }) as Promise<any>;
const PRODUCER = ['production:write'];

describe('production through MCP', () => {
  it('the tools that make production data need only production:write', async () => {
    const { tools } = await (await connect(await tokenFor(PRODUCER))).listTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_sequence', 'create_shot', 'create_task']));
    expect(names).not.toContain('create_pipeline');
    for (const name of ['create_sequence', 'create_shot', 'create_task']) {
      expect(tools.find(t => t.name === name)!.description).not.toMatch(/workflow|node/i);
    }
  });

  const make = async (client: Client) => {
    const sequence = await call(client, 'create_sequence', { projectId: 'p1', name: 'Opening' });
    expect(sequence.isError).toBeFalsy();
    const seqId = mongo.db.docs('production_sequences')[0].id;
    expect((await call(client, 'create_shot', { projectId: 'p1', sequenceId: seqId, name: 'SH010' })).isError).toBeFalsy();
    const shotId = mongo.db.docs('production_shots')[0].id;
    expect((await call(client, 'create_task', { projectId: 'p1', shotId, name: 'Layout' })).isError).toBeFalsy();
    expect(mongo.db.docs('production_tasks').map((t: any) => t.name)).toEqual(['Layout']);
  };

  it("a sequence, a shot and a task leave a project that has no workflow yet without one", async () => {
    await make(await connect(await tokenFor(PRODUCER)));
    expect(store.projects[0].workflow).toBeUndefined();
  });

  it('a sequence, a shot and a task leave a saved workflow exactly as it was', async () => {
    const workflow = {
      id: 'w1', name: 'Workflow', updatedAt: '2026-10-28T10:00:00.000Z', resourceNodesAt: '2026-10-28T10:00:00.000Z',
      nodeSchema: {
        nodes: [{ id: 'streamby', type: 'orchestratorNode' }, { id: 'pipeline-x', type: 'pipelineRefNode' }],
        edges: [{ id: 'e-streamby-pipeline-x', source: 'streamby', target: 'pipeline-x' }],
      },
    };
    store.projects[0].workflow = JSON.parse(JSON.stringify(workflow));
    await make(await connect(await tokenFor(PRODUCER)));
    expect(store.projects[0].workflow).toEqual(workflow);
  });

  it('assigns people and teams to a shot and a task', async () => {
    mongo.db.collection('project_teams').docs.push({ id: 'team-a', projectId: 'p1', name: 'Animation', memberIds: ['vic'] });
    const client = await connect(await tokenFor(PRODUCER));
    await call(client, 'create_sequence', { projectId: 'p1', name: 'Opening' });
    const sequenceId = mongo.db.docs('production_sequences')[0].id;
    const shot = await call(client, 'create_shot', { projectId: 'p1', sequenceId, name: 'SH010', assignedTo: ['eli', 'vic'], teamIds: ['team-a'] });
    expect(shot.isError).toBeFalsy();
    const shotId = mongo.db.docs('production_shots')[0].id;
    expect(mongo.db.docs('production_shots')[0]).toMatchObject({ assignedTo: ['eli', 'vic'], teamIds: ['team-a'] });

    expect((await call(client, 'create_task', { projectId: 'p1', shotId, name: 'Layout', assignedTo: ['eli'], teamIds: ['team-a'] })).isError).toBeFalsy();
    const taskId = mongo.db.docs('production_tasks')[0].id;
    expect((await call(client, 'update_task', { projectId: 'p1', shotId, taskId, assignedTo: ['eli', 'vic'], teamIds: [] })).isError).toBeFalsy();
    expect(mongo.db.docs('production_tasks')[0]).toMatchObject({ assignedTo: ['eli', 'vic'], teamIds: [] });

    const refused = await call(client, 'update_shot', { projectId: 'p1', shotId, teamIds: ['not-a-team'] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/teams of the project/);
  });

  it("answers the board's columns, and each card's column and status; puts a card in a column", async () => {
    const client = await connect(await tokenFor(['production:read', 'production:write']));
    const columns = JSON.parse((await call(client, 'list_board_columns', { projectId: 'p1' })).content[0].text);
    expect(columns.map((c: any) => [c.id, c.status])).toEqual([['todo', 'todo'], ['in_progress', 'in_progress'], ['review', 'review'], ['done', 'done']]);

    await call(client, 'create_sequence', { projectId: 'p1', name: 'Opening' });
    const sequenceId = mongo.db.docs('production_sequences')[0].id;
    expect((await call(client, 'create_shot', { projectId: 'p1', sequenceId, name: 'SH010', columnId: 'review' })).isError).toBeFalsy();
    const shots = JSON.parse((await call(client, 'list_shots', { projectId: 'p1', sequenceId })).content[0].text).shots;
    expect(shots.map((s: any) => [s.name, s.columnId, s.status])).toEqual([['SH010', 'review', 'review']]);
  });

  it("a viewer's token makes nothing, and says why", async () => {
    const result = await call(await connect(await tokenFor(PRODUCER, 'vic')), 'create_sequence', { projectId: 'p1', name: 'Opening' });
    expect(result.isError).toBe(true);
    expect(mongo.db.docs('production_sequences')).toEqual([]);
    expect(store.mcp_audit.at(-1)).toMatchObject({ tool: 'create_sequence', ok: false, projectId: 'p1' });
  });
});
