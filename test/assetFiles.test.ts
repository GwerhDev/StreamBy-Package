import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import request from 'supertest';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Files, versions and deliverables live in the NoSQL database (here in memory); projects and
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

// The storage, in memory: its files by key, and signed URLs that say what they're for and how
// long they work. `put` and `get` stand for a client using them.
const objects = new Map<string, string>();
const deleted: string[] = [];
const failures = { copy: false };
const adapter: Record<string, any> = {
  getPresignedUploadUrl: async (key: string, contentType: string, expiresIn?: number) =>
    `https://storage.test/put/${key}?type=${encodeURIComponent(contentType)}&expires=${expiresIn ?? 'default'}`,
  getPresignedGetUrl: async (key: string, expiresIn?: number, downloadName?: string) =>
    `https://storage.test/get/${key}?expires=${expiresIn ?? 'default'}${downloadName ? `&name=${encodeURIComponent(downloadName)}` : ''}`,
  copyFile: async (from: string, to: string) => {
    if (failures.copy || !objects.has(from)) throw new Error('copy failed');
    objects.set(to, objects.get(from)!);
  },
  deleteFile: async (key: string) => { deleted.push(key); objects.delete(key); },
};
const keyOf = (url: string) => new URL(url).pathname.replace(/^\/(put|get)\//, '');
const put = (url: string, content: string) => objects.set(keyOf(url), content);
const get = (url: string) => objects.get(keyOf(url));

const authProvider = async (req: any) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (bearer?.startsWith(API_TOKEN_PREFIX)) {
    const resolved = await resolveApiToken(bearer);
    if (!resolved) throw new Error('Invalid API token');
    return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
  }
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  return { userId: user, username: user, role: 'viewer' as const };
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({ storageProviders: [], adapter: adapter as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider }));

const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
const as = (who: { user?: string; token?: string }) => {
  const auth = (r: request.Test) => (who.token ? r.set('Authorization', `Bearer ${who.token}`) : r.set('x-test-user', who.user!));
  return {
    get: (p: string) => auth(request(app).get(`/streamby${p}`)),
    post: (p: string, body?: object) => auth(request(app).post(`/streamby${p}`)).send(body ?? {}),
    delete: (p: string) => auth(request(app).delete(`/streamby${p}`)),
  };
};
const eli = as({ user: 'eli' });
const query = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const uploadModel = (who = eli, name = 'shot010.glb') =>
  who.get(`/projects/p1/storage/3d-models/upload-url?${query({ fileName: name, contentType: 'model/gltf-binary' })}`);

