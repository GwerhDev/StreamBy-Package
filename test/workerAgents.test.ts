import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { FakeDb } from './fakeMongo';

// Worker agents: a machine with no public URL that asks StreamBy for jobs (a long poll with its
// own token), shared by its owner with a project or a team. Projects, agents and their shares
// live in the models (here in memory); files and teams in the NoSQL database; jobs in the job
// store's memory.
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
      if (row) Object.assign(row, data);
      return row ?? null;
    },
    delete: async (filter: any) => {
      const before = rows().length;
      store[name] = rows().filter(r => !matchesRecord(r, filter));
      return before - store[name].length;
    },
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
const { dispatchJob } = await import('../src/services/workerJobs');
const { jobStore } = await import('../src/services/jobStore');

const objects = new Map<string, string>();
const adapter = {
  getPresignedUploadUrl: async (key: string) => `https://storage.test/put/${key}`,
  getPresignedGetUrl: async (key: string) => `https://storage.test/get/${key}`,
  copyFile: async (from: string, to: string) => { objects.set(to, objects.get(from)!); },
  deleteFile: async (key: string) => { objects.delete(key); },
};
const keyOf = (url: string) => new URL(url).pathname.replace(/^\/(put|get)\//, '');

const config: any = {
  storageProviders: [], adapter, databases: [{ id: 'pg', type: 'sql', main: true }],
  workerOptions: { sweepIntervalMs: 0, agentPollWaitMs: 300 },
  authProvider: async (req: any) => ({
    userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer',
    ...(req.headers['x-test-token'] ? { apiToken: { tokenId: 't1', kind: 'user', permissions: ['jobs:run', 'assets:read'], projectIds: '*' } } : {}),
  }),
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter(config));
const server = http.createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
afterAll(() => server.close());

const call = async (method: string, path: string, { user = 'ada', body, token, apiToken }: { user?: string; body?: object; token?: string; apiToken?: boolean } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { 'x-test-user': user }),
      ...(apiToken ? { 'x-test-token': '1' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// Ada's machine: registered, and what it says it can do when it asks.
const CAN = { kinds: ['gltf-optimize'], categories: ['3d-models'] };
const register = async (name = 'Ada workstation') => (await call('POST', '/user/worker-agents', { body: { name } })).body;
// Registered, connected once (it said what it does) and shared with the project.
const ready = async () => {
  const registered = await register();
  await poll(registered.token);
  await share(registered.data.id);
  return registered;
};
const poll = (token: string, declared: object = CAN) => call('POST', '/worker-agent/jobs/next', { token, body: declared });
const share = (agentId: string, body: object = { projectId: 'p1' }, user = 'ada') => call('POST', `/user/worker-agents/${agentId}/shares`, { user, body });
const process_ = (agentId: string, user = 'eli', body: object = {}) =>
  call('POST', '/projects/p1/jobs/process', { user, body: { assetId: 'model', worker: { source: 'agent', id: agentId }, kind: 'gltf-optimize', ...body } });
const workersOf = async (user = 'eli') => (await call('GET', '/projects/p1/workers', { user })).body.data;
const job = (jobId: string) => jobStore().get(jobId);

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  objects.clear();
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'World of Gwerh', dbType: 'sql',
    members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'leo', role: 'editor', status: 'active' },
    ],
  }, { _id: 'p2', id: 'p2', name: 'Not Ada\'s', dbType: 'sql', members: [{ userId: 'eli', role: 'admin', status: 'active' }] }];
  mongo.db.collection('storage_files').docs.push(
    { fileId: 'model', projectId: 'p1', category: '3d-models', storageKey: 'p1/3d-models/model.glb', displayName: 'hero.glb', contentType: 'model/gltf-binary' },
    { fileId: 'poster', projectId: 'p1', category: 'images', storageKey: 'p1/images/poster.png', displayName: 'poster.png', contentType: 'image/png' },
  );
  mongo.db.collection('project_teams').docs.push({ id: 'lighting', projectId: 'p1', name: 'Lighting', memberIds: ['eli'] });
  objects.set('p1/3d-models/model.glb', 'original glb');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('registering an agent', () => {
  it('gives its token once; its owner lists it, never with its token, offline until it asks', async () => {
    const { token, data } = await register();
    expect(token).toMatch(/^sba_[A-Za-z0-9_-]{43}$/);
    expect(data).toMatchObject({ name: 'Ada workstation', online: false, kinds: [], shares: [] });
    const listed = (await call('GET', '/user/worker-agents')).body.data;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toMatch(/hash/);
    expect((await call('GET', '/user/worker-agents', { user: 'eli' })).body.data).toEqual([]);
  });

  it('is done with a session only: not with an API token', async () => {
    expect((await call('POST', '/user/worker-agents', { body: { name: 'x' }, apiToken: true })).status).toBe(403);
    expect((await call('GET', '/user/worker-agents', { apiToken: true })).status).toBe(403);
  });

  it("its token only asks for jobs: it's no session", async () => {
    const { token } = await register();
    expect((await call('GET', '/user/worker-agents', { token })).status).toBe(401);
    expect((await call('GET', '/projects/p1/workers', { token })).status).toBe(401);
  });
});

