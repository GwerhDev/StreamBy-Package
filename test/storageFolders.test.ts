import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Storage's folders and an asset's name, as an agent handles them (the MCP server's folder and
// asset tools) through the routes Storage uses. Projects live in the models, files and folders
// in a fake Mongo; the built-in storage is the adapter given.
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

const adapter = {
  getPresignedUploadUrl: async (key: string) => `https://upload.test/${key}`,
  getPresignedGetUrl: async (key: string) => `https://download.test/${key}`,
  deleteFile: async () => {},
};
const app = express();
app.use(express.json());
// The built-in storage is the adapter itself (an S3 provider would be a client of its own).
app.use('/streamby', createStreamByRouter({
  storageProviders: [{ id: 'streamby-s3', type: 'gcs' } as any], adapter: adapter as any, databases: [{ id: 'pg', type: 'sql', main: true }],
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

const files = () => mongo.db.collection('storage_files').docs;
const folders = () => mongo.db.collection('storage_folders').docs;
// An image in the built-in storage, stamped as Storage stamps them (with its connection's row id).
const image = (fileId: string, displayName: string, over: object = {}) =>
  files().push({ fileId, projectId: 'p1', category: 'images', storageKey: `p1/images/${fileId}.png`, displayName, storageConnectionId: 'c-builtin', createdAt: new Date(), ...over });

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql',
    storageConnections: [
      { id: 'c-builtin', name: 'StreamBy', source: 'builtin', integrationId: 'streamby-s3' },
      { id: 'c-other', name: 'Own bucket', source: 'integration', integrationId: 'i1' },
    ],
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  image('a1', 'shadowclan-1.png');
  image('a2', 'latuinahub-img.png');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Storage, through the built-in storage by the name `builtin`', () => {
  const eli = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) =>
    request(app)[method](`/streamby/projects/p1/connections/storage/builtin${path}`).set('x-test-user', 'eli').send(body);

  it("is the project's built-in storage connection: its folders and files", async () => {
    const made = await eli('post', '/folders', { name: 'ShadowClan' });
    expect(made.status).toBe(201);
    // A built-in storage's folder, as Storage makes them (with no connection of its own).
    expect(folders()[0]).toMatchObject({ projectId: 'p1', name: 'ShadowClan', parentId: null });
    expect(folders()[0]).not.toHaveProperty('storageConnectionId');
    expect((await eli('get', '/folders')).body.data.map((f: any) => f.name)).toEqual(['ShadowClan']);
    // The same, by the connection's own id.
    expect((await request(app).get('/streamby/projects/p1/connections/storage/c-builtin/folders').set('x-test-user', 'eli')).body.data).toHaveLength(1);
    expect((await eli('get', '/files/images')).body.data.map((f: any) => f.displayName).sort()).toEqual(['latuinahub-img.png', 'shadowclan-1.png']);
  });

  it('uploads into a folder, of this storage only', async () => {
    const folder = (await eli('post', '/folders', { name: 'ShadowClan' })).body.folder;
    const up = await eli('get', `/upload-url?${new URLSearchParams({ fileName: 'shadowclan-2.png', contentType: 'image/png', category: 'images', folderId: folder.id })}`);
    expect(up.status).toBe(200);
    expect(files().find((f: any) => f.fileId === up.body.fileId)).toMatchObject({ folderId: folder.id, displayName: 'shadowclan-2.png' });

    // Its own upload route (the built-in storage's) too.
    const own = await request(app).get(`/streamby/projects/p1/storage/images/upload-url?${new URLSearchParams({ fileName: 'shadowclan-3.png', contentType: 'image/png', folderId: folder.id })}`).set('x-test-user', 'eli');
    expect(own.status).toBe(200);
    expect(files().find((f: any) => f.fileId === own.body.fileId).folderId).toBe(folder.id);

    // Another storage's folder, or none such: refused, and nothing is made.
    folders().push({ folderId: 'f-other', projectId: 'p1', name: 'Elsewhere', parentId: null, storageConnectionId: 'c-other' });
    const before = files().length;
    expect((await eli('get', `/upload-url?${new URLSearchParams({ fileName: 'x.png', contentType: 'image/png', category: 'images', folderId: 'f-other' })}`)).status).toBe(404);
    expect((await eli('get', `/upload-url?${new URLSearchParams({ fileName: 'x.png', contentType: 'image/png', category: 'images', folderId: 'nope' })}`)).status).toBe(404);
    expect(files()).toHaveLength(before);
    // Without one, at the top.
    const top = await eli('get', `/upload-url?${new URLSearchParams({ fileName: 'x.png', contentType: 'image/png', category: 'images' })}`);
    expect(files().find((f: any) => f.fileId === top.body.fileId).folderId).toBeNull();
  });
});

describe('the folder and asset tools, from an agent', () => {
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
  const call = async (client: Client, name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: { projectId: 'p1', ...args } });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content?.[0]?.text);
  };
  const assets = async (client: Client) =>
    Object.fromEntries((await call(client, 'list_assets', { category: 'images' })).map((f: any) => [f.displayName, f.folderId]));

  it('makes a folder, uploads into it and moves an existing asset to it', async () => {
    const agent = await connect(['assets:read', 'assets:write']);
    const folder = await call(agent, 'create_storage_folder', { name: 'ShadowClan' });
    expect(folder).toMatchObject({ name: 'ShadowClan', parentId: null });
    expect(await call(agent, 'list_storage_folders', {})).toEqual([expect.objectContaining({ id: folder.id, name: 'ShadowClan' })]);
    const inside = await call(agent, 'create_storage_folder', { name: '2024', parentId: folder.id });
    expect((await call(agent, 'list_storage_folders', { parentId: folder.id })).map((f: any) => f.id)).toEqual([inside.id]);

    const upload = await call(agent, 'request_asset_upload', { category: 'images', fileName: 'shadowclan-2.png', contentType: 'image/png', folderId: folder.id });
    expect(upload.upload.url).toMatch(/^https:\/\/upload\.test\/p1\/images\//);
    expect(await call(agent, 'move_asset', { assetId: 'a1', folderId: folder.id })).toEqual({ assetId: 'a1', displayName: 'shadowclan-1.png', folderId: folder.id });

    expect(await assets(agent)).toEqual({ 'shadowclan-1.png': folder.id, 'shadowclan-2.png': folder.id, 'latuinahub-img.png': null });
    // And back to the top.
    await call(agent, 'move_asset', { assetId: 'a1', folderId: null });
    expect((await assets(agent))['shadowclan-1.png']).toBeNull();
    await expect(call(agent, 'move_asset', { assetId: 'a1', folderId: 'nope' })).rejects.toThrow(/Folder not found/);
  });

  it('renames an asset, and Storage shows it by its new name', async () => {
    const agent = await connect(['assets:read', 'assets:write']);
    expect(await call(agent, 'rename_asset', { assetId: 'a2', name: 'latiunahub-img.png' })).toEqual({ assetId: 'a2', displayName: 'latiunahub-img.png', folderId: null });
    const listed = (await request(app).get('/streamby/projects/p1/connections/storage/c-builtin/files/images').set('x-test-user', 'eli')).body.data;
    expect(listed.map((f: any) => f.displayName).sort()).toEqual(['latiunahub-img.png', 'shadowclan-1.png']);
    // Its file isn't touched.
    expect(files().find((f: any) => f.fileId === 'a2').storageKey).toBe('p1/images/a2.png');
  });

  it('renames a folder; deleting one needs assets:delete, and keeps what was in it', async () => {
    const writer = await connect(['assets:read', 'assets:write']);
    const folder = await call(writer, 'create_storage_folder', { name: 'Shadowclan' });
    await call(writer, 'move_asset', { assetId: 'a1', folderId: folder.id });
    expect(await call(writer, 'rename_storage_folder', { folderId: folder.id, name: 'ShadowClan' })).toMatchObject({ name: 'ShadowClan' });
    expect((await writer.listTools()).tools.map(t => t.name)).not.toContain('delete_storage_folder');

    const deleter = await connect(['assets:read', 'assets:delete']);
    const tool = (await deleter.listTools()).tools.find(t => t.name === 'delete_storage_folder');
    expect(tool?.annotations).toMatchObject({ destructiveHint: true });
    await call(deleter, 'delete_storage_folder', { folderId: folder.id });
    expect(folders()).toEqual([]);
    expect(files().find((f: any) => f.fileId === 'a1')).toMatchObject({ folderId: null, displayName: 'shadowclan-1.png' });
  });

  it("is for who can edit the project's assets", async () => {
    const reader = await connect(['assets:read']);
    const names = (await reader.listTools()).tools.map(t => t.name);
    expect(names).toContain('list_storage_folders');
    for (const name of ['create_storage_folder', 'rename_storage_folder', 'move_asset', 'rename_asset', 'delete_storage_folder']) expect(names).not.toContain(name);
    // A viewer of the project, whatever its token.
    expect((await request(app).post('/streamby/projects/p1/connections/storage/builtin/folders').set('x-test-user', 'vic').send({ name: 'X' })).status).toBe(403);
  });
});