beforeEach(() => {
  mongo.db = new FakeDb();
  deleted.length = 0;
  objects.clear();
  failures.copy = false;
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
    exports: [{ id: 'e1', name: 'trailer' }],
  }];
  mongo.db.collection('production_shots').docs.push({ id: 's1', projectId: 'p1', sequenceId: 'q1', name: 'SH010' });
  mongo.db.collection('production_sequences').docs.push({ id: 'q1', projectId: 'p1', name: 'Opening' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('uploading', () => {
  it('a new asset: its record, its first version, and a URL for its file', async () => {
    const res = await uploadModel();
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`https://storage.test/put/${res.body.storageKey}?type=model%2Fgltf-binary&expires=default`);
    expect(mongo.db.docs('storage_files')).toEqual([expect.objectContaining({ fileId: res.body.fileId, displayName: 'shot010.glb' })]);
    expect(mongo.db.docs('asset_versions')).toEqual([expect.objectContaining({ assetId: res.body.fileId, version: 1, storageKey: res.body.storageKey })]);
  });

  it('with a token, a URL that works only briefly, and says until when', async () => {
    const res = await uploadModel(as({ token: await tokenFor(['assets:write']) }));
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/expires=900$/);
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(890_000);
  });

  it('a token without assets:write uploads nothing', async () => {
    const res = await uploadModel(as({ token: await tokenFor(['assets:read']) }));
    expect(res.status).toBe(403);
    expect(mongo.db.docs('storage_files')).toEqual([]);
  });

  const replace = (fileId: string, fileName = 'shot010_v2.glb', who = eli) =>
    who.get(`/projects/p1/storage/files/${fileId}/replace-url?${query({ fileName, contentType: 'model/gltf-binary' })}`);

  it("a new version goes to the asset's own key, so its URL doesn't change; the earlier one is archived", async () => {
    const first = (await uploadModel()).body;
    put(first.url, 'v1 bytes');
    const urlBefore = (await eli.get('/projects/p1/storage/3d-models')).body.data[0].url;

    const res = await replace(first.fileId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fileId: first.fileId, version: 2, storageKey: first.storageKey });
    expect(keyOf(res.body.url)).toBe(first.storageKey);
    put(res.body.url, 'v2 bytes');

    const archived = first.storageKey.replace(/\.glb$/, '.v1.glb');
    expect(objects.get(archived)).toBe('v1 bytes');
    expect(mongo.db.docs('storage_files')[0].storageKey).toBe(first.storageKey);
    expect((await eli.get('/projects/p1/storage/3d-models')).body.data[0].url).toBe(urlBefore);
    expect(get(urlBefore)).toBe('v2 bytes');
    expect(mongo.db.docs('asset_versions').map((v: any) => [v.version, v.storageKey])).toEqual([[1, archived], [2, first.storageKey]]);

    // A third: version 2 is archived in turn, and the asset's key is the new one again.
    put((await replace(first.fileId, 'v3.glb')).body.url, 'v3 bytes');
    expect(objects.get(first.storageKey.replace(/\.glb$/, '.v2.glb'))).toBe('v2 bytes');
    expect(get(urlBefore)).toBe('v3 bytes');
  });

  it("if the current version can't be archived, nothing is replaced and no URL is given", async () => {
    const first = (await uploadModel()).body;
    put(first.url, 'v1 bytes');
    failures.copy = true;
    const res = await replace(first.fileId);
    expect(res.status).toBe(502);
    expect(res.body.url).toBeUndefined();
    expect(objects.get(first.storageKey)).toBe('v1 bytes');
    expect(mongo.db.docs('asset_versions').map((v: any) => [v.version, v.storageKey])).toEqual([[1, first.storageKey]]);
  });

  it("a storage that can't copy keeps no versions, and replaces nothing", async () => {
    const first = (await uploadModel()).body;
    const copyFile = adapter.copyFile;
    delete adapter.copyFile;
    try {
      expect((await replace(first.fileId)).status).toBe(501);
    } finally {
      adapter.copyFile = copyFile;
    }
  });

  it('an asset from before versions were kept gets its first one when it gets a second', async () => {
    mongo.db.collection('storage_files').docs.push({ fileId: 'old', projectId: 'p1', category: 'images', storageKey: 'p1/images/old.png', displayName: 'old.png', contentType: 'image/png' });
    objects.set('p1/images/old.png', 'old bytes');
    const res = await eli.get(`/projects/p1/storage/files/old/replace-url?${query({ fileName: 'new.png', contentType: 'image/png' })}`);
    expect(res.body.version).toBe(2);
    expect(mongo.db.docs('asset_versions').map((v: any) => v.storageKey)).toEqual(['p1/images/old.v1.png', 'p1/images/old.png']);
    expect(objects.get('p1/images/old.v1.png')).toBe('old bytes');
  });

  it("a viewer can't upload a new version", async () => {
    const first = (await uploadModel()).body;
    const res = await as({ user: 'vic' }).get(`/projects/p1/storage/files/${first.fileId}/replace-url?${query({ fileName: 'x.glb', contentType: 'model/gltf-binary' })}`);
    expect(res.status).toBe(403);
  });
});

describe('downloading', () => {
  it('the current version, or an earlier one by its id, with its name', async () => {
    const first = (await uploadModel()).body;
    put(first.url, 'v1 bytes');
    put((await eli.get(`/projects/p1/storage/files/${first.fileId}/replace-url?${query({ fileName: 'shot010_v2.glb', contentType: 'model/gltf-binary' })}`)).body.url, 'v2 bytes');

    const latest = await eli.get(`/projects/p1/assets/${first.fileId}/download-url`);
    expect(latest.status).toBe(200);
    expect(get(latest.body.url)).toBe('v2 bytes');
    const v1Id = mongo.db.docs('asset_versions').find((v: any) => v.version === 1).versionId;
    const v1 = await eli.get(`/projects/p1/assets/${first.fileId}/download-url?versionId=${v1Id}`);
    expect(v1.body).toMatchObject({ version: 1, fileName: 'shot010.glb' });
    expect(get(v1.body.url)).toBe('v1 bytes');
    expect(v1.body.url).toMatch(/expires=3600&name=shot010\.glb$/);
    expect((await eli.get(`/projects/p1/assets/${first.fileId}/download-url?versionId=nope`)).status).toBe(404);
  });

  it("not for someone outside the project", async () => {
    const { fileId } = (await uploadModel()).body;
    const res = await as({ user: 'stranger' }).get(`/projects/p1/assets/${fileId}/download-url`);
    expect(res.status).toBe(403);
    expect(res.body.url).toBeUndefined();
  });

  it('with a token, a URL of minutes; without assets:read, none', async () => {
    const { fileId } = (await uploadModel()).body;
    const reader = await as({ token: await tokenFor(['assets:read']) }).get(`/projects/p1/assets/${fileId}/download-url`);
    expect(reader.body.url).toMatch(/expires=300&/);
    expect(reader.body.expiresAt).toBeTruthy();
    expect((await as({ token: await tokenFor(['production:read']) }).get(`/projects/p1/assets/${fileId}/download-url`)).status).toBe(403);
  });

  it("a token's listed files come with short-lived URLs too", async () => {
    await uploadModel();
    const list = await as({ token: await tokenFor(['assets:read']) }).get('/projects/p1/storage/3d-models');
    expect(list.body.data[0].url).toMatch(/expires=300$/);
  });
});