describe('an agent asking for jobs', () => {
  it('is online once it asks, with what it declared; with no job, it is told so', async () => {
    const { token } = await register();
    expect((await poll(token)).status).toBe(204);
    expect((await call('GET', '/user/worker-agents')).body.data[0]).toMatchObject({ online: true, kinds: ['gltf-optimize'], categories: ['3d-models'] });
    expect((await poll('sba_not-a-token')).status).toBe(401);
    expect((await poll(token, { kinds: 'all' })).status).toBe(400);
  });

  it("is in no project's workers until its owner shares it, and then for its editors, with its state", async () => {
    const { token, data: agent } = await register();
    // Not connected yet: it can't be asked anything.
    await share(agent.id);
    expect((await process_(agent.id)).body.message).toBe("Ada workstation hasn't said yet what it does: start it, so it connects");
    await call('DELETE', `/user/worker-agents/${agent.id}/shares/${store.worker_agent_shares[0].id}`);
    await poll(token);
    expect(await workersOf()).toEqual([]);
    expect((await process_(agent.id)).status).toBe(404);
    expect((await share(agent.id)).status).toBe(201);
    expect(await workersOf()).toEqual([expect.objectContaining({ source: 'agent', id: agent.id, name: 'Ada workstation', online: true, kinds: ['gltf-optimize'] })]);
    // Only where its owner is a member; only its owner shares it.
    expect((await share(agent.id, { projectId: 'p2' })).status).toBe(403);
    expect((await share(agent.id, { projectId: 'p1' }, 'eli')).status).toBe(404);
  });

  it("takes a job of a project it's shared with, and does it through the worker's contract", async () => {
    const { token, data: agent } = await ready();
    const asked = await process_(agent.id, 'eli', { profile: { textureFormat: 'ktx2' } });
    expect(asked.status).toBe(202);
    // Not sent anywhere: it waits for its agent.
    expect((await job(asked.body.job.jobId))).toMatchObject({ status: 'pending', worker: { source: 'agent', id: agent.id } });

    const taken = await poll(token);
    expect(taken.status).toBe(200);
    expect(taken.body.job).toMatchObject({
      jobId: asked.body.job.jobId, kind: 'gltf-optimize', profile: { textureFormat: 'ktx2' }, attempt: 1,
      asset: { id: 'model', fileName: 'hero.glb', category: '3d-models' },
      callback: { url: `${base}/worker-jobs/${asked.body.job.jobId}` },
    });
    expect(objects.get(keyOf(taken.body.job.download.url))).toBe('original glb');

    const { url, token: callbackToken } = taken.body.job.callback;
    const callback = (action: string, body: object = {}) => fetch(`${url}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${callbackToken}` }, body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: await r.json() }));
    const upload = await callback('upload-url', { fileName: 'hero.optimized.glb', contentType: 'model/gltf-binary' });
    objects.set(keyOf(upload.body.url), 'optimized glb');
    const done = await callback('complete', { report: { sizeAfter: 400 } });
    expect(done.body.job).toMatchObject({ status: 'completed', result: { mode: 'derived' } });
    expect(mongo.db.docs('storage_files').find((f: any) => f.fileId === done.body.job.result.assetId)).toMatchObject({ derivedFrom: { assetId: 'model' } });
    // Nothing else for it.
    expect((await poll(token)).status).toBe(204);
  });

  it('waiting, gets a job as soon as one is asked for', async () => {
    config.workerOptions.agentPollWaitMs = 5_000;
    try {
      const { token, data: agent } = await register();
      await share(agent.id);
      const started = Date.now();
      const waiting = poll(token);
      await new Promise(resolve => setTimeout(resolve, 100));
      await process_(agent.id);
      expect((await waiting).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      config.workerOptions.agentPollWaitMs = 300;
    }
  });

  it("isn't handed a job of a kind, or an asset of a category, it doesn't declare now", async () => {
    const { token, data: agent } = await ready();
    const asked = await process_(agent.id);
    expect((await poll(token, { kinds: ['render'], categories: ['3d-models'] })).status).toBe(204);
    expect((await poll(token, { kinds: ['gltf-optimize'], categories: ['images'] })).status).toBe(204);
    expect(await job(asked.body.job.jobId)).toMatchObject({ status: 'pending' });
    // It's offered for what it declared last; a job of a kind it never declared isn't asked.
    expect((await process_(agent.id, 'eli', { kind: 'lod' })).status).toBe(400);
    expect((await poll(token)).status).toBe(200);
  });
});

