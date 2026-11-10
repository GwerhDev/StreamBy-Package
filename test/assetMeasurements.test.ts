import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// A 3D asset's measurements (sent by whoever measured it: the inspector, in the browser) kept
// with its version, and checked against the project's budget profiles. Files, versions and
// budgets live in a fake Mongo; projects in the models, in memory.
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
    update: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
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
const { exceededBy, checkBudgets } = await import('../src/services/assetMeasurements');

const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
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

const P = '/projects/p1';
const as = (user: string) => ({
  get: (p: string) => request(app).get(`/streamby${P}${p}`).set('x-test-user', user),
  put: (p: string, body: object) => request(app).put(`/streamby${P}${p}`).set('x-test-user', user).send(body),
});
const eli = as('eli');
const vic = as('vic');

// What the inspector measures of a goblin: over a Character's budget in triangles and in one
// texture's size and format.
const GOBLIN = {
  triangles: 18_400, vertices: 9_900, meshes: 3, materials: 2, tool: 'streamby-inspector',
  textures: [
    { name: 'goblin_albedo', width: 2048, height: 2048, format: 'image/png' },
    { name: 'goblin_normal', width: 1024, height: 1024, format: 'image/ktx2' },
  ],
  animations: [{ name: 'Idle', duration: 2.5 }, { name: 'Run', duration: 0.8 }],
};
const BUDGETS = {
  profiles: [
    { id: 'character', name: 'Character', maxTriangles: 15_000, maxMaterials: 3, maxTextures: 4, maxTextureSize: 1024, textureFormats: ['image/ktx2', 'image/webp'] },
    { id: 'prop', name: 'Prop', maxTriangles: 2_000 },
  ],
  defaultProfileId: 'prop',
};

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'World of Gwerh', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  mongo.db.collection('storage_files').docs.push({ fileId: 'a1', projectId: 'p1', category: '3d-models', storageKey: 'p1/3d-models/a1.glb', displayName: 'goblin.glb' });
  mongo.db.collection('asset_versions').docs.push(
    { versionId: 'v1', assetId: 'a1', projectId: 'p1', version: 1, storageKey: 'p1/3d-models/a1.v1.glb' },
    { versionId: 'v2', assetId: 'a1', projectId: 'p1', version: 2, storageKey: 'p1/3d-models/a1.glb' },
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a 3D asset's measurements", () => {
  it("are none until it's measured, and then kept with its version", async () => {
    const unmeasured = await eli.get('/assets/a1/measurements');
    expect(unmeasured.status).toBe(200);
    expect(unmeasured.body).toMatchObject({ versionId: 'v2', version: 2, measurements: null, profile: null, exceeded: [] });

    const sent = await eli.put('/assets/a1/versions/v2/measurements', GOBLIN);
    expect(sent.status).toBe(200);
    const kept = mongo.db.collection('asset_versions').docs.find((v: any) => v.versionId === 'v2').measurements;
    expect(kept).toMatchObject({ ...GOBLIN, measuredBy: 'eli' });
    expect((await eli.get('/assets/a1/measurements')).body.measurements).toMatchObject({ triangles: 18_400, animations: GOBLIN.animations });
    // Another version, unmeasured still.
    expect((await eli.get('/assets/a1/measurements?versionId=v1')).body).toMatchObject({ version: 1, measurements: null });
  });

  it("say what's over the profile it's checked against: its own, or the project's default", async () => {
    await eli.put('/asset-budgets', BUDGETS);
    await eli.put('/assets/a1/versions/v2/measurements', GOBLIN);
    // The default, a Prop's.
    expect((await eli.get('/assets/a1/measurements')).body).toMatchObject({
      profileId: null, profile: { id: 'prop' }, exceeded: [{ metric: 'triangles', limit: 2000, value: 18_400 }],
    });

    expect((await eli.put('/assets/a1/budget-profile', { profileId: 'character' })).status).toBe(200);
    const read = (await eli.get('/assets/a1/measurements')).body;
    expect(read.profile.name).toBe('Character');
    expect(read.exceeded).toEqual([
      { metric: 'triangles', limit: 15_000, value: 18_400 },
      { metric: 'textureSize', limit: 1024, value: 2048, texture: 'goblin_albedo' },
      { metric: 'textureFormat', limit: ['image/ktx2', 'image/webp'], value: 'image/png', texture: 'goblin_albedo' },
    ]);
    expect((await eli.put('/assets/a1/budget-profile', { profileId: 'nope' })).status).toBe(400);
  });

  it('are refused when they are not counts, and for versions or assets that are not there', async () => {
    expect((await eli.put('/assets/a1/versions/v2/measurements', { ...GOBLIN, triangles: -1 })).status).toBe(400);
    expect((await eli.put('/assets/a1/versions/v2/measurements', { ...GOBLIN, textures: [{ name: 'x' }] })).status).toBe(400);
    expect((await eli.put('/assets/a1/versions/v2/measurements', { ...GOBLIN, animations: [{ duration: 'long' }] })).status).toBe(400);
    expect((await eli.put('/assets/a1/versions/v9/measurements', GOBLIN)).status).toBe(404);
    expect((await eli.get('/assets/nope/measurements')).status).toBe(404);
  });

  it("are the project's members' to read, and its editors' to send", async () => {
    expect((await vic.get('/assets/a1/measurements')).status).toBe(200);
    expect((await vic.put('/assets/a1/versions/v2/measurements', GOBLIN)).status).toBe(403);
    expect((await vic.put('/asset-budgets', BUDGETS)).status).toBe(403);
    expect((await as('mallory').get('/assets/a1/measurements')).status).toBe(403);
  });
});

