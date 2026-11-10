import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Changing an export's data as an agent does (set_export_json, update_export): through the
// export's PATCH, on the version it was read at. Projects live in the models, in memory.
const mongo = vi.hoisted(() => ({ db: null as any }));
const store: Record<string, any[]> = {};
const matchesRecord = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matchesRecord(r, filter)),
    findOne: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    create: async (doc: any) => { rows().push(doc); return doc; },
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
  storageProviders: [{ id: 's3', type: 's3', config: { region: 'sa-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } } as any],
  adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
  authProvider: async (req: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer);
      if (!resolved) throw new Error('Invalid API token');
      return { userId: resolved.userId, username: resolved.name, role: 'viewer', apiToken: resolved.scope };
    }
    const user = req.headers['x-test-user'];
    if (!user) throw new Error('No session');
    return { userId: user, username: user, role: 'viewer' };
  },
}));

const MENU = [{ label: 'Home', icon: 'https://streamby.s3.sa-east-1.amazonaws.com/p1/images/home.png' }];
// menu-list as nhexa.cl reads it: a JSON Data node feeding StreamBy, StreamBy answering it.
const menuList = () => ({
  id: 'e1', name: 'menu-list', description: 'The menu', allowedOrigin: ['*'], private: false,
  nodeSchema: {
    nodes: [
      { id: 'request', type: 'requestNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'streamby', type: 'streambyNode', position: { x: 200, y: 0 }, data: {} },
      { id: 'response', type: 'responseNode', position: { x: 400, y: 0 }, data: {} },
      { id: 'json-menu', type: 'jsonInputNode', position: { x: 200, y: 200 }, data: { label: 'JSON Data', jsonString: JSON.stringify(MENU) } },
    ],
    edges: [
      { id: 'a', source: 'request', target: 'streamby', targetHandle: 'in-left' },
      { id: 'b', source: 'streamby', target: 'response', sourceHandle: 'out-right', targetHandle: 'in-left' },
      { id: 'c', source: 'json-menu', target: 'streamby', targetHandle: 'in-bottom' },
    ],
  },
});
const project = () => store.projects[0];
const entry = () => project().exports[0];
const P = '/projects/p1';
const patch = (body: object, user = 'eli') => request(app).patch(`/streamby${P}/exports/e1`).set('x-test-user', user).send(body);
const read = async () => (await request(app).get(`/streamby${P}/exports/e1`).set('x-test-user', 'eli')).body.data;
const served = async () => (await request(app).get('/streamby/p1/export/menu-list')).body;

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Nhexa', dbType: 'sql', allowedOrigin: ['*'],
    exports: [menuList(), { id: 'e2', name: 'develop', nodeSchema: { nodes: [], edges: [] } }],
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("replacing a JSON Data node's JSON", () => {
  const NEW_MENU = [{ label: 'Home', icon: 'streamby://asset/f-home' }, { label: 'Apps', icon: 'streamby://asset/f-apps' }];

  it('saves it on the version it was read at, and the export serves it', async () => {
    expect(await served()).toEqual(MENU);
    const before = await read();
    expect(before.updatedAt).toBeNull();

    const res = await patch({ baseUpdatedAt: before.updatedAt, jsonNode: { nodeId: 'json-menu', json: JSON.stringify(NEW_MENU) } });
    expect(res.status).toBe(200);
    expect(await served()).toEqual(NEW_MENU);
    // The rest of its schema as it was.
    expect(entry().nodeSchema.edges).toEqual(menuList().nodeSchema.edges);
    expect(entry().name).toBe('menu-list');

    const after = await read();
    expect(after.updatedAt).toEqual(expect.any(String));
    // Again, on the version it has now.
    expect((await patch({ baseUpdatedAt: after.updatedAt, jsonNode: { nodeId: 'json-menu', json: '[]' } })).status).toBe(200);
    expect(await served()).toEqual([]);
  });

  it("is refused on an old version (409) and when it isn't JSON (400), and nothing changes", async () => {
    const { updatedAt: first } = await read();
    expect((await patch({ baseUpdatedAt: first, jsonNode: { nodeId: 'json-menu', json: '[1]' } })).status).toBe(200);

    const stale = await patch({ baseUpdatedAt: first, jsonNode: { nodeId: 'json-menu', json: '[2]' } });
    expect(stale.status).toBe(409);
    expect(stale.body.updatedAt).toBe((await read()).updatedAt);
    expect(await served()).toEqual([1]);

    const { updatedAt } = await read();
    const invalid = await patch({ baseUpdatedAt: updatedAt, jsonNode: { nodeId: 'json-menu', json: '[{"label": "Home",]' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toMatch(/^Not valid JSON/);
    expect((await patch({ baseUpdatedAt: updatedAt, jsonNode: { nodeId: 'request', json: '[]' } })).body.message).toBe("request isn't a JSON Data node");
    expect((await patch({ baseUpdatedAt: updatedAt, jsonNode: { nodeId: 'nope', json: '[]' } })).status).toBe(404);
    expect((await patch({ baseUpdatedAt: updatedAt, jsonNode: { nodeId: 'json-menu' } })).status).toBe(400);
    expect((await patch({ baseUpdatedAt: 'yesterday', jsonNode: { nodeId: 'json-menu', json: '[]' } })).status).toBe(400);
    expect(await served()).toEqual([1]);
  });

  it("is for who can edit the project; the editor's own save (no version given) still works", async () => {
    expect((await patch({ baseUpdatedAt: null, jsonNode: { nodeId: 'json-menu', json: '[]' } }, 'vic')).status).toBe(403);
    const schema = menuList().nodeSchema;
    schema.nodes[3].data.jsonString = '["from the editor"]';
    expect((await patch({ nodeSchema: schema })).status).toBe(200);
    expect(await served()).toEqual(['from the editor']);
  });
});

describe("changing an export's name, description and allowed origins", () => {
  it('changes them on the version it was read at', async () => {
    const res = await patch({ baseUpdatedAt: null, name: 'main-menu', description: 'The site menu', allowedOrigin: ['https://nhexa.cl'] });
    expect(res.status).toBe(200);
    expect(entry()).toMatchObject({ name: 'main-menu', description: 'The site menu', allowedOrigin: ['https://nhexa.cl'] });
    // Its schema as it was.
    expect(entry().nodeSchema).toEqual(menuList().nodeSchema);
    expect((await patch({ baseUpdatedAt: null, description: 'Again' })).status).toBe(409);
  });

  it("refuses a name that's empty or another export's, and origins that aren't a list", async () => {
    expect((await patch({ baseUpdatedAt: null, name: ' ' })).status).toBe(400);
    const taken = await patch({ baseUpdatedAt: null, name: 'Develop' });
    expect(taken.status).toBe(400);
    expect(taken.body.message).toBe('The project has an export named Develop already');
    expect((await patch({ baseUpdatedAt: null, allowedOrigin: 'https://nhexa.cl' })).status).toBe(400);
    expect(entry().name).toBe('menu-list');
  });
});

describe('the export tools, from an agent', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const connect = async (permissions: string[]) => {
    const { token } = await createApiToken({ kind: 'user', userId: 'eli' }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const textOf = (result: any) => result.content?.[0]?.text as string;

  it("replaces menu-list's JSON, as the user, and is told when it changed since it read it", async () => {
    const agent = await connect(['exports:read', 'exports:write']);
    const read = JSON.parse(textOf(await agent.callTool({ name: 'get_export', arguments: { projectId: 'p1', exportId: 'e1' } }))).data;
    const node = read.nodeSchema.nodes.find((n: any) => n.type === 'jsonInputNode');
    const json = JSON.stringify([{ label: 'Home', icon: 'streamby://asset/f-home' }]);

    const made = await agent.callTool({ name: 'set_export_json', arguments: { projectId: 'p1', exportId: 'e1', nodeId: node.id, json, baseUpdatedAt: read.updatedAt } });
    expect(made.isError).toBeFalsy();
    expect(JSON.parse(textOf(made)).updatedAt).toEqual(expect.any(String));
    expect(await served()).toEqual([{ label: 'Home', icon: 'streamby://asset/f-home' }]);

    const stale = await agent.callTool({ name: 'set_export_json', arguments: { projectId: 'p1', exportId: 'e1', nodeId: node.id, json: '[]', baseUpdatedAt: read.updatedAt } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/changed since it was read/);
    const invalid = await agent.callTool({ name: 'set_export_json', arguments: { projectId: 'p1', exportId: 'e1', nodeId: node.id, json: '{', baseUpdatedAt: JSON.parse(textOf(made)).updatedAt } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toMatch(/Not valid JSON/);

    const renamed = await agent.callTool({ name: 'update_export', arguments: { projectId: 'p1', exportId: 'e1', description: 'Menu', baseUpdatedAt: JSON.parse(textOf(made)).updatedAt } });
    expect(renamed.isError).toBeFalsy();
    expect(entry().description).toBe('Menu');
  });

  it('are only for a token that writes exports', async () => {
    const reader = await connect(['exports:read']);
    const names = (await reader.listTools()).tools.map(t => t.name);
    expect(names).toContain('get_export');
    expect(names).not.toContain('set_export_json');
    expect(names).not.toContain('update_export');
  });
});
