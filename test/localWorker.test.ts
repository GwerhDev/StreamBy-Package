import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { Document as GltfDocument, NodeIO } from '@gltf-transform/core';
import { FakeDb } from './fakeMongo';

// StreamBy's own worker, end to end: a job asked for (POST /jobs/process, worker 'streamby'),
// run on this server with FFmpeg and glTF-Transform, its result kept as a new asset (or a
// transcript as a project document). The storage is a server here, its signed URLs real URLs.
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
const { jobStore } = await import('../src/services/jobStore');
const { documentStore } = await import('../src/services/documents');
const { transcribe, checkSpeechCredential } = await import('../src/services/speechProviders');

// ── The storage: files by key, PUT and GET by URL ──
const objects = new Map<string, Buffer>();
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
  getPresignedGetUrl: async (key: string) => `${storageUrl}/${encodeURIComponent(key)}`,
  copyFile: async (from: string, to: string) => { objects.set(to, objects.get(from)!); },
  deleteFile: async (key: string) => { objects.delete(key); },
};

// ── A speech service with OpenAI's transcription API ──
const heard: { authorization?: string; body: string }[] = [];
const speech = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    heard.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
    if (req.url !== '/v1/audio/transcriptions') return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: ' Hello from the forest. ', language: 'english' }));
  });
});
await new Promise<void>(resolve => speech.listen(0, '127.0.0.1', resolve));
const speechUrl = `http://127.0.0.1:${(speech.address() as AddressInfo).port}/v1`;

