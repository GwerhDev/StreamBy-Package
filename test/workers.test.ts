import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { FakeDb } from './fakeMongo';

// A project's files live in the NoSQL database (here in memory); projects in the models (here
// in memory too, with the list updates the worker routes make); jobs, with no main database
// connected, in the job store's memory.
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
      if (!row) return null;
      for (const [key, value] of Object.entries(data.$push ?? {})) (row[key] ??= []).push(value);
      for (const [key, cond] of Object.entries(data.$pull ?? {}) as [string, any][]) row[key] = (row[key] ?? []).filter((item: any) => item.id !== cond.id);
      if (!Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row;
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
// What names resolve to, as the tests say.
const resolved = vi.hoisted(() => new Map<string, string[]>());
vi.mock('dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('dns')>();
  return {
    ...original,
    promises: {
      ...original.promises,
      lookup: async (host: string) => (resolved.get(host) ?? []).map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
    },
  };
});

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { dispatchJob, enqueueWorkerJob } = await import('../src/services/workerJobs');
const { jobStore } = await import('../src/services/jobStore');
const { decrypt } = await import('../src/utils/encryption');

// The storage, in memory: its files by key. `put` and `get` stand for a client using a signed URL.
const objects = new Map<string, string>();
const adapter = {
  getPresignedUploadUrl: async (key: string) => `https://storage.test/put/${key}`,
  getPresignedGetUrl: async (key: string) => `https://storage.test/get/${key}`,
  copyFile: async (from: string, to: string) => { objects.set(to, objects.get(from)!); },
  deleteFile: async (key: string) => { objects.delete(key); },
};
const keyOf = (url: string) => new URL(url).pathname.replace(/^\/(put|get)\//, '');
const put = (url: string, content: string) => objects.set(keyOf(url), content);
const get = (url: string) => objects.get(keyOf(url));

// The worker: an HTTP server that takes jobs, as a worker following the contract does.
interface Received { authorization?: string; body: any }
let received: Received[] = [];
let workerAnswers = 202;
const worker = http.createServer((req, res) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    received.push({ authorization: req.headers.authorization, body: JSON.parse(data) });
    res.writeHead(workerAnswers).end();
  });
});
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/jobs`;

const KEY = 'a'.repeat(64);
const config: any = {
  storageProviders: [], adapter, databases: [{ id: 'pg', type: 'sql', main: true }], encrypt: KEY,
  workers: [{ id: 'optimizer', name: 'glTF optimizer', endpoint: workerUrl, credential: 'host-worker-secret', kinds: ['gltf-optimize'], categories: ['3d-models'] }],
  workerOptions: { sweepIntervalMs: 0, allowLocalEndpoints: true },
  canUseBuiltin: async (auth: any, _id: string, kind: string) => kind !== 'worker' || auth.userId !== 'no-builtins',
  authProvider: async (req: any) => ({
    userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer',
    // A request made with an API token that has these permissions.
    ...(req.headers['x-test-token'] ? { apiToken: { tokenId: 't1', kind: 'user', permissions: String(req.headers['x-test-token']).split(','), projectIds: '*' } } : {}),
  }),
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter(config));
const server = http.createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;

const call = async (method: string, path: string, { user = 'eli', body, token, permissions }: { user?: string; body?: object; token?: string; permissions?: string[] } = {}) => {
  const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { 'x-test-user': user }),
      ...(permissions ? { 'x-test-token': permissions.join(',') } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const BUILTIN = { source: 'builtin', id: 'optimizer' };
const process_ = (body: object = {}, user = 'eli') =>
  call('POST', '/projects/p1/jobs/process', { user, body: { assetId: 'model', worker: BUILTIN, kind: 'gltf-optimize', ...body } });
// The job the worker was sent last, once it has it.
const sentJob = async () => {
  await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
  return received[received.length - 1];
};

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  objects.clear();
  received = [];
  workerAnswers = 202;
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }, { userId: 'ada', role: 'admin', status: 'active' }],
  }];
  mongo.db.collection('storage_files').docs.push(
    { fileId: 'model', projectId: 'p1', category: '3d-models', storageKey: 'p1/3d-models/model.glb', displayName: 'hero.glb', contentType: 'model/gltf-binary' },
    { fileId: 'poster', projectId: 'p1', category: 'images', storageKey: 'p1/images/poster.png', displayName: 'poster.png', contentType: 'image/png' },
  );
  mongo.db.collection('production_shots').docs.push({ id: 's1', projectId: 'p1', name: 'SH010' });
  objects.set('p1/3d-models/model.glb', 'original glb');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a project's workers", () => {
  it('are connected with their credential encrypted, and listed with the host\'s', async () => {
    const res = await call('POST', '/projects/p1/workers', {
      body: { name: 'Own LOD', endpoint: workerUrl, credential: 'own-secret', kinds: ['lod'], categories: ['3d-models'], autoKind: 'lod' },
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('own-secret');
    const stored = store.projects[0].renderFarmConnections[0];
    expect(decrypt(stored.encryptedCredential)).toBe('own-secret');
    expect(stored.createdBy).toBe('eli');

    const list = await call('GET', '/projects/p1/workers', { user: 'vic' });
    expect(list.body.data.map((w: any) => [w.source, w.name])).toEqual([['builtin', 'glTF optimizer'], ['project', 'Own LOD']]);
    expect((await call('GET', '/projects/p1/workers', { user: 'no-builtins' })).status).toBe(403);
  });

  it('are checked: what they do, what they take, and where they are', async () => {
    const strict = { ...config, workerOptions: { sweepIntervalMs: 0 } };
    const { newWorkerConnection } = await import('../src/services/workers');
    const good = { name: 'W', endpoint: 'https://worker.example.com/jobs', kinds: ['lod'], categories: ['3d-models'] };
    expect(() => newWorkerConnection(good, 'p1', 'eli', strict)).not.toThrow();
    for (const bad of [
      { ...good, name: '' }, { ...good, kinds: [] }, { ...good, categories: ['scripts'] }, { ...good, autoKind: 'render' },
      { ...good, endpoint: 'http://worker.example.com' }, { ...good, endpoint: 'https://localhost/jobs' },
      { ...good, endpoint: 'https://10.0.0.5/jobs' }, { ...good, endpoint: 'https://169.254.169.254/latest' },
      { ...good, endpoint: 'https://user:pass@worker.example.com' }, { ...good, timeoutSeconds: 5 },
    ]) {
      expect(() => newWorkerConnection(bad, 'p1', 'eli', strict), JSON.stringify(bad)).toThrow();
    }
  });

  it("only editors connect them", async () => {
    expect((await call('POST', '/projects/p1/workers', { user: 'vic', body: { name: 'x' } })).status).toBe(403);
  });
});

describe('a job sent to a worker', () => {
  it('carries the asset, a URL to download it, and a token of its own to call back with', async () => {
    const res = await process_({ profile: { textureFormat: 'ktx2' } });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ jobType: 'process', status: 'pending', kind: 'gltf-optimize', resultMode: 'derived' });
    expect(JSON.stringify(res.body)).not.toMatch(/callbackHash/);

    const sent = await sentJob();
    expect(sent.authorization).toBe('Bearer host-worker-secret');
    expect(sent.body).toMatchObject({
      jobId: res.body.job.jobId, kind: 'gltf-optimize', profile: { textureFormat: 'ktx2' }, attempt: 1,
      asset: { id: 'model', fileName: 'hero.glb', category: '3d-models' },
      callback: { url: `${base}/worker-jobs/${res.body.job.jobId}` },
    });
    expect(get(sent.body.download.url)).toBe('original glb');
    expect(sent.body.callback.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await vi.waitFor(async () => expect((await call('GET', `/jobs/${res.body.job.jobId}`)).body.job.stage).toBe('accepted'));
  });

  it("is checked: the worker's kinds and categories, and who asks", async () => {
    expect((await process_({ kind: 'lod' })).status).toBe(400);
    expect((await process_({ assetId: 'poster' })).status).toBe(400);
    expect((await process_({ resultMode: 'replace' })).status).toBe(400);
    expect((await process_({ assetId: 'nope' })).status).toBe(404);
    expect((await process_({}, 'vic')).status).toBe(403);
    expect((await process_({}, 'no-builtins')).status).toBe(403);
    expect(received).toEqual([]);
  });
});

describe('the worker calling back', () => {
  const callback = async (jobId: string, token: string, action: string, body: object = {}) =>
    call('POST', `/worker-jobs/${jobId}/${action}`, { token, body });

  it('keeps its result as a new asset derived from the original, with its report', async () => {
    const { body } = await process_();
    const { body: { jobId, callback: cb } } = await sentJob();
    expect((await callback(jobId, cb.token, 'progress', { progress: 40, stage: 'optimizing' })).status).toBe(200);

    const upload = await callback(jobId, cb.token, 'upload-url', { fileName: 'hero.optimized.glb', contentType: 'model/gltf-binary' });
    expect(upload.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'model/gltf-binary' } });
    put(upload.body.url, 'optimized glb');
    const done = await callback(jobId, cb.token, 'complete', { report: { sizeBefore: 1000, sizeAfter: 400 } });
    expect(done.status).toBe(200);
    expect(done.body.job).toMatchObject({ jobId: body.job.jobId, status: 'completed', progress: 100, report: { sizeAfter: 400 }, result: { mode: 'derived' } });

    const derived = mongo.db.docs('storage_files').find((f: any) => f.fileId === done.body.job.result.assetId);
    expect(derived).toMatchObject({ displayName: 'hero.optimized.glb', derivedFrom: { assetId: 'model', jobId } });
    expect(objects.get(derived.storageKey)).toBe('optimized glb');
    expect(objects.get('p1/3d-models/model.glb')).toBe('original glb');
    expect(mongo.db.docs('asset_versions').find((v: any) => v.assetId === derived.fileId)).toMatchObject({ version: 1, report: { sizeAfter: 400 }, kind: 'gltf-optimize' });
  });

  it("keeps it as the asset's new version, at the asset's own key, its current one archived", async () => {
    await process_({ resultMode: 'version' });
    const { body: { jobId, callback: cb } } = await sentJob();
    const upload = await callback(jobId, cb.token, 'upload-url', { fileName: 'hero.glb', contentType: 'model/gltf-binary' });
    expect(keyOf(upload.body.url)).not.toBe('p1/3d-models/model.glb');
    put(upload.body.url, 'optimized glb');
    const done = await callback(jobId, cb.token, 'complete', { report: { ratio: 0.4 } });
    expect(done.body.job.result).toMatchObject({ assetId: 'model', mode: 'version' });
    expect(objects.get('p1/3d-models/model.glb')).toBe('optimized glb');
    expect(objects.get('p1/3d-models/model.v1.glb')).toBe('original glb');
    expect(objects.has(keyOf(upload.body.url))).toBe(false);
    const versions = mongo.db.docs('asset_versions').filter((v: any) => v.assetId === 'model').map((v: any) => [v.version, v.storageKey, v.report ?? null]);
    expect(versions).toEqual([[1, 'p1/3d-models/model.v1.glb', null], [2, 'p1/3d-models/model.glb', { ratio: 0.4 }]]);
  });

  it('is turned down without its token, with another, or once the job is done', async () => {
    const { body: { job } } = await process_();
    const { body: { callback: cb } } = await sentJob();
    expect((await call('POST', `/worker-jobs/${job.jobId}/progress`, { body: { progress: 5 } })).status).toBe(401);
    expect((await callback(job.jobId, 'not-the-token', 'progress', { progress: 5 })).status).toBe(401);
    expect((await callback(job.jobId, cb.token, 'complete')).status).toBe(409); // nothing uploaded yet

    put((await callback(job.jobId, cb.token, 'upload-url', { fileName: 'a.glb', contentType: 'model/gltf-binary' })).body.url, 'x');
    expect((await callback(job.jobId, cb.token, 'complete')).status).toBe(200);
    expect((await callback(job.jobId, cb.token, 'complete')).status).toBe(401);
  });

  it("refuses a result that isn't of the asset's category", async () => {
    await process_();
    const { body: { jobId, callback: cb } } = await sentJob();
    expect((await callback(jobId, cb.token, 'upload-url', { fileName: 'notes.txt', contentType: 'text/plain' })).status).toBe(400);
  });

  it('fails the job with its error, discarding what it uploaded; and it can be retried', async () => {
    const { body: { job } } = await process_();
    const { body: { callback: cb } } = await sentJob();
    const upload = await callback(job.jobId, cb.token, 'upload-url', { fileName: 'a.glb', contentType: 'model/gltf-binary' });
    put(upload.body.url, 'half');
    const failed = await callback(job.jobId, cb.token, 'fail', { error: 'Draco decoder crashed' });
    expect(failed.body.job).toMatchObject({ status: 'failed', error: 'Draco decoder crashed' });
    expect(objects.has(keyOf(upload.body.url))).toBe(false);

    received = [];
    const retried = await call('POST', `/projects/p1/jobs/${job.jobId}/retry`);
    expect(retried.status).toBe(202);
    const again = await sentJob();
    expect(again.body.jobId).toBe(job.jobId);
    expect(again.body.callback.token).not.toBe(cb.token);
    expect((await callback(job.jobId, cb.token, 'progress', { progress: 1 })).status).toBe(401);
  });
});

describe('sending again', () => {
  const makeDue = (jobId: string) => jobStore().update(jobId, { nextAttemptAt: new Date(Date.now() - 1000) });

  it("a job its worker turns down is sent again later, and fails after its last attempt", async () => {
    workerAnswers = 503;
    const { body: { job } } = await process_();
    await sentJob();
    await vi.waitFor(async () => expect(await jobStore().get(job.jobId)).toMatchObject({ status: 'pending', stage: 'retrying', attempts: 1 }));
    const pending = await jobStore().get(job.jobId);
    expect(new Date(pending!.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());
    // What the endpoint answered stays in the server's log, not in the job.
    expect(pending!.error).toBe('The worker refused the job');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/answered 503/);

    for (const attempt of [2, 3]) {
      await makeDue(job.jobId);
      await dispatchJob(job.jobId, config);
      expect(received).toHaveLength(attempt);
    }
    expect(await jobStore().get(job.jobId)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it("a job its worker doesn't finish in time is sent again", async () => {
    const { body: { job } } = await process_();
    await sentJob();
    await vi.waitFor(async () => expect((await jobStore().get(job.jobId))!.stage).toBe('accepted'));
    await jobStore().update(job.jobId, { leaseUntil: new Date(Date.now() - 1000) });
    await dispatchJob(job.jobId, config); // its time is up: back in line
    expect(await jobStore().get(job.jobId)).toMatchObject({ status: 'pending', error: "The worker didn't finish in time" });
    await makeDue(job.jobId);
    await dispatchJob(job.jobId, config);
    expect(received.map(r => r.body.attempt)).toEqual([1, 2]);
  });

  it('only once, however many instances try', async () => {
    workerAnswers = 202;
    const { body: { job } } = await process_();
    await sentJob();
    await Promise.all([dispatchJob(job.jobId, config), dispatchJob(job.jobId, config)]);
    expect(received).toHaveLength(1);
  });
});

it("a project's worker stops being used once whoever connected it leaves the project", async () => {
  await call('POST', '/projects/p1/workers', { body: { name: 'Own', endpoint: workerUrl, kinds: ['lod'], categories: ['3d-models'] } });
  const own = { source: 'project', id: store.projects[0].renderFarmConnections[0].id };
  store.projects[0].members = store.projects[0].members.filter((m: any) => m.userId !== 'eli');
  const res = await call('POST', '/projects/p1/jobs/process', { user: 'ada', body: { assetId: 'model', worker: own, kind: 'lod' } });
  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/no longer in the project/);
});

it("marking a deliverable starts the workers set to process its kind of asset by themselves", async () => {
  await call('POST', '/projects/p1/workers', { body: { name: 'Auto LOD', endpoint: workerUrl, kinds: ['lod'], categories: ['3d-models'], autoKind: 'lod' } });
  const res = await call('POST', '/projects/p1/deliverables', { body: { assetId: 'model', shotId: 's1' } });
  expect(res.status).toBe(201);
  expect(res.body.jobs).toEqual([expect.objectContaining({ kind: 'lod', worker: expect.objectContaining({ name: 'Auto LOD' }) })]);
  await sentJob();
  // An image isn't its kind: nothing starts.
  const poster = await call('POST', '/projects/p1/deliverables', { body: { assetId: 'poster', shotId: 's1' } });
  expect(poster.body.jobs).toEqual([]);
});

it("lists a project's jobs, newest first, of an asset if asked, without their tokens", async () => {
  const { body: { job } } = await process_();
  await sentJob();
  const list = await call('GET', '/projects/p1/jobs?assetId=model', { user: 'vic' });
  expect(list.body.data[0].jobId).toBe(job.jobId);
  expect(list.body.data.every((j: any) => j.assetId === 'model')).toBe(true);
  expect(JSON.stringify(list.body)).not.toMatch(/callbackHash|callbackBase/);
  expect((await call('GET', '/projects/p1/jobs?assetId=poster')).body.data).toEqual([]);
});

it("deleting a project deletes its jobs, and no other project's", async () => {
  const { jobStore } = await import('../src/services/jobStore');
  await process_();
  await sentJob();
  await jobStore().insert({ jobId: 'elsewhere', jobType: 'ingest', userId: 'x', projectId: 'p2', status: 'completed', stage: 'complete', progress: 100, payload: {}, createdAt: new Date(), updatedAt: new Date() });
  expect((await call('DELETE', '/projects/p1', { user: 'ada' })).status).toBe(200);
  expect(await jobStore().list({ projectId: 'p1' })).toEqual([]);
  expect(await jobStore().get('elsewhere')).not.toBeNull();
});

describe("a project's worker at a private address", () => {
  const strict = { ...config, workerOptions: { sweepIntervalMs: 0 } };
  const pendingJobFor = async (endpoint: string) => {
    store.projects[0].renderFarmConnections = [{ id: 'w-dns', projectId: 'p1', name: 'Looks public', provider: 'streamby-worker', apiUrl: endpoint, kinds: ['lod'], categories: ['3d-models'], createdBy: 'eli', createdAt: new Date() }];
    const jobId = `dns-${Math.random()}`;
    await jobStore().insert({
      jobId, jobType: 'process', userId: 'eli', projectId: 'p1', assetId: 'model', status: 'pending', stage: 'queued', progress: 0,
      payload: { callbackBase: base }, worker: { source: 'project', id: 'w-dns', name: 'Looks public' }, kind: 'lod', resultMode: 'derived',
      attempts: 0, maxAttempts: 3, nextAttemptAt: new Date(Date.now() - 1000), createdAt: new Date(), updatedAt: new Date(),
    });
    return jobId;
  };

  it('is never sent a job when its name resolves to one: the job fails for good', async () => {
    resolved.set('internal.example.invalid', ['10.0.0.5']);
    const jobId = await pendingJobFor('https://internal.example.invalid/jobs');
    await dispatchJob(jobId, strict);
    expect(await jobStore().get(jobId)).toMatchObject({ status: 'failed', error: "The worker's endpoint resolves to a local or private address" });
    expect(received).toEqual([]);
  });

  it('is checked when connected, too', async () => {
    const { assertPublicEndpoint } = await import('../src/services/workers');
    resolved.set('fly.example.invalid', ['fdaa:0:1::3']);
    resolved.set('public.example.invalid', ['93.184.216.34', '2606:2800:220:1::1']);
    await expect(assertPublicEndpoint('https://fly.example.invalid/jobs', strict)).rejects.toThrow(/private address/);
    await expect(assertPublicEndpoint('https://public.example.invalid/jobs', strict)).resolves.toBeUndefined();
  });
});

describe('a private address', () => {
  it('is any local, private, shared, benchmarking, multicast or reserved one, v4 or v6', async () => {
    const { isPrivateIp } = await import('../src/utils/privateAddress');
    for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fdaa:0:1::3', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '198.20.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

it("a job is sent as whoever asked for it, with the role they had", async () => {
  // A host that keeps its worker for admins.
  const adminsOnly = { ...config, canUseBuiltin: async (auth: any, _id: string, kind: string) => kind !== 'worker' || auth.role === 'admin' };
  const job = await enqueueWorkerJob(store.projects[0], { assetId: 'model', worker: BUILTIN, kind: 'gltf-optimize' },
    { userId: 'eli', username: 'eli', role: 'admin' }, adminsOnly, base);
  await sentJob();
  expect(await jobStore().get(job.jobId)).toMatchObject({ status: 'processing' });
});

describe('marking a deliverable with an API token', () => {
  const AUTO = { name: 'Auto LOD', endpoint: workerUrl, kinds: ['lod'], categories: ['3d-models'], autoKind: 'lod' };

  it("starts no automatic job if the token can't run jobs", async () => {
    await call('POST', '/projects/p1/workers', { body: AUTO });
    const res = await call('POST', '/projects/p1/deliverables', { permissions: ['assets:write'], body: { assetId: 'model', shotId: 's1' } });
    expect(res.status).toBe(201);
    expect(res.body.jobs).toEqual([]);
  });

  it('starts them if it can', async () => {
    await call('POST', '/projects/p1/workers', { body: AUTO });
    const res = await call('POST', '/projects/p1/deliverables', { permissions: ['assets:write', 'jobs:run'], body: { assetId: 'model', shotId: 's1' } });
    expect(res.body.jobs).toHaveLength(1);
  });
});