describe('who an agent works for', () => {
  it("only a team's members (and its owner), when it's shared with a team", async () => {
    const { token, data: agent } = await register();
    await poll(token);
    expect((await share(agent.id, { projectId: 'p1', teamId: 'lighting' })).status).toBe(201);
    expect((await workersOf('eli')).map((w: any) => w.id)).toEqual([agent.id]);
    expect(await workersOf('leo')).toEqual([]);
    expect((await process_(agent.id, 'leo')).status).toBe(403);
    expect((await process_(agent.id, 'ada')).status).toBe(202);
    expect((await share(agent.id, { projectId: 'p1', teamId: 'not-a-team' })).status).toBe(400);
    // Shared again with the whole project: one share, changed.
    await share(agent.id);
    expect((await call('GET', '/user/worker-agents')).body.data[0].shares).toEqual([expect.objectContaining({ projectId: 'p1', projectName: 'World of Gwerh', teamId: null })]);
    expect((await process_(agent.id, 'leo')).status).toBe(202);
  });

  it("nobody in a project its owner left: its jobs there fail, saying why, and none is asked", async () => {
    const { token, data: agent } = await ready();
    const asked = await process_(agent.id);
    store.projects[0].members[0].status = 'left';
    expect(await workersOf()).toEqual([]);
    expect((await process_(agent.id)).status).toBe(403);
    expect((await poll(token)).status).toBe(204);
    expect(await job(asked.body.job.jobId)).toMatchObject({ status: 'failed', error: "This agent's owner is no longer in the project" });
  });

  it('nobody once its owner stops sharing it, or revokes it: then its token stops working and its jobs fail', async () => {
    const { token, data: agent } = await register();
    await poll(token);
    const shared = (await share(agent.id)).body.data;
    expect((await call('DELETE', `/user/worker-agents/${agent.id}/shares/${shared.id}`)).status).toBe(200);
    expect(await workersOf()).toEqual([]);

    await share(agent.id);
    const asked = await process_(agent.id);
    expect((await call('DELETE', `/user/worker-agents/${agent.id}`, { user: 'eli' })).status).toBe(404);
    expect((await call('DELETE', `/user/worker-agents/${agent.id}`)).status).toBe(200);
    expect((await poll(token)).status).toBe(401);
    expect(await job(asked.body.job.jobId)).toMatchObject({ status: 'failed', error: 'Its agent was revoked' });
    expect(store.worker_agent_shares).toEqual([]);
  });
});

describe('an agent that goes away', () => {
  it("leaves its job, at the end of its lease, back in line: it takes it again when it's back", async () => {
    const { token, data: agent } = await ready();
    const asked = await process_(agent.id);
    const first = (await poll(token)).body.job;
    expect(first.attempt).toBe(1);
    // It never called back, and its time is up.
    await jobStore().update(first.jobId, { leaseUntil: new Date(Date.now() - 1000) });
    await dispatchJob(first.jobId, config);
    expect(await job(first.jobId)).toMatchObject({ status: 'pending', stage: 'retrying', error: "The worker didn't finish in time" });
    const again = (await poll(token)).body.job;
    expect(again).toMatchObject({ jobId: asked.body.job.jobId, attempt: 2 });
    expect(again.callback.token).not.toBe(first.callback.token);
  });

  it('a job no agent takes in 24 hours fails, saying so, and can be retried', async () => {
    const { token, data: agent } = await ready();
    const { jobId } = (await process_(agent.id)).body.job;
    const waiting = await job(jobId);
    expect(new Date(waiting!.waitUntil!).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    // The sweeper doesn't try to send it meanwhile.
    expect((await jobStore().due(new Date(), 20)).map(j => j.jobId)).not.toContain(jobId);

    await jobStore().update(jobId, { waitUntil: new Date(Date.now() - 1000) });
    expect((await jobStore().due(new Date(), 20)).map(j => j.jobId)).toContain(jobId);
    await dispatchJob(jobId, config);
    expect(await job(jobId)).toMatchObject({
      status: 'failed', error: "Its agent, Ada workstation, didn't take it within 24 hours: check it's running and connected, then retry",
    });
    expect((await call('POST', `/projects/p1/jobs/${jobId}/retry`, { user: 'eli' })).status).toBe(202);
    expect((await poll(token)).body.job.jobId).toBe(jobId);
  });
});