describe("a project's budgets", () => {
  it('are none until set, and then its profiles, checked', async () => {
    expect((await eli.get('/asset-budgets')).body.budgets).toEqual({ profiles: [], defaultProfileId: null });
    expect((await eli.put('/asset-budgets', BUDGETS)).status).toBe(200);
    expect((await vic.get('/asset-budgets')).body.budgets).toEqual(BUDGETS);
    for (const [body, message] of [
      [{ profiles: [{ maxTriangles: 1 }] }, 'Each profile has a name'],
      [{ profiles: [{ name: 'A', maxTriangles: 1.5 }] }, 'A: maxTriangles is a whole number, 0 or more'],
      [{ profiles: [{ name: 'A' }, { name: 'a' }] }, 'Two profiles are named a'],
      [{ profiles: [{ name: 'A' }], defaultProfileId: 'nope' }, 'defaultProfileId is one of the profiles'],
      [{ profiles: [{ name: 'A', textureFormats: 'png' }] }, 'A: textureFormats is a list of MIME types (image/png, image/ktx2...)'],
    ] as const) {
      const res = await eli.put('/asset-budgets', body);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    }
  });

  it("check only the limits a profile sets, and nothing without one", () => {
    const m = { ...GOBLIN, measuredAt: new Date(), measuredBy: 'eli', tool: null } as any;
    expect(exceededBy(m, null)).toEqual([]);
    expect(exceededBy(m, { id: 'x', name: 'Free' })).toEqual([]);
    expect(exceededBy(m, { id: 'x', name: 'Tight', maxAnimations: 1, maxTextures: 1 })).toEqual([
      { metric: 'textures', limit: 1, value: 2 }, { metric: 'animations', limit: 1, value: 2 },
    ]);
    expect((checkBudgets({ profiles: [{ name: 'New' }] }) as any).profiles[0].id).toEqual(expect.any(String));
  });
});

describe('the measurements, from an agent', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  it("reads a version's measurements, what's over its budget, and the project's budgets", async () => {
    await eli.put('/asset-budgets', BUDGETS);
    await eli.put('/assets/a1/budget-profile', { profileId: 'character' });
    await eli.put('/assets/a1/versions/v2/measurements', GOBLIN);
    const { token } = await createApiToken({ kind: 'user', userId: 'eli' }, { name: 'agent', permissions: ['assets:read', 'project:read'] as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any);
    const agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: object) => JSON.parse(((await agent.callTool({ name, arguments: { projectId: 'p1', ...args } })) as any).content[0].text);

    const read = await call('get_asset_measurements', { assetId: 'a1' });
    expect(read.measurements).toMatchObject({ triangles: 18_400, materials: 2, textures: GOBLIN.textures, animations: GOBLIN.animations });
    expect(read.exceeded.map((e: any) => e.metric)).toEqual(['triangles', 'textureSize', 'textureFormat']);
    expect((await call('get_asset_measurements', { assetId: 'a1', versionId: 'v1' })).measurements).toBeNull();
    expect((await call('list_asset_versions', { assetId: 'a1' })).map((v: any) => [v.version, v.measured])).toEqual([[2, true], [1, false]]);
    expect((await call('get_asset_budgets', {})).profiles.map((p: any) => p.name)).toEqual(['Character', 'Prop']);
  });
});
