import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { FakeDb } from './fakeMongo';

// The thumbnails a list of files shows: made once, in the background, kept beside each file, and
// made again when the file is replaced; the URLs of a list, the same for the hour.
const mongo = vi.hoisted(() => ({ db: null as any }));
const events = vi.hoisted(() => [] as { userId: string; event: any }[]);
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
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: (userId: string, event: any) => { events.push({ userId, event }); } }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { thumbnailsSettled } = await import('../src/services/thumbnails');
const { S3Adapter } = await import('../src/adapters/storage/s3');

// The storage: files by key, its signed URLs real URLs here (each signing a new one, as S3's).
const objects = new Map<string, Buffer>();
let signings = 0;
const storage = http.createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname.slice(1));
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); });
    return;
  }
  const found = objects.get(key);
  if (!found) return res.writeHead(404).end();
  res.writeHead(200).end(found);
});
await new Promise<void>(resolve => storage.listen(0, '127.0.0.1', resolve));
const storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
const adapter = {
  getPresignedUploadUrl: async (key: string) => `${storageUrl}/${encodeURIComponent(key)}`,
  getPresignedGetUrl: async (key: string, _ttl?: number, _name?: string, options?: { stable?: boolean }) =>
    `${storageUrl}/${encodeURIComponent(key)}${options?.stable ? '?stable' : `?s=${++signings}`}`,
  deleteFile: async (key: string) => { objects.delete(key); },
  copyFile: async (from: string, to: string) => { objects.set(to, objects.get(from)!); },
};