describe('deliverables', () => {
  it("are marked for a shot, listed with their asset's and shot's names, and removed", async () => {
    const { fileId } = (await uploadModel()).body;
    const versionId = mongo.db.docs('asset_versions')[0].versionId;
    const marked = await eli.post('/projects/p1/deliverables', { assetId: fileId, versionId, shotId: 's1', note: 'Layout pass' });
    expect(marked.status).toBe(201);
    expect(marked.body.deliverable).toMatchObject({
      assetId: fileId, versionId, shotId: 's1', exportId: null, note: 'Layout pass', createdBy: 'eli',
      asset: { displayName: 'shot010.glb', category: '3d-models' }, version: 1, shotName: 'SH010',
    });
    await eli.post('/projects/p1/deliverables', { assetId: fileId, exportId: 'e1' });

    const ofShot = await eli.get('/projects/p1/deliverables?shotId=s1');
    expect(ofShot.body.deliverables.map((d: any) => d.shotId)).toEqual(['s1']);
    const all = await eli.get('/projects/p1/deliverables');
    expect(all.body.deliverables).toHaveLength(2);
    expect(all.body.deliverables.find((d: any) => d.exportId === 'e1').exportName).toBe('trailer');

    expect((await eli.delete(`/projects/p1/deliverables/${marked.body.deliverable.id}`)).status).toBe(200);
    expect((await eli.get('/projects/p1/deliverables?shotId=s1')).body.deliverables).toEqual([]);
    expect(mongo.db.docs('storage_files')).toHaveLength(1);
  });

  it('are for what exists in the project, and for one shot or one export', async () => {
    const { fileId } = (await uploadModel()).body;
    for (const [body, status] of [
      [{ assetId: fileId }, 400],
      [{ assetId: fileId, shotId: 's1', exportId: 'e1' }, 400],
      [{ assetId: 'nope', shotId: 's1' }, 404],
      [{ assetId: fileId, versionId: 'nope', shotId: 's1' }, 404],
      [{ assetId: fileId, shotId: 'nope' }, 404],
      [{ assetId: fileId, exportId: 'nope' }, 404],
    ] as const) {
      expect((await eli.post('/projects/p1/deliverables', body)).status).toBe(status);
    }
    expect(mongo.db.docs('deliverables')).toEqual([]);
  });

  it("need assets:write (or an editor) to be marked, and assets:read to be listed", async () => {
    const { fileId } = (await uploadModel()).body;
    expect((await as({ user: 'vic' }).post('/projects/p1/deliverables', { assetId: fileId, shotId: 's1' })).status).toBe(403);
    expect((await as({ token: await tokenFor(['assets:read']) }).post('/projects/p1/deliverables', { assetId: fileId, shotId: 's1' })).status).toBe(403);
    expect((await as({ token: await tokenFor(['assets:write']) }).post('/projects/p1/deliverables', { assetId: fileId, shotId: 's1' })).status).toBe(201);
    expect((await as({ token: await tokenFor(['production:read']) }).get('/projects/p1/deliverables')).status).toBe(403);
    expect((await as({ token: await tokenFor(['assets:read']) }).get('/projects/p1/deliverables')).status).toBe(200);
  });

  it("go when their shot, sequence or export goes", async () => {
    const { fileId } = (await uploadModel()).body;
    mongo.db.collection('production_shots').docs.push({ id: 's2', projectId: 'p1', sequenceId: 'q2', name: 'SH020' });
    await eli.post('/projects/p1/deliverables', { assetId: fileId, shotId: 's1' });
    await eli.post('/projects/p1/deliverables', { assetId: fileId, shotId: 's2' });
    expect((await eli.delete('/projects/p1/production/shots/s2')).status).toBe(200);
    expect(mongo.db.docs('deliverables').map((d: any) => d.shotId)).toEqual(['s1']);
    expect((await eli.delete('/projects/p1/production/sequences/q1')).status).toBe(200);
    expect(mongo.db.docs('deliverables')).toEqual([]);
  });
});

