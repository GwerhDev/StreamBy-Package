import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { FakeDb } from './fakeMongo';

// An export's catalog: its ready deliverables, each with its content hash, size and an immutable
// URL, and the catalog's own hash. Projects live in the models (here in memory), deliverables and
// files in a fake Mongo, and the storage is a map that, as S3 does, keeps the sha256 of what was
// uploaded with one.
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
vi.mock('../src/services/workerJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/workerJobs')>()),
  enqueueAutomaticJobs: async () => [],
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { isPublicRoute } = await import('../src/services/auth');

const sha = (bytes: string) => crypto.createHash('sha256').update(bytes).digest('hex');
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

// The storage: what's at each key, with the sha256 it was uploaded (or copied) with.
type Stored = { bytes: string; sha256: string | null; contentType?: string; cacheControl?: string };
const objects = new Map<string, Stored>();
const signed: { key: string; sha256?: string }[] = [];
const copies: { from: string; to: string; options: any }[] = [];
const adapter = {
  getPresignedUploadUrl: async (key: string, _contentType: string, _expiresIn?: number, options: { sha256?: string } = {}) => {
    signed.push({ key, sha256: options.sha256 });
    return `https://upload.test/${key}`;
  },
  copyFile: async (from: string, to: string, options: any = {}) => {
    const source = objects.get(from);
    if (!source) throw new Error(`No such key: ${from}`);
    copies.push({ from, to, options });
    // Copied with a SHA-256 checksum asked for: the storage computes it.
    objects.set(to, { ...source, sha256: sha(source.bytes), ...options });
  },
  contentInfo: async (key: string) => {
    const found = objects.get(key);
    return found ? { size: found.bytes.length, sha256: found.sha256 } : null;
  },
  getPresignedGetUrl: async (key: string, _expiresIn?: number, _name?: string, options: any = {}) =>
    `https://bucket.test/${key}?signed&cache=${encodeURIComponent(options.cacheControl ?? '')}`,
  deleteFile: async (key: string) => { objects.delete(key); },
};
// The client's upload, as the URL it was given lets it: with the hash, if it declared one.
const upload = (key: string, bytes: string) => {
  const declared = signed.filter(s => s.key === key).pop();
  objects.set(key, { bytes, sha256: declared?.sha256 && declared.sha256 === sha(bytes) ? declared.sha256 : null });
};

const authProvider = async (req: any) => {
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  return { userId: user, username: user, role: 'viewer' as const };
};
const makeApp = (extra: object = {}) => {
  const app = express();
  app.use(express.json());
  // The built-in storage is the adapter itself (an S3 provider would be a client of its own).
  app.use('/streamby', createStreamByRouter({ storageProviders: [{ id: 'builtin-storage', type: 'gcs' } as any], adapter: adapter as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider, ...extra }));
  return app;
};
const app = makeApp();

const as = (user: string) => ({
  get: (p: string) => request(app).get(`/streamby${p}`).set('x-test-user', user),
  post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
});
const eli = as('eli');
const P = '/projects/p1';
const publicGet = (p: string, target = app) => request(target).get(`/streamby${p}`);

/** A new asset uploaded (with its hash declared, unless `declare` is false). Its id and key. */
const newAsset = async (fileName: string, bytes: string, { declare = true, uploaded = true } = {}) => {
  const query = new URLSearchParams({ fileName, contentType: 'model/gltf-binary', ...(declare ? { sha256: sha(bytes) } : {}) });
  const res = await eli.get(`${P}/storage/3d-models/upload-url?${query}`);
  expect(res.status).toBe(200);
  if (uploaded) upload(res.body.storageKey, bytes);
  return { assetId: res.body.fileId as string, storageKey: res.body.storageKey as string };
};
const deliver = async (assetId: string, exportId = 'e1') => {
  const res = await eli.post(`${P}/deliverables`, { assetId, exportId });
  expect(res.status).toBe(201);
  return res.body.deliverable;
};
const catalog = async () => {
  const res = await publicGet('/p1/export/Site/catalog.json');
  expect(res.status).toBe(200);
  return res.body;
};
const catalogHash = async () => (await publicGet('/p1/export/Site/catalog.hash')).text;
// A Review Gate with no session linked to it, before a Deliverable node for the export: it holds
// its deliverables back.
const gated = () => {
  store.projects[0].workflow = { nodeSchema: {
    nodes: [
      { id: 'gate', type: 'reviewGateNode', data: { label: 'Art review' } },
      { id: 'deliver', type: 'deliverableNode', data: { appliesTo: 'exports', exportId: 'e1' } },
    ],
    edges: [{ id: 'gate-deliver', source: 'gate', target: 'deliver' }],
  } };
};