const KEY = 'a'.repeat(64);
const makeApp = (extra: object = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/streamby', createStreamByRouter({
    storageProviders: [], adapter: adapter as any, databases: [{ id: 'pg', type: 'sql', main: true }], encrypt: KEY,
    workerOptions: { sweepIntervalMs: 0, allowLocalEndpoints: true },
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
const call = async (method: string, path: string, body?: object, user = 'eli', at = base) => {
  const res = await fetch(`${at}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const STREAMBY = { source: 'builtin', id: 'streamby' };
const process_ = (assetId: string, kind: string, profile: object = {}, extra: object = {}, at = base) =>
  call('POST', '/projects/p1/jobs/process', { assetId, worker: STREAMBY, kind, profile, ...extra }, 'eli', at);
const ended = async (jobId: string) => {
  await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await jobStore().get(jobId))?.status), { timeout: 30_000, interval: 100 });
  return (await jobStore().get(jobId))!;
};
const fileOf = (fileId: string) => mongo.db.docs('storage_files').find((f: any) => f.fileId === fileId);

// ── What it's given: a video with sound, an image, a model ──
const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'streamby-fixtures-'));
const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let video: Buffer, image: Buffer, model: Buffer;

async function gridModel(): Promise<Buffer> {
  // A plane of 20 by 20 quads: 800 triangles, to be simplified.
  const n = 20;
  const doc = new GltfDocument();
  const buffer = doc.createBuffer();
  const positions: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x / n, y / n, 0);
  const indices: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * (n + 1) + x;
    indices.push(i, i + 1, i + n + 1, i + 1, i + n + 2, i + n + 1);
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer));
  const mesh = doc.createMesh('Plane').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('Plane').setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

beforeAll(async () => {
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-pix_fmt', 'yuv420p', '-shortest', path.join(fixtures, 'clip.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x240', '-frames:v', '1', path.join(fixtures, 'still.png'));
  video = await fs.readFile(path.join(fixtures, 'clip.mp4'));
  image = await fs.readFile(path.join(fixtures, 'still.png'));
  model = await gridModel();
}, 60_000);
afterAll(async () => {
  await fs.rm(fixtures, { recursive: true, force: true });
  server.close(); storage.close(); speech.close();
});

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  objects.clear();
  heard.length = 0;
  store.projects = [{ _id: 'p1', id: 'p1', name: 'World of Gwerh', dbType: 'sql', members: [
    { userId: 'eli', role: 'editor', status: 'active' }, { userId: 'ada', role: 'admin', status: 'active' }] }];
  const file = (fileId: string, category: string, displayName: string, contentType: string, bytes: Buffer) => {
    const storageKey = `p1/${category}/${fileId}`;
    objects.set(storageKey, bytes);
    mongo.db.collection('storage_files').docs.push({ fileId, projectId: 'p1', category, storageKey, displayName, contentType });
  };
  file('clip', 'videos', 'clip.mp4', 'video/mp4', video);
  file('still', 'images', 'still.png', 'image/png', image);
  file('model', '3d-models', 'rock.glb', 'model/gltf-binary', model);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe("StreamBy's own worker", () => {
  it('is listed with what it does', async () => {
    const list = await call('GET', '/projects/p1/workers');
    expect(list.body.data[0]).toMatchObject({ source: 'builtin', id: 'streamby', name: 'StreamBy', kinds: ['thumbnail', 'transcode', 'lod', 'gltf-convert', 'transcribe'] });
  });

  it("makes a video's thumbnail: a new image asset, derived from it", async () => {
    const asked = await process_('clip', 'thumbnail', { width: 64, timecode: '00:00:01' });
    expect(asked.status).toBe(202);
    const job = await ended(asked.body.job.jobId);
    expect(job).toMatchObject({ status: 'completed', report: { width: 64, timecode: '00:00:01' }, result: { mode: 'derived' } });
    const thumb = fileOf(job.result!.assetId!);
    expect(thumb).toMatchObject({ category: 'images', displayName: 'clip-thumbnail.jpg', contentType: 'image/jpeg', derivedFrom: { assetId: 'clip', kind: 'thumbnail' } });
    const bytes = objects.get(thumb.storageKey)!;
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("makes an image's smaller copy, in the format asked for", async () => {
    const job = await ended((await process_('still', 'thumbnail', { width: 100, format: 'webp' })).body.job.jobId);
    expect(job.status).toBe('completed');
    expect(fileOf(job.result!.assetId!)).toMatchObject({ category: 'images', displayName: 'still-thumbnail.webp', contentType: 'image/webp' });
  });

  it("doesn't make a video's thumbnail its new version: it's an image", async () => {
    const job = await ended((await process_('clip', 'thumbnail', {}, { resultMode: 'version' })).body.job.jobId);
    expect(job).toMatchObject({ status: 'failed', error: "A result that isn't of the asset's category (videos) is a new asset: ask for a derived result" });
  });

  it('transcodes a video: smaller, or its sound only', async () => {
    const small = await ended((await process_('clip', 'transcode', { format: 'webm', width: 80 })).body.job.jobId);
    expect(small).toMatchObject({ status: 'completed', report: { format: 'webm', width: 80 } });
    expect(fileOf(small.result!.assetId!)).toMatchObject({ category: 'videos', displayName: 'clip.webm', contentType: 'video/webm' });
    const sound = await ended((await process_('clip', 'transcode', { format: 'mp3', audioBitrate: '64k' })).body.job.jobId);
    expect(fileOf(sound.result!.assetId!)).toMatchObject({ category: 'audios', displayName: 'clip.mp3', contentType: 'audio/mpeg' });
  });

  it("makes a model's LOD: fewer triangles, as a new .glb", async () => {
    const job = await ended((await process_('model', 'lod', { ratio: 0.25 })).body.job.jobId);
    expect(job.error ?? null).toBeNull();
    expect(job.status).toBe('completed');
    const report = job.report as any;
    expect(report.triangles.before).toBe(800);
    expect(report.triangles.after).toBeLessThan(800);
    const lod = fileOf(job.result!.assetId!);
    expect(lod).toMatchObject({ category: '3d-models', displayName: 'rock-lod25.glb', contentType: 'model/gltf-binary' });
    const read = await new NodeIO().readBinary(new Uint8Array(objects.get(lod.storageKey)!));
    expect(read.getRoot().listMeshes()).toHaveLength(1);
  });

  it('converts a .glb to a .gltf with its buffers inside it, and back', async () => {
    const job = await ended((await process_('model', 'gltf-convert', { to: 'gltf' })).body.job.jobId);
    const gltf = fileOf(job.result!.assetId!);
    expect(gltf).toMatchObject({ displayName: 'rock.gltf', contentType: 'model/gltf+json' });
    const json = JSON.parse(objects.get(gltf.storageKey)!.toString('utf8'));
    expect(json.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
    const back = await ended((await process_(job.result!.assetId!, 'gltf-convert', { to: 'glb' })).body.job.jobId);
    expect(fileOf(back.result!.assetId!)).toMatchObject({ displayName: 'rock.glb', contentType: 'model/gltf-binary' });
  });

  it('refuses, saying why, what it takes and what it is asked', async () => {
    expect((await ended((await process_('still', 'lod')).body.job.jobId)).error).toBe('It takes 3d-models, not images');
    expect((await ended((await process_('model', 'lod', { ratio: 2 })).body.job.jobId)).error).toBe('ratio must be between 0 and 1 (the share of triangles kept)');
    expect((await ended((await process_('clip', 'transcode', { format: 'avi' })).body.job.jobId)).error).toMatch(/^format must be one of/);
    expect((await process_('clip', 'upscale')).status).toBe(400);
  });

  it("says when the server has no FFmpeg", async () => {
    const { server: other, base: at } = await serve(makeApp({ processing: { ffmpegPath: '/nonexistent/ffmpeg' } }));
    const job = await ended((await process_('clip', 'thumbnail', {}, {}, at)).body.job.jobId);
    expect(job).toMatchObject({ status: 'failed', error: "FFmpeg isn't available on this server" });
    other.close();
  });

  it('is gone when the host turns it off', async () => {
    const { server: other, base: at } = await serve(makeApp({ processing: false }));
    expect((await call('GET', '/projects/p1/workers', undefined, 'eli', at)).body.data).toEqual([]);
    expect((await process_('clip', 'thumbnail', {}, {}, at)).status).toBe(404);
    other.close();
  });
});

describe('transcription', () => {
  const connect = async (user = 'eli') => (await call('POST', '/user/integrations', {
    kind: 'service', provider: 'openai-compatible', name: 'Whisper here', credential: { baseUrl: speechUrl, apiKey: 'sk-local', model: 'whisper-large' },
  }, user)).body.data;

  it("makes a video's transcript, a project document, with the requester's own speech provider", async () => {
    const integration = await connect();
    expect(JSON.stringify(integration)).not.toContain('sk-local');
    const job = await ended((await process_('clip', 'transcribe', { integrationId: integration.id, language: 'en' })).body.job.jobId);
    expect(job.error ?? null).toBeNull();
    expect(job).toMatchObject({ status: 'completed', result: { mode: 'document' }, report: { provider: 'openai-compatible', language: 'english', characters: 22 } });
    const document = await documentStore().get('p1', job.result!.documentId!);
    expect(document).toMatchObject({ title: 'Transcript of clip.mp4', content: 'Hello from the forest.', kind: 'document' });
    // Its audio only, with its key, model and language.
    expect(heard[0].authorization).toBe('Bearer sk-local');
    expect(heard[0].body).toContain('name="model"\r\n\r\nwhisper-large');
    expect(heard[0].body).toContain('name="language"\r\n\r\nen');
    expect(heard[0].body).toContain('filename="audio.mp3"');
  });

  it("never with another member's integration, nor without one", async () => {
    const ada = await connect('ada');
    expect((await ended((await process_('clip', 'transcribe', { integrationId: ada.id })).body.job.jobId)).error).toBe('integrationId must be one of your speech provider integrations');
    expect((await ended((await process_('clip', 'transcribe')).body.job.jobId)).error).toMatch(/^integrationId is required/);
    expect(heard).toEqual([]);
  });

  it("isn't a project's connection", async () => {
    const integration = await connect();
    const res = await call('POST', '/projects/p1/integrations', { integrationId: integration.id });
    expect(res.status).toBe(400);
  });

  it('takes an OpenAI-compatible service only at a public address, unless the host allows local ones', () => {
    expect(() => checkSpeechCredential('openai-compatible', { baseUrl: 'http://127.0.0.1:9000/v1' }, {} as any)).toThrow();
    expect(() => checkSpeechCredential('openai-compatible', { baseUrl: 'https://192.168.1.10/v1' }, {} as any)).toThrow();
    expect(checkSpeechCredential('openai-compatible', { baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'k' }, {} as any))
      .toEqual({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', model: undefined });
    expect(() => checkSpeechCredential('deepgram', '  ', {} as any)).toThrow('credential must be the API key');
  });

  it('asks Deepgram and AssemblyAI as each one takes it', async () => {
    const audio = { bytes: Buffer.from('mp3'), fileName: 'a.mp3', contentType: 'audio/mpeg' };
    const calls: { url: string; init: any }[] = [];
    const answers = [
      { results: { channels: [{ alternatives: [{ transcript: 'From Deepgram' }], detected_language: 'es' }] } },
      { upload_url: 'https://cdn.assemblyai.com/u/1' }, { id: 't1' }, { status: 'processing' }, { status: 'completed', text: 'From AssemblyAI', language_code: 'en' },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    });
    expect(await transcribe('deepgram', 'dg-key', audio, {}, {} as any)).toEqual({ text: 'From Deepgram', language: 'es' });
    expect(calls[0].url).toBe('https://api.deepgram.com/v1/listen?smart_format=true&detect_language=true');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Token dg-key', 'Content-Type': 'audio/mpeg' });

    expect(await transcribe('assemblyai', 'aa-key', audio, { language: 'en', pollMs: 1 }, {} as any)).toEqual({ text: 'From AssemblyAI', language: 'en' });
    expect(calls.slice(1).map(c => c.url)).toEqual([
      'https://api.assemblyai.com/v2/upload', 'https://api.assemblyai.com/v2/transcript',
      'https://api.assemblyai.com/v2/transcript/t1', 'https://api.assemblyai.com/v2/transcript/t1',
    ]);
    expect(JSON.parse(calls[2].init.body)).toEqual({ audio_url: 'https://cdn.assemblyai.com/u/1', language_code: 'en' });
  });
});