it("deleting an asset deletes every key of its file (its own and its versions'), and its deliverables", async () => {
  const first = (await uploadModel()).body;
  put(first.url, 'v1');
  mongo.db.collection('storage_files').docs.push({ fileId: 'other', projectId: 'p1', category: '3d-models', storageKey: 'p1/3d-models/other.glb' });
  objects.set('p1/3d-models/other.glb', 'other');
  put((await eli.get(`/projects/p1/storage/files/${first.fileId}/replace-url?${query({ fileName: 'v2.glb', contentType: 'model/gltf-binary' })}`)).body.url, 'v2');
  await eli.post('/projects/p1/deliverables', { assetId: first.fileId, shotId: 's1' });
  expect((await eli.delete(`/projects/p1/storage/files/${first.fileId}`)).status).toBe(200);
  expect(deleted.sort()).toEqual([first.storageKey, first.storageKey.replace(/\.glb$/, '.v1.glb')].sort());
  expect([...objects.keys()]).toEqual(['p1/3d-models/other.glb']);
  expect(mongo.db.docs('asset_versions')).toEqual([]);
  expect(mongo.db.docs('deliverables')).toEqual([]);
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

  const connect = async (token: string) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: args as any });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text || 'null');
  };

  it('lists the file tools by permission', async () => {
    const reader = (await (await connect(await tokenFor(['assets:read']))).listTools()).tools.map(t => t.name);
    expect(reader).toEqual(expect.arrayContaining(['get_asset_download_url', 'list_asset_versions', 'list_deliverables']));
    expect(reader).not.toContain('request_asset_upload');
    expect(reader).not.toContain('mark_deliverable');
    const writer = (await (await connect(await tokenFor(['assets:write']))).listTools()).tools.map(t => t.name);
    expect(writer).toEqual(expect.arrayContaining(['request_asset_upload', 'mark_deliverable', 'remove_deliverable']));
  });

  // As from Blender: ask where to upload the export, (Blender uploads it), mark it as the
  // shot's deliverable; later, a new version of it; then download it elsewhere.
  it('uploads an export as a new asset and a new version, marks it for a shot, and downloads it', async () => {
    const client = await connect(await tokenFor(['assets:read', 'assets:write']));
    const upload = await call(client, 'request_asset_upload', { projectId: 'p1', category: '3d-models', fileName: 'SH010_layout.glb', contentType: 'model/gltf-binary' });
    expect(upload).toMatchObject({ version: 1, upload: { method: 'PUT', headers: { 'Content-Type': 'model/gltf-binary' } } });
    expect(upload.upload.url).toMatch(/expires=900$/);
    expect(upload.expiresAt).toBeTruthy();

    put(upload.upload.url, 'from Blender');
    const marked = await call(client, 'mark_deliverable', { projectId: 'p1', assetId: upload.assetId, shotId: 's1' });
    expect(marked).toMatchObject({ shotName: 'SH010', asset: { displayName: 'SH010_layout.glb' } });

    const v2 = await call(client, 'request_asset_upload', { projectId: 'p1', category: '3d-models', fileName: 'SH010_layout_v2.glb', contentType: 'model/gltf-binary', assetId: upload.assetId });
    expect(v2).toMatchObject({ assetId: upload.assetId, version: 2 });

    const versions = await call(client, 'list_asset_versions', { projectId: 'p1', assetId: upload.assetId });
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const download = await call(client, 'get_asset_download_url', { projectId: 'p1', assetId: upload.assetId, versionId: versions[1].versionId });
    expect(download).toMatchObject({ version: 1, fileName: 'SH010_layout.glb' });
    expect(download.url).toMatch(/expires=300&/);

    expect((await call(client, 'list_deliverables', { projectId: 'p1', shotId: 's1' })).map((d: any) => d.assetId)).toEqual([upload.assetId]);
  });
});
