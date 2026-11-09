import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FakeDb } from './fakeMongo';

// The storage's bucket is private: a project's image is read through StreamBy's image route,
// and a public export answers a signed URL in place of each direct URL of the project's own
// storage, and of each `streamby://asset/<fileId>` it refers to.
const mongo = vi.hoisted(() => ({ db: null as any }));
const exported = vi.hoisted(() => ({ data: null as unknown }));
const store: Record<string, any[]> = {};
const matchesRecord = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : k === 'memberUserId'
    ? (record.members ?? []).some((m: any) => m.userId === v) : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matchesRecord(r, filter)),
    findOne: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    create: async (doc: any) => { rows().push(doc); return doc; },
    update: async (filter: any, data: any) => { const row = rows().find(r => matchesRecord(r, filter)); if (row) Object.assign(row, data); return row ?? null; },
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
// What the export's nodes read: given by each test.
vi.mock('../src/services/executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/executor')>()),
  executeExport: async () => exported.data,
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { isPublicRoute } = await import('../src/services/auth');
const { S3Adapter } = await import('../src/adapters/storage/s3');

// The real S3 adapter knows its bucket's URLs; the rest of the storage is in memory.
const s3 = new S3Adapter({ region: 'sa-east-1', bucket: 'streamby', accessKeyId: 'k', secretAccessKey: 's' } as any);
const objects = new Set<string>();
const signedFor = (key: string) => `https://signed.test/${key}?sig`;
const adapter = {
  storageUrlsIn: (text: string) => s3.storageUrlsIn(text),
  contentInfo: async (key: string) => (objects.has(key) ? { size: 1, sha256: null } : null),
  getPresignedGetUrl: async (key: string) => signedFor(key),
  getPresignedProjectImageUrl: async (projectId: string) => ({ url: `https://upload.test/${projectId}/project-image` }),
};

const authProvider = async (req: any) => {
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  return { userId: user, username: user, role: 'viewer' as const };
};
const makeApp = (extra: object = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/streamby', createStreamByRouter({
    storageProviders: [], adapter: adapter as any, databases: [{ id: 'mongo', type: 'nosql' }], authProvider,
    publicBaseUrl: 'https://api.test/streamby', ...extra,
  }));
  return app;
};
const app = makeApp();
const eli = (p: string) => request(app).get(`/streamby${p}`).set('x-test-user', 'eli');
const open = (p: string) => request(app).get(`/streamby${p}`);

const BUCKET_IMAGE = 'https://streamby.s3.amazonaws.com/p1/project-image';
const project = (over: object = {}) => ({
  _id: 'p1', id: 'p1', name: 'Nhexa', dbType: 'nosql', allowedOrigin: ['*'], image: BUCKET_IMAGE,
  exports: [{ id: 'e1', name: 'site', nodeSchema: { nodes: [], edges: [] } }],
  members: [{ userId: 'eli', role: 'admin', status: 'active' }],
  ...over,
});

beforeEach(() => {
  mongo.db = new FakeDb();
  objects.clear();
  exported.data = null;
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [project()];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the S3 adapter's own URLs", () => {
  it('are found in any form, signed or not, URL-encoded, inside text, with their key', () => {
    const text = [
      'https://streamby.s3.sa-east-1.amazonaws.com/p1/images/a.png',
      'https://streamby.s3.amazonaws.com/p1/project-image?t=1',
      '<img src="https://streamby.s3-sa-east-1.amazonaws.com/p1%2Fproject-image">',
      '[x](https://s3.sa-east-1.amazonaws.com/streamby/p1/3d-models/b.glb?X-Amz-Signature=old)',
      'https://s3.amazonaws.com/streamby/p2/c.png',
    ].join(' ');
    expect(s3.storageUrlsIn(text).map(f => f.key)).toEqual([
      'p1/images/a.png', 'p1/project-image', 'p1/project-image', 'p1/3d-models/b.glb', 'p2/c.png',
    ]);
    expect(s3.storageUrlsIn(text)[3].url).toBe('https://s3.sa-east-1.amazonaws.com/streamby/p1/3d-models/b.glb?X-Amz-Signature=old');
  });

  it("aren't another bucket's, nor something else", () => {
    expect(s3.storageUrlsIn('https://otherbucket.s3.amazonaws.com/p1/a.png https://streamby.example.com/p1/a.png https://streambyx.s3.amazonaws.com/p1/a.png')).toEqual([]);
  });

  it('and a project image is uploaded with no URL of the bucket to save', async () => {
    const res = await eli('/upload-project-image-url/p1');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('publicUrl');
    expect(res.body.url).toBe('https://upload.test/p1/project-image');
    expect(res.body.imageUrl).toMatch(/^https:\/\/api\.test\/streamby\/p1\/image\?v=[a-z0-9]+$/);
    expect(JSON.stringify(res.body)).not.toContain('amazonaws');
  });
});