const makeApp = (extra: object = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/streamby', createStreamByRouter({
    storageProviders: [], adapter: adapter as any, databases: [{ id: 'pg', type: 'sql', main: true }],
    authProvider: async (req: any) => ({ userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer' as const }),
    ...extra,
  } as any));
  return app;
};
const serve = async (app: express.Express) => {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby` };
};
const { server, base } = await serve(makeApp());
const list = async (category: string, at = base) =>
  (await (await fetch(`${at}/projects/p1/storage/${category}`, { headers: { 'x-test-user': 'eli' } })).json()).data;
const fileDoc = (fileId: string) => mongo.db.docs('storage_files').find((f: any) => f.fileId === fileId);

const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'streamby-thumbs-'));
let image: Buffer, video: Buffer;
beforeAll(async () => {
  const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720', '-frames:v', '1', path.join(fixtures, 'big.png'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', path.join(fixtures, 'clip.mp4'));
  image = await fs.readFile(path.join(fixtures, 'big.png'));
  video = await fs.readFile(path.join(fixtures, 'clip.mp4'));
}, 60_000);
afterAll(async () => { await fs.rm(fixtures, { recursive: true, force: true }); server.close(); storage.close(); });

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  objects.clear();
  events.length = 0;
  store.projects = [{ _id: 'p1', id: 'p1', name: 'World of Gwerh', dbType: 'sql', members: [
    { userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }] }];
  const add = (fileId: string, category: string, name: string, contentType: string, bytes?: Buffer) => {
    const storageKey = `p1/${category}/${fileId}`;
    if (bytes) objects.set(storageKey, bytes);
    mongo.db.collection('storage_files').docs.push({ fileId, projectId: 'p1', category, storageKey, displayName: name, contentType, createdAt: new Date('2026-11-01') });
  };
  add('big', 'images', 'big.png', 'image/png', image);
  add('clip', 'videos', 'clip.mp4', 'video/mp4', video);
  add('model', '3d-models', 'rock.glb', 'model/gltf-binary', Buffer.from('glb'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe("a list's thumbnails", () => {
  it("are made for an image and a video, small, beside the file: the list after has them, and members are told", async () => {
    const first = await list('images');
    expect(first[0]).toMatchObject({ id: 'big', thumbnailUrl: null });
    await list('videos');
    await thumbnailsSettled();

    const thumb = objects.get('p1/images/big.thumb.webp')!;
    expect(thumb.subarray(8, 12).toString()).toBe('WEBP');
    expect(thumb.length).toBeLessThan(image.length / 4);
    expect(objects.get('p1/videos/clip.thumb.webp')).toBeDefined();
    expect(fileDoc('big').thumbnail).toMatchObject({ storageKey: 'p1/images/big.thumb.webp' });

    const told = events.filter(e => e.event.type === 'assetThumbnailEvent' && e.event.data.fileId === 'big');
    expect(told.map(e => e.userId).sort()).toEqual(['eli', 'vic']);
    expect(told[0].event.data.thumbnailUrl).toContain('big.thumb.webp');
    expect((await list('images'))[0].thumbnailUrl).toContain('big.thumb.webp');
  });

  it('is made once: a list read again while it is made, or after, makes no other', async () => {
    await Promise.all([list('images'), list('images'), list('images')]);
    await thumbnailsSettled();
    await list('images');
    await thumbnailsSettled();
    expect(events.filter(e => e.event.type === 'assetThumbnailEvent' && e.userId === 'eli')).toHaveLength(1);
  });

  it("is made again for a file replaced since; a model has none", async () => {
    await list('images');
    await thumbnailsSettled();
    await fetch(`${base}/projects/p1/storage/files/big/replace-url?contentType=image/png&fileName=big.png`, { headers: { 'x-test-user': 'eli' } });
    expect((await list('images'))[0].thumbnailUrl).toBeNull();
    await thumbnailsSettled();
    expect((await list('images'))[0].thumbnailUrl).toContain('big.thumb.webp');
    await list('3d-models');
    await thumbnailsSettled();
    expect(fileDoc('model').thumbnail).toBeUndefined();
  });

  it("isn't tried again at once when it can't be made (its file not uploaded yet)", async () => {
    objects.delete('p1/images/big');
    await list('images');
    await thumbnailsSettled();
    expect(fileDoc('big').thumbnailFailure).toMatchObject({ error: expect.stringContaining('404') });
    objects.set('p1/images/big', image);
    await list('images');
    await thumbnailsSettled();
    expect(fileDoc('big').thumbnail).toBeUndefined();
  });

  it('goes with its file', async () => {
    await list('images');
    await thumbnailsSettled();
    expect(objects.has('p1/images/big.thumb.webp')).toBe(true);
    await fetch(`${base}/projects/p1/storage/files/big`, { method: 'DELETE', headers: { 'x-test-user': 'eli' } });
    expect(objects.has('p1/images/big.thumb.webp')).toBe(false);
  });

  it("isn't made when the host turns StreamBy's processing off", async () => {
    const { server: other, base: at } = await serve(makeApp({ processing: false }));
    await list('images', at);
    await thumbnailsSettled();
    expect(fileDoc('big').thumbnail).toBeUndefined();
    other.close();
  });

  it("signs a list's URLs for the hour, the same each time", async () => {
    const [a, b] = [await list('images'), await list('images')];
    expect(a[0].url).toBe(b[0].url);
    expect(a[0].url).toContain('?stable');
  });
});

describe("S3's URLs signed for the hour", () => {
  const s3 = new S3Adapter({ bucket: 'b', region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' } as any);

  it('are the same within the hour, kept by the browser, and valid as long as asked from now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:05:00Z'));
    const first = await s3.getPresignedGetUrl('p1/images/a.png', 86400, undefined, { stable: true });
    vi.setSystemTime(new Date('2026-11-09T10:55:00Z'));
    const later = await s3.getPresignedGetUrl('p1/images/a.png', 86400, undefined, { stable: true });
    expect(later).toBe(first);
    const url = new URL(first);
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261109T100000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(86400 + 3600));
    expect(url.searchParams.get('response-cache-control')).toBe('private, max-age=3600');

    vi.setSystemTime(new Date('2026-11-09T11:01:00Z'));
    expect(await s3.getPresignedGetUrl('p1/images/a.png', 86400, undefined, { stable: true })).not.toBe(first);
    // One not asked stable is signed as of now, as it always was.
    expect(new URL(await s3.getPresignedGetUrl('p1/images/a.png')).searchParams.get('X-Amz-Date')).toBe('20261109T110100Z');
    vi.useRealTimers();
  });
});
