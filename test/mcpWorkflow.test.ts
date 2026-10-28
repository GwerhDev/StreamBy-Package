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
const nodesOf = () => store.projects[0].workflow?.nodeSchema?.nodes ?? [];
const WRITER = ['production:write', 'workflow:write'];

describe('production through the workflow', () => {
  it('the tools that make production data need workflow:write too', async () => {
    const names = (await (await connect(await tokenFor(['production:write', 'production:read']))).listTools()).tools.map(t => t.name);
    expect(names).not.toContain('create_sequence');
    expect(names).not.toContain('create_shot');
    expect(names).toContain('update_shot');
    expect((await (await connect(await tokenFor(WRITER))).listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['create_sequence', 'create_shot', 'create_task']));
  });

  it('a sequence in a project without a production node adds a Shot node first, as the UI does', async () => {
    const client = await connect(await tokenFor(WRITER));
    const result = await call(client, 'create_sequence', { projectId: 'p1', name: 'Opening' });
    expect(result.isError).toBeFalsy();
    // Beside the orchestrator, there in every workflow.
    expect(nodesOf()).toEqual([expect.objectContaining({ id: 'streamby', type: 'orchestratorNode' }), expect.objectContaining({
      type: 'shotNode', id: expect.stringMatching(/^shotNode-/), data: expect.objectContaining({ label: 'Shot', subtitle: 'Raw video clip' }),
    })]);
    expect(mongo.db.docs('production_sequences').map((s: any) => s.name)).toEqual(['Opening']);

    // Once it's there, nothing more is added.
    await call(client, 'create_sequence', { projectId: 'p1', name: 'Chase' });
    expect(nodesOf()).toHaveLength(2);
  });

  it("keeps the workflow's other nodes and edges", async () => {
    const schema = {
      nodes: [{ id: 'streamby', type: 'orchestratorNode' }, { id: 'pipeline-x', type: 'pipelineRefNode' }],
      edges: [{ id: 'e-streamby-pipeline-x', source: 'streamby', target: 'pipeline-x' }],
    };
    store.projects[0].workflow = { id: 'w1', name: 'Workflow', nodeSchema: schema };
    await call(await connect(await tokenFor(WRITER)), 'create_sequence', { projectId: 'p1', name: 'Opening' });
    expect(nodesOf().map((n: any) => n.type)).toEqual(['orchestratorNode', 'pipelineRefNode', 'shotNode']);
    expect(store.projects[0].workflow.nodeSchema.edges).toEqual(schema.edges);
  });

  it('counts any production node (an Assembly, a Master) as one', async () => {
    store.projects[0].workflow = { id: 'w1', name: 'Workflow', nodeSchema: { nodes: [{ id: 'a', type: 'assemblyNode' }], edges: [] } };
    await call(await connect(await tokenFor(WRITER)), 'create_sequence', { projectId: 'p1', name: 'Opening' });
    expect(nodesOf().map((n: any) => n.type)).toEqual(['assemblyNode']);
  });

  it("makes nothing when the node can't be added, and says why", async () => {
    // Vic is a viewer: the workflow refuses them, and so nothing is made.
    const result = await call(await connect(await tokenFor(WRITER, 'vic')), 'create_sequence', { projectId: 'p1', name: 'Opening' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Couldn't add a production node/);
    expect(nodesOf()).toEqual([]);
    expect(mongo.db.docs('production_sequences')).toEqual([]);
    expect(store.mcp_audit.at(-1)).toMatchObject({ tool: 'create_sequence', ok: false, projectId: 'p1' });
  });

  it('a shot and a task add the node too, for production data made before it', async () => {
    mongo.db.collection('production_sequences').docs.push({ id: 'q1', projectId: 'p1', name: 'Old' });
    const client = await connect(await tokenFor(WRITER));
    const shot = await call(client, 'create_shot', { projectId: 'p1', sequenceId: 'q1', name: 'SH010' });
    expect(shot.isError).toBeFalsy();
    expect(nodesOf().map((n: any) => n.type)).toEqual(['orchestratorNode', 'shotNode']);
  });
});