describe("a project's image", () => {
  it('is served, with no session, by a redirect to a signed URL of it', async () => {
    objects.add('p1/project-image');
    const res = await open('/p1/image');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(signedFor('p1/project-image'));
    expect(isPublicRoute('GET', '/p1/image')).toBe(true);
  });

  it("is not found when the project has none, or there's no such project", async () => {
    store.projects = [project({ image: '' })];
    expect((await open('/p1/image')).status).toBe(404);
    expect((await open('/nope/image')).status).toBe(404);
  });

  it("is answered as its route, never the bucket's URL, an old project's too", async () => {
    const image = (await eli('/projects/p1')).body.project.image;
    expect(image).toMatch(/^https:\/\/api\.test\/streamby\/p1\/image\?v=[0-9a-f]{10}$/);
    expect((await eli('/projects')).body.projects[0].image).toBe(image);
    expect((await eli('/projects/p1/preview')).body.project.image).toBe(image);
    // Saved again with a new upload's route: a new URL.
    const { imageUrl } = (await eli('/upload-project-image-url/p1')).body;
    store.projects[0].image = imageUrl;
    const after = (await eli('/projects/p1')).body.project.image;
    expect(after).toBe(imageUrl);
    expect(after).not.toBe(image);
  });

  it("is an external URL as it is, and nothing when there's none", async () => {
    store.projects = [project({ image: 'https://images.example.com/logo.png' })];
    expect((await eli('/projects/p1')).body.project.image).toBe('https://images.example.com/logo.png');
    store.projects = [project({ image: '' })];
    expect((await eli('/projects/p1')).body.project.image).toBe('');
  });
});

describe('a public export', () => {
  const answer = async () => {
    const res = await open('/p1/export/site');
    expect(res.status).toBe(200);
    return res.body;
  };

  it("answers a signed URL for each direct URL of the project's own storage, wherever it is", async () => {
    exported.data = {
      hero: 'https://streamby.s3.sa-east-1.amazonaws.com/p1/images/a.png',
      logo: 'https://streamby.s3.sa-east-1.amazonaws.com/p1%2Fproject-image',
      html: '<p><img src="https://streamby.s3.amazonaws.com/p1/images/a.png?X-Amz-Signature=old"></p>',
      list: [{ src: 'https://s3.amazonaws.com/streamby/p1/3d-models/b.glb' }],
      count: 3,
    };
    expect(await answer()).toEqual({
      hero: signedFor('p1/images/a.png'),
      logo: signedFor('p1/project-image'),
      html: `<p><img src="${signedFor('p1/images/a.png')}"></p>`,
      list: [{ src: signedFor('p1/3d-models/b.glb') }],
      count: 3,
    });
  });

  it("leaves another project's keys, another bucket's and external URLs as they are", async () => {
    exported.data = {
      otherProject: 'https://streamby.s3.sa-east-1.amazonaws.com/p2/images/a.png',
      prefixLike: 'https://streamby.s3.amazonaws.com/p10/images/a.png',
      otherBucket: 'https://otherbucket.s3.amazonaws.com/p1/images/a.png',
      external: 'https://images.example.com/p1/a.png',
    };
    expect(await answer()).toEqual(exported.data);
  });

  it("resolves a reference to one of the project's assets to its current version, signed", async () => {
    mongo.db.collection('storage_files').docs.push(
      { fileId: 'f1', projectId: 'p1', storageKey: 'p1/images/f1.png' },
      { fileId: 'f2', projectId: 'p1', storageKey: 'p1/images/f2.png', storageConnectionId: 'own-bucket' },
      { fileId: 'f3', projectId: 'p2', storageKey: 'p2/images/f3.png' },
    );
    exported.data = { one: 'streamby://asset/f1', many: ['streamby://asset/f1'], text: 'see streamby://asset/f1.', elsewhere: 'streamby://asset/f2', other: 'streamby://asset/f3', gone: 'streamby://asset/nope' };
    expect(await answer()).toEqual({
      one: signedFor('p1/images/f1.png'),
      many: [signedFor('p1/images/f1.png')],
      text: `see ${signedFor('p1/images/f1.png')}.`,
      // In another storage connection, of another project, or gone: left as it is.
      elsewhere: 'streamby://asset/f2', other: 'streamby://asset/f3', gone: 'streamby://asset/nope',
    });
  });

  it('resolves the built-in storage connection\'s assets too', async () => {
    store.projects = [project({ storageConnections: [{ id: 'c1', source: 'builtin', integrationId: 'streamby-s3' }] })];
    mongo.db.collection('storage_files').docs.push(
      { fileId: 'f1', projectId: 'p1', storageKey: 'p1/images/f1.png', storageConnectionId: 'c1' },
      { fileId: 'f2', projectId: 'p1', storageKey: 'p1/images/f2.png', storageConnectionId: 'streamby-s3' },
    );
    exported.data = ['streamby://asset/f1', 'streamby://asset/f2'];
    expect(await answer()).toEqual([signedFor('p1/images/f1.png'), signedFor('p1/images/f2.png')]);
  });
});