beforeEach(() => {
  mongo.db = new FakeDb();
  objects.clear(); signed.length = 0; copies.length = 0;
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'World', dbType: 'sql', allowedOrigin: ['*'],
    exports: [{ id: 'e1', name: 'Site' }, { id: 'e2', name: 'Docs' }],
    storageConnections: [{ id: 'c1', name: 'StreamBy', source: 'builtin', integrationId: 'builtin-storage' }],
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('an upload with its hash declared', () => {
  it('is signed with it, and told the header that carries it: in hex or base64', async () => {
    const hex = sha('rock');
    for (const declared of [hex, b64(hex)]) {
      const res = await eli.get(`${P}/storage/3d-models/upload-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', sha256: declared })}`);
      expect(res.status).toBe(200);
      expect(res.body.headers).toEqual({ 'Content-Type': 'model/gltf-binary', 'x-amz-checksum-sha256': b64(hex) });
      expect(signed.pop()).toEqual({ key: res.body.storageKey, sha256: hex });
    }
    const versions = mongo.db.collection('asset_versions').docs;
    expect(versions.map((v: any) => v.sha256)).toEqual([hex, hex]);
  });

  it("is refused if it isn't a SHA-256, and has no headers to send without one", async () => {
    const bad = await eli.get(`${P}/storage/3d-models/upload-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', sha256: 'abc' })}`);
    expect(bad.status).toBe(400);
    const plain = await eli.get(`${P}/storage/3d-models/upload-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary' })}`);
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty('headers');
  });

  it("is the UI's too, through the project's built-in storage connection, and its asset is catalogued", async () => {
    const C = `${P}/connections/storage/c1`;
    const hex = sha('rock v1');
    const made = await eli.get(`${C}/upload-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', category: '3d-models', sha256: hex })}`);
    expect(made.status).toBe(200);
    expect(made.body.headers).toEqual({ 'Content-Type': 'model/gltf-binary', 'x-amz-checksum-sha256': b64(hex) });
    upload(made.body.storageKey, 'rock v1');
    await deliver(made.body.fileId);
    expect((await catalog()).entries).toEqual([expect.objectContaining({ assetId: made.body.fileId, hash: hex })]);

    const replaced = await eli.get(`${C}/files/${made.body.fileId}/replace-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', sha256: sha('rock v2') })}`);
    expect(replaced.status).toBe(200);
    expect(replaced.body.headers['x-amz-checksum-sha256']).toBe(b64(sha('rock v2')));
    upload(replaced.body.storageKey, 'rock v2');
    expect((await catalog()).entries[0]).toMatchObject({ version: 2, hash: sha('rock v2') });
    expect((await eli.get(`${C}/upload-url?${new URLSearchParams({ fileName: 'a.glb', contentType: 'model/gltf-binary', category: '3d-models', sha256: 'nope' })}`)).status).toBe(400);
  });

  it('of a new version is recorded on it', async () => {
    const { assetId, storageKey } = await newAsset('rock.glb', 'rock v1');
    const res = await eli.get(`${P}/storage/files/${assetId}/replace-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', sha256: sha('rock v2') })}`);
    expect(res.status).toBe(200);
    expect(res.body.headers['x-amz-checksum-sha256']).toBe(b64(sha('rock v2')));
    const versions = mongo.db.collection('asset_versions').docs.filter((v: any) => v.assetId === assetId);
    expect(versions.map((v: any) => [v.version, v.sha256, v.storageKey === storageKey])).toEqual([[1, sha('rock v1'), false], [2, sha('rock v2'), true]]);
  });
});

describe("an export's catalog", () => {
  it('lists its ready deliverables with their hash, integrity, size and an immutable URL', async () => {
    const rock = await newAsset('rock.glb', 'rock bytes');
    const tree = await newAsset('tree.glb', 'tree');
    const other = await newAsset('docs.glb', 'docs');
    await deliver(tree.assetId); await deliver(rock.assetId); await deliver(other.assetId, 'e2');

    const body = await catalog();
    expect(body).toMatchObject({ formatVersion: 1, export: 'Site', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(body).not.toHaveProperty('excluded');
    // By key, and only the export's own.
    expect(body.entries.map((e: any) => e.key)).toEqual(['rock.glb', 'tree.glb']);
    const hex = sha('rock bytes');
    expect(body.entries[0]).toEqual({
      key: 'rock.glb', assetId: rock.assetId, version: 1, contentType: 'model/gltf-binary', size: 'rock bytes'.length,
      hash: hex, integrity: `sha256-${b64(hex)}`,
      url: expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/streamby/p1/content/${hex}\\.glb$`)),
    });
    // Its content was copied, by the storage, to a key named by its hash, to be cached forever.
    expect(objects.get(`p1/content/${hex}.glb`)).toMatchObject({ bytes: 'rock bytes', cacheControl: 'public, max-age=31536000, immutable', contentType: 'model/gltf-binary' });
    expect(await catalogHash()).toBe(body.hash);
  });

  it('keeps its hash while nothing changes, and copies each content only once', async () => {
    const rock = await newAsset('rock.glb', 'rock');
    await deliver(rock.assetId);
    const first = await catalog();
    expect(copies).toHaveLength(1);
    expect((await catalog()).hash).toBe(first.hash);
    expect(await catalogHash()).toBe(first.hash);
    expect(copies).toHaveLength(1);
  });

  it('changes its hash when a deliverable gets a new version', async () => {
    const rock = await newAsset('rock.glb', 'rock v1');
    await deliver(rock.assetId);
    const before = await catalog();
    const res = await eli.get(`${P}/storage/files/${rock.assetId}/replace-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', sha256: sha('rock v2') })}`);
    upload(res.body.storageKey, 'rock v2');

    const after = await catalog();
    expect(after.hash).not.toBe(before.hash);
    expect(after.entries[0]).toMatchObject({ version: 2, hash: sha('rock v2'), size: 'rock v2'.length });
    expect(after.entries[0].url).not.toBe(before.entries[0].url);
    // The version delivered before is still where its URL says.
    expect(objects.get(`p1/content/${sha('rock v1')}.glb`)?.bytes).toBe('rock v1');
  });

  it('leaves out a blocked deliverable until its gates pass, and its hash says so', async () => {
    const rock = await newAsset('rock.glb', 'rock');
    gated();
    expect((await deliver(rock.assetId)).status).toBe('blocked');
    const blocked = await catalog();
    expect(blocked.entries).toEqual([]);

    delete store.projects[0].workflow;
    const ready = await catalog();
    expect(ready.entries.map((e: any) => e.assetId)).toEqual([rock.assetId]);
    expect(ready.hash).not.toBe(blocked.hash);
  });

  it("leaves out what it can't vouch for, and tells its members why", async () => {
    const undeclared = await newAsset('undeclared.glb', 'a', { declare: false });
    const pending = await newAsset('pending.glb', 'b', { uploaded: false });
    const ready = await newAsset('ready.glb', 'c');
    // Uploaded with other bytes than the declared ones: the storage has no hash of it that matches.
    const wrong = await newAsset('wrong.glb', 'd', { uploaded: false });
    objects.set(wrong.storageKey, { bytes: 'not d', sha256: null });
    for (const a of [undeclared, pending, ready, wrong]) await deliver(a.assetId);

    const res = await as('vic').get(`${P}/exports/e1/catalog`);
    expect(res.status).toBe(200);
    expect(res.body.catalog.entries.map((e: any) => e.key)).toEqual(['ready.glb']);
    expect(Object.fromEntries(res.body.excluded.map((e: any) => [e.assetId, e.reason]))).toEqual({
      [undeclared.assetId]: 'no-hash', [pending.assetId]: 'not-uploaded', [wrong.assetId]: 'not-uploaded',
    });
    expect(res.body.excluded.every((e: any) => typeof e.message === 'string')).toBe(true);
    expect(res.body.catalog.hash).toBe(await catalogHash());

    gated();
    const held = await as('vic').get(`${P}/exports/e1/catalog`);
    expect(held.body.catalog.entries).toEqual([]);
    expect(held.body.excluded.map((e: any) => e.reason)).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
  });

  it("is for the project's members only, in its preview with what's left out", async () => {
    expect((await as('mallory').get(`${P}/exports/e1/catalog`)).status).toBe(403);
    expect((await as('vic').get(`${P}/exports/nope/catalog`)).status).toBe(404);
  });

  it("is for the export's allowed origins only, as the export is", async () => {
    store.projects[0].allowedOrigin = ['https://site.test'];
    expect((await publicGet('/p1/export/Site/catalog.json')).status).toBe(403);
    expect((await publicGet('/p1/export/Site/catalog.hash').set('Origin', 'https://evil.test')).status).toBe(403);
    expect((await publicGet('/p1/export/Site/catalog.json').set('Origin', 'https://site.test')).status).toBe(200);
    expect((await publicGet('/p1/export/Nope/catalog.json').set('Origin', 'https://site.test')).status).toBe(404);
    expect((await publicGet('/p1/export/Site/catalog.json').set('Origin', 'https://site.test')).headers['cache-control']).toBe('no-cache');
  });

  it("links its contents to the CDN in front of the storage, when there's one", async () => {
    const cdn = makeApp({ contentBaseUrl: 'https://cdn.test/assets/' });
    const rock = await newAsset('rock.glb', 'rock');
    await deliver(rock.assetId);
    const res = await publicGet('/p1/export/Site/catalog.json', cdn);
    expect(res.body.entries[0].url).toBe(`https://cdn.test/assets/p1/content/${sha('rock')}.glb`);
    // Where it's served isn't part of its hash.
    expect(res.body.hash).toBe((await catalog()).hash);
  });
});

describe('a catalogued content', () => {
  it('redirects, with no session, to the storage, cached forever', async () => {
    const rock = await newAsset('rock.glb', 'rock');
    await deliver(rock.assetId);
    const { entries } = await catalog();
    const path = new URL(entries[0].url).pathname.replace(/^\/streamby/, '');
    const res = await publicGet(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://bucket.test/p1/content/${sha('rock')}.glb?signed&cache=${encodeURIComponent('public, max-age=31536000, immutable')}`);
  });

  it("is not found if it wasn't catalogued, or isn't named by a hash", async () => {
    expect((await publicGet(`/p1/content/${sha('nothing')}.glb`)).status).toBe(404);
    expect(isPublicRoute('GET', '/p1/content/rock.glb')).toBe(false);
  });
});

describe("a deleted asset's catalogued content", () => {
  const remove = async (assetId: string) => expect((await request(app).delete(`/streamby${P}/storage/files/${assetId}`).set('x-test-user', 'eli')).status).toBe(200);
  const served = async (hex: string) => (await publicGet(`/p1/content/${hex}.glb`)).status;

  it('is deleted with it, every version of it, and no longer served', async () => {
    const rock = await newAsset('rock.glb', 'rock v1');
    await deliver(rock.assetId);
    await catalog();
    const res = await eli.get(`${P}/storage/files/${rock.assetId}/replace-url?${new URLSearchParams({ fileName: 'rock.glb', contentType: 'model/gltf-binary', sha256: sha('rock v2') })}`);
    upload(res.body.storageKey, 'rock v2');
    await catalog();
    expect([await served(sha('rock v1')), await served(sha('rock v2'))]).toEqual([302, 302]);

    await remove(rock.assetId);
    expect(objects.has(`p1/content/${sha('rock v1')}.glb`)).toBe(false);
    expect(objects.has(`p1/content/${sha('rock v2')}.glb`)).toBe(false);
    expect([await served(sha('rock v1')), await served(sha('rock v2'))]).toEqual([404, 404]);
    expect((await catalog()).entries).toEqual([]);
  });

  it('stays while another asset of the project has the same content', async () => {
    const rock = await newAsset('rock.glb', 'same bytes');
    const copy = await newAsset('rock-copy.glb', 'same bytes');
    await deliver(rock.assetId); await deliver(copy.assetId);
    expect((await catalog()).entries).toHaveLength(2);
    const key = `p1/content/${sha('same bytes')}.glb`;

    await remove(rock.assetId);
    expect(objects.has(key)).toBe(true);
    expect((await catalog()).entries.map((e: any) => e.assetId)).toEqual([copy.assetId]);
    await remove(copy.assetId);
    expect(objects.has(key)).toBe(false);
  });

  it("isn't touched when the asset was never catalogued", async () => {
    const rock = await newAsset('rock.glb', 'rock');
    await deliver(rock.assetId);
    await catalog();
    const other = await newAsset('other.glb', 'rock');
    await remove(other.assetId);
    expect(objects.has(`p1/content/${sha('rock')}.glb`)).toBe(true);
  });
});

describe('the public routes', () => {
  it('are an export, its catalog and its contents, and nothing else beside them', () => {
    expect(isPublicRoute('GET', '/p1/export/Site')).toBe(true);
    expect(isPublicRoute('GET', '/p1/export/Site/catalog.json')).toBe(true);
    expect(isPublicRoute('GET', '/p1/export/Site/catalog.hash')).toBe(true);
    expect(isPublicRoute('GET', `/p1/content/${sha('x')}.glb`)).toBe(true);
    expect(isPublicRoute('GET', '/p1/export/Site/other')).toBe(false);
    expect(isPublicRoute('POST', '/p1/export/Site/catalog.json')).toBe(false);
    expect(isPublicRoute('GET', `/projects/p1/content/${sha('x')}`)).toBe(false);
  });
});
