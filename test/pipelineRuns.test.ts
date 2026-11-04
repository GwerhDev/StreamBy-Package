import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// A pipeline whose steps are done by people (a Meeting, Tasks, a Review Gate) and by workers,
// each card linked to it going through them in a run of its own. Projects live in the models
// (here in memory); documents and jobs in the main database's stores, in memory too with no main
// database connected; the rest in the NoSQL database (in memory).
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
// A worker's job: kept as it's asked for (its sending is the workers' own tests'), and ended here
// as its worker would end it.
const asked = vi.hoisted(() => [] as { assetId: string; versionId: string | null; kind: string; userId: string; jobId: string }[]);
vi.mock('../src/services/workerJobs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/workerJobs')>();
  const { createJob } = await import('../src/services/jobQueue');
  const { WorkerError } = await import('../src/services/workers');
  return {
    ...original,
    enqueueWorkerJob: async (project: any, request: any, auth: any) => {
      if (request.worker.id === 'missing') throw new WorkerError('Worker not found', 404);
      const job = await createJob('process', auth.userId, String(project._id), {}, {
        assetId: request.assetId, versionId: request.versionId, worker: request.worker, kind: request.kind,
      } as any);
      asked.push({ assetId: request.assetId, versionId: request.versionId ?? null, kind: request.kind, userId: auth.userId, jobId: job.jobId });
      return job;
    },
  };
});
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
vi.mock('../src/services/wsHub', () => ({
  initWsHub: () => {},
  emitToUser: (userId: string, event: any) => { events.push({ userId, event }); },
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');
const { documentStore } = await import('../src/services/documents');
const { updateJob } = await import('../src/services/jobQueue');
const { advanceRun } = await import('../src/services/pipelineRuns');

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
app.use('/streamby', createStreamByRouter({ storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider }));

const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
const as = (who: { user?: string; token?: string }) => {
  const auth = (r: request.Test) => (who.token ? r.set('Authorization', `Bearer ${who.token}`) : r.set('x-test-user', who.user!));
  return {
    get: (p: string) => auth(request(app).get(`/streamby${p}`)),
    post: (p: string, body?: object) => auth(request(app).post(`/streamby${p}`)).send(body ?? {}),
    put: (p: string, body?: object) => auth(request(app).put(`/streamby${p}`)).send(body ?? {}),
    patch: (p: string, body?: object) => auth(request(app).patch(`/streamby${p}`)).send(body ?? {}),
    delete: (p: string) => auth(request(app).delete(`/streamby${p}`)),
  };
};
const ada = as({ user: 'ada' });
const eli = as({ user: 'eli' });
const vic = as({ user: 'vic' });
const P = '/projects/p1';

const LOD = { source: 'builtin', id: 'blender', name: 'Blender LOD' };
const edges = (pairs: [string, string][]) => pairs.map(([source, target]) => ({ id: `${source}-${target}`, source, target }));

// World of Gwerh's chain for an asset: planned in a meeting, modeled (its tasks), reviewed,
// processed by a worker (its LODs), and delivered.
const chain = (documentId: string, extra: { reviewId?: string } = {}) => ({
  nodes: [
    { id: 'plan', type: 'meetingNode', data: { label: 'Planning', documentId, assignedTo: ['ada'] } },
    { id: 'model', type: 'tasksNode', data: { label: 'Modeling', teamIds: ['artists'] } },
    { id: 'review', type: 'reviewGateNode', data: { label: 'Art review', assignedTo: ['ada'], ...extra } },
    { id: 'lod', type: 'lodNode', data: { label: 'LODs', worker: LOD, kind: 'lod' } },
    { id: 'deliver', type: 'deliverableNode', data: { label: 'Game build' } },
  ],
  edges: edges([['plan', 'model'], ['model', 'review'], ['review', 'lod'], ['lod', 'deliver']]),
});

const newPipeline = async (body: object = {}) => (await eli.post(`${P}/pipelines`, { name: 'Props', ...body })).body.pipeline;
const setSchema = (pipelineId: string, nodeSchema: object) => eli.patch(`${P}/pipelines/${pipelineId}`, { nodeSchema });
const sequence = async () => (await eli.post(`${P}/production/sequences`, { name: 'Forest' })).body.sequence;
const card = async (body: object = {}, who = eli) => {
  const seq = await sequence();
  return (await who.post(`${P}/production/sequences/${seq.id}/shots`, { name: 'Rock', assetId: 'a1', ...body })).body.shot;
};
const runsOf = async (pipelineId: string) => (await vic.get(`${P}/pipelines/${pipelineId}/runs`)).body.runs;
const stepOf = (run: any, nodeId: string) => run.steps.find((s: any) => s.nodeId === nodeId);
const statuses = (run: any) => Object.fromEntries(run.steps.map((s: any) => [s.nodeId, s.status]));
const meetingNotes = async () => (await eli.post(`${P}/documents`, { title: 'Planning notes', content: 'Rocks' })).body.document;

// A pipeline set up as World of Gwerh's, with its document; and a card linked to it.
const gwerh = async (triggers: string[] = ['card_linked']) => {
  const notes = await meetingNotes();
  const pipeline = await newPipeline({ triggers });
  await setSchema(pipeline.id, chain(notes.id));
  return { pipeline, notes };
};

beforeEach(async () => {
  mongo.db = new FakeDb();
  events.length = 0;
  asked.length = 0;
  for (const k of Object.keys(store)) delete store[k];
  await documentStore().deleteProject('p1');
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'World of Gwerh', dbType: 'sql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }] },
  ];
  mongo.db.collection('storage_files').docs.push({ fileId: 'a1', projectId: 'p1', category: '3d-models', storageKey: 'p1/a1.glb', displayName: 'rock.glb' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a pipeline', () => {
  it('saved with no triggers starts nothing by itself, as pipelines always did', async () => {
    const notes = await meetingNotes();
    const pipeline = await newPipeline();
    expect(pipeline.triggers).toEqual([]);
    await setSchema(pipeline.id, chain(notes.id));
    await card({ pipelineId: pipeline.id });
    expect(await runsOf(pipeline.id)).toEqual([]);
    // One saved before pipelines had triggers answers none.
    mongo.db.collection('pipelines').docs.push({ id: 'old', projectId: 'p1', name: 'Old', nodeSchema: null });
    expect((await vic.get(`${P}/pipelines/old`)).body.pipeline.triggers).toEqual([]);
  });

  it('takes known triggers only', async () => {
    const pipeline = await newPipeline();
    expect((await eli.patch(`${P}/pipelines/${pipeline.id}`, { triggers: ['card_done', 'card_done'] })).body.pipeline.triggers).toEqual(['card_done']);
    expect((await eli.patch(`${P}/pipelines/${pipeline.id}`, { triggers: ['manual'] })).status).toBe(400);
    expect((await eli.post(`${P}/pipelines`, { name: 'X', triggers: 'card_done' })).status).toBe(400);
  });
});

describe("a card's run", () => {
  it('goes through the chain: the meeting, its tasks, its review, its worker, and its deliverable', async () => {
    const { pipeline, notes } = await gwerh();
    const rock = await card({ pipelineId: pipeline.id });
    let [run] = await runsOf(pipeline.id);
    expect(run).toMatchObject({ status: 'running', trigger: 'card_linked', startedBy: 'eli', card: { id: rock.id, key: rock.key }, current: ['plan'] });
    expect(stepOf(run, 'plan')).toMatchObject({ kind: 'meeting', status: 'active', reason: 'Waiting for its document to be published', completedBy: { userIds: ['ada'], teamIds: [] } });
    expect(stepOf(run, 'model')).toMatchObject({ status: 'waiting', reason: 'Waiting for: Planning', completedBy: { userIds: [], teamIds: ['artists'] } });
    expect(stepOf(run, 'lod')).toMatchObject({ kind: 'worker', completedBy: { worker: 'Blender LOD', kind: 'lod' } });

    await eli.post(`${P}/documents/${notes.id}/publish`, { version: 1 });
    [run] = await runsOf(pipeline.id);
    expect(stepOf(run, 'plan').status).toBe('done');
    expect(stepOf(run, 'model')).toMatchObject({ status: 'active', reason: 'Waiting for its card to be done' });

    // Its tasks linked to the step: the step is theirs.
    const task = (await eli.post(`${P}/production/shots/${rock.id}/tasks`, { name: 'Sculpt', stepId: 'model' })).body.task;
    expect(stepOf((await runsOf(pipeline.id))[0], 'model').reason).toBe('1 of 1 tasks open');
    await eli.patch(`${P}/production/shots/${rock.id}/tasks/${task.id}`, { status: 'done' });
    [run] = await runsOf(pipeline.id);
    expect(stepOf(run, 'model').status).toBe('done');
    expect(stepOf(run, 'review')).toMatchObject({ status: 'active', reason: 'No review session of its asset yet' });

    // Its asset's review session, approved: the worker processes the version approved, as whoever started the run.
    const session = (await eli.post(`${P}/reviews`, { assetId: 'a1', assetVersionId: 'v3' })).body.review;
    expect(stepOf((await runsOf(pipeline.id))[0], 'review').reason).toBe('Waiting for approvals: 0 of 1');
    expect(asked).toEqual([]);
    await ada.post(`${P}/reviews/${session.id}/decision`, { decision: 'approve' });
    expect(asked).toEqual([expect.objectContaining({ assetId: 'a1', versionId: 'v3', kind: 'lod', userId: 'eli' })]);
    [run] = await runsOf(pipeline.id);
    expect(stepOf(run, 'lod')).toMatchObject({ status: 'running', jobId: asked[0].jobId });
    expect(run.current).toEqual(['lod']);

    // The worker's result is what's delivered, for the card.
    await updateJob(asked[0].jobId, { status: 'completed', result: { assetId: 'a1-lod', versionId: 'v1', mode: 'derived' } } as any);
    await vi.waitFor(async () => expect((await runsOf(pipeline.id))[0].status).toBe('completed'));
    [run] = await runsOf(pipeline.id);
    expect(statuses(run)).toEqual({ plan: 'done', model: 'done', review: 'done', lod: 'done', deliver: 'done' });
    const deliverables = (await vic.get(`${P}/deliverables?shotId=${rock.id}`)).body.deliverables;
    expect(deliverables).toEqual([expect.objectContaining({ id: stepOf(run, 'deliver').deliverableId, assetId: 'a1-lod', versionId: 'v1', shotId: rock.id, createdBy: 'eli' })]);
    expect(run.current).toEqual([]);
    // Its members were told each time.
    expect(events.some(e => e.userId === 'vic' && e.event.type === 'pipelineRunEvent' && e.event.data.pipelineId === pipeline.id)).toBe(true);
  });

  it("goes by the card's status, never its column's name", async () => {
    const pipeline = await newPipeline({ triggers: ['card_linked'] });
    await setSchema(pipeline.id, { nodes: [{ id: 'model', type: 'tasksNode', data: { label: 'Modeling' } }], edges: [] });
    const misleading = (await ada.post(`${P}/production/board/columns`, { name: 'Done', status: 'in_progress' })).body.columns.find((c: any) => c.name === 'Done' && c.status === 'in_progress');
    const rock = await card({ pipelineId: pipeline.id });
    await eli.patch(`${P}/production/shots/${rock.id}`, { columnId: misleading.id });
    expect((await runsOf(pipeline.id))[0].status).toBe('running');
    await eli.patch(`${P}/production/shots/${rock.id}`, { status: 'done' });
    expect((await runsOf(pipeline.id))[0].status).toBe('completed');
  });

  it("waits on the review session it's linked to, when it's linked to one, and says a rejection", async () => {
    const notes = await meetingNotes();
    const other = (await eli.post(`${P}/reviews`, { assetId: 'a9', assetVersionId: 'v1' })).body.review;
    const pipeline = await newPipeline({ triggers: ['card_linked'] });
    await setSchema(pipeline.id, { nodes: [chain(notes.id, { reviewId: other.id }).nodes[2]], edges: [] });
    await card({ pipelineId: pipeline.id });
    await ada.post(`${P}/reviews/${other.id}/decision`, { decision: 'reject' });
    const [run] = await runsOf(pipeline.id);
    expect(stepOf(run, 'review')).toMatchObject({ status: 'active', reason: 'Its review session was rejected' });
  });

  it('fails where its job fails, with its error', async () => {
    const pipeline = await newPipeline({ triggers: ['card_linked'] });
    await setSchema(pipeline.id, { nodes: [{ id: 'lod', type: 'lodNode', data: { label: 'LODs', worker: LOD, kind: 'lod' } }, { id: 'deliver', type: 'deliverableNode', data: {} }], edges: edges([['lod', 'deliver']]) });
    await card({ pipelineId: pipeline.id });
    await updateJob(asked[0].jobId, { status: 'failed', error: 'Blender crashed' });
    await vi.waitFor(async () => expect((await runsOf(pipeline.id))[0].status).toBe('failed'));
    const [run] = await runsOf(pipeline.id);
    expect(stepOf(run, 'lod')).toMatchObject({ status: 'failed', reason: 'Blender crashed' });
    expect(stepOf(run, 'deliver').status).toBe('waiting');
  });

  it("waits for its card's asset before a worker, and a worker it can't reach fails its step", async () => {
    const pipeline = await newPipeline({ triggers: ['card_linked'] });
    await setSchema(pipeline.id, { nodes: [{ id: 'lod', type: 'lodNode', data: { label: 'LODs', worker: { source: 'builtin', id: 'missing' }, kind: 'lod' } }], edges: [] });
    const rock = await card({ pipelineId: pipeline.id, assetId: null });
    expect(stepOf((await runsOf(pipeline.id))[0], 'lod')).toMatchObject({ status: 'active', reason: 'Its card has no asset' });
    await eli.patch(`${P}/production/shots/${rock.id}`, { assetId: 'a1' });
    expect(stepOf((await runsOf(pipeline.id))[0], 'lod')).toMatchObject({ status: 'failed', reason: 'Worker not found' });
  });

  it("sends a worker's job once, of two changes moving it on at once", async () => {
    const pipeline = await newPipeline();
    await setSchema(pipeline.id, { nodes: [{ id: 'lod', type: 'lodNode', data: { label: 'LODs', worker: LOD, kind: 'lod' } }], edges: [] });
    const rock = await card({ pipelineId: pipeline.id });
    // Started with no step done yet: its first advance and another one, in the same tick.
    mongo.db.collection('pipeline_runs').docs.push({
      id: 'r1', projectId: 'p1', pipelineId: pipeline.id, shotId: rock.id, trigger: 'manual', status: 'running', steps: {},
      assetId: null, versionId: null, jobIds: [], revision: 0, requester: { userId: 'eli', username: 'eli', role: 'viewer' }, callbackBase: '', createdAt: new Date(), updatedAt: new Date(),
    });
    await Promise.all([advanceRun(store.projects[0], 'r1'), advanceRun(store.projects[0], 'r1')]);
    expect(asked).toHaveLength(1);
  });

  it("runs its workers as whoever started it, only while their role lets them run jobs", async () => {
    const pipeline = await newPipeline();
    await setSchema(pipeline.id, { nodes: [{ id: 'model', type: 'tasksNode', data: {} }, { id: 'lod', type: 'lodNode', data: { label: 'LODs', worker: LOD, kind: 'lod' } }], edges: edges([['model', 'lod']]) });
    const rock = await card({ pipelineId: pipeline.id });
    expect((await eli.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id })).status).toBe(201);
    await ada.put(`${P}/permissions`, { roles: { 'jobs:run': 'admin' } });
    // The card done by an admin: the worker still runs as the editor who started the run.
    await ada.patch(`${P}/production/shots/${rock.id}`, { status: 'done' });
    expect(asked).toEqual([]);
    expect(stepOf((await runsOf(pipeline.id))[0], 'lod')).toMatchObject({ status: 'failed', reason: "eli can't run jobs in this project" });
  });

  it('ends when its card leaves the pipeline, and goes with its pipeline or its card', async () => {
    const { pipeline } = await gwerh();
    const rock = await card({ pipelineId: pipeline.id });
    await eli.patch(`${P}/production/shots/${rock.id}`, { pipelineId: null });
    expect((await runsOf(pipeline.id))[0].status).toBe('cancelled');

    await eli.patch(`${P}/production/shots/${rock.id}`, { pipelineId: pipeline.id });
    expect((await runsOf(pipeline.id)).map((r: any) => r.status)).toEqual(['running', 'cancelled']);
    await eli.delete(`${P}/production/shots/${rock.id}`);
    expect(await runsOf(pipeline.id)).toEqual([]);

    const tree = await card({ pipelineId: pipeline.id, name: 'Tree' });
    await eli.delete(`${P}/pipelines/${pipeline.id}`);
    expect(mongo.db.docs('pipeline_runs')).toEqual([]);
    expect(mongo.db.docs('production_shots').find((c: any) => c.id === tree.id).pipelineId).toBeNull();
  });

  it("takes only a pipeline of the project for a card, and only a Tasks step of its pipeline for a task", async () => {
    const { pipeline } = await gwerh([]);
    expect((await card({ pipelineId: 'nope' }))).toBeUndefined();
    const rock = await card({ pipelineId: pipeline.id });
    expect((await eli.post(`${P}/production/shots/${rock.id}/tasks`, { name: 'Sculpt', stepId: 'review' })).status).toBe(400);
    expect((await eli.post(`${P}/production/shots/${rock.id}/tasks`, { name: 'Sculpt', stepId: 'model' })).status).toBe(201);
    // Out of the pipeline, its tasks are in no step of it.
    await eli.patch(`${P}/production/shots/${rock.id}`, { pipelineId: null });
    expect(mongo.db.docs('production_tasks')[0].stepId).toBeNull();
  });
});

describe('starting a run', () => {
  it('by hand: of a card linked to the pipeline, one at a time', async () => {
    const { pipeline } = await gwerh([]);
    const rock = await card();
    expect((await eli.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id })).status).toBe(400);
    await eli.patch(`${P}/production/shots/${rock.id}`, { pipelineId: pipeline.id });
    const started = await eli.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id });
    expect(started.status).toBe(201);
    expect(started.body.run).toMatchObject({ trigger: 'manual', status: 'running', current: ['plan'] });
    const again = await eli.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id });
    expect(again.status).toBe(409);
    expect(again.body.run.id).toBe(started.body.run.id);
    expect((await eli.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: 'nope' })).status).toBe(404);
    expect((await eli.post(`${P}/pipelines/nope/runs`, { shotId: rock.id })).status).toBe(404);
  });

  it("isn't for a viewer, nor a token without jobs:run", async () => {
    const { pipeline } = await gwerh([]);
    const rock = await card({ pipelineId: pipeline.id });
    expect((await vic.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id })).status).toBe(403);
    const reader = as({ token: await tokenFor(['workflow:read', 'workflow:write', 'production:write']) });
    expect((await reader.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id })).status).toBe(403);
    const runner = as({ token: await tokenFor(['jobs:run']) });
    expect((await runner.post(`${P}/pipelines/${pipeline.id}/runs`, { shotId: rock.id })).status).toBe(201);
  });

  it('by a card done, or an asset marked as its deliverable, when the pipeline is set to', async () => {
    const done = await newPipeline({ triggers: ['card_done'] });
    const rock = await card({ pipelineId: done.id });
    expect(await runsOf(done.id)).toEqual([]);
    await eli.patch(`${P}/production/shots/${rock.id}`, { status: 'done' });
    expect((await runsOf(done.id)).map((r: any) => r.trigger)).toEqual(['card_done']);

    const marked = await newPipeline({ triggers: ['deliverable_marked'] });
    const tree = await card({ pipelineId: marked.id, name: 'Tree' });
    expect(await runsOf(marked.id)).toEqual([]);
    await eli.post(`${P}/deliverables`, { assetId: 'a1', shotId: tree.id });
    expect((await runsOf(marked.id)).map((r: any) => r.trigger)).toEqual(['deliverable_marked']);
  });

  it("isn't done by a trigger for someone who can't run jobs", async () => {
    const pipeline = await newPipeline({ triggers: ['card_linked'] });
    await ada.put(`${P}/permissions`, { roles: { 'jobs:run': 'admin' } });
    await card({ pipelineId: pipeline.id });
    expect(await runsOf(pipeline.id)).toEqual([]);
    // Nor by a token that can't, for one whose role may.
    const writer = as({ token: await tokenFor(['production:write'], 'ada') });
    await card({ pipelineId: pipeline.id, name: 'Tree' }, writer);
    expect(await runsOf(pipeline.id)).toEqual([]);
    await card({ pipelineId: pipeline.id, name: 'Bush' }, ada);
    expect(await runsOf(pipeline.id)).toHaveLength(1);
  });
});

describe("a card's runs", () => {
  it('are found by its key or its id', async () => {
    const { pipeline } = await gwerh();
    const rock = await card({ pipelineId: pipeline.id });
    const byKey = await vic.get(`${P}/production/shots/${rock.key.toLowerCase()}/pipeline-runs`);
    expect(byKey.body.runs).toEqual([expect.objectContaining({ pipelineId: pipeline.id, current: ['plan'] })]);
    expect((await vic.get(`${P}/production/shots/${rock.id}/pipeline-runs`)).body.runs).toHaveLength(1);
    expect((await vic.get(`${P}/production/shots/NOPE-1/pipeline-runs`)).status).toBe(404);
  });
});

describe('what a project calls its sequences and shots', () => {
  it('is Sequence and Shot until its admins name them', async () => {
    expect((await vic.get(`${P}/production/board`)).body.labels).toEqual({ sequence: 'Sequence', sequences: 'Sequences', shot: 'Shot', shots: 'Shots' });
    expect((await eli.put(`${P}/production/board/labels`, { shot: 'Asset' })).status).toBe(403);
    const named = await ada.put(`${P}/production/board/labels`, { sequence: ' Set ', sequences: 'Sets', shot: 'Asset', shots: 'Assets' });
    expect(named.body.labels).toEqual({ sequence: 'Set', sequences: 'Sets', shot: 'Asset', shots: 'Assets' });
    expect((await vic.get(`${P}/production/board`)).body.labels.shot).toBe('Asset');
    // An empty one is the default again; one it doesn't have, or too long, is refused.
    expect((await ada.put(`${P}/production/board/labels`, { shot: '' })).body.labels).toMatchObject({ shot: 'Shot', shots: 'Assets' });
    expect((await ada.put(`${P}/production/board/labels`, { card: 'Card' })).status).toBe(400);
    expect((await ada.put(`${P}/production/board/labels`, { shot: 'x'.repeat(31) })).status).toBe(400);
  });
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

  const call = async (client: Client, name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: args as any });
    return { error: result.isError ? result.content[0].text as string : null, data: result.isError ? null : JSON.parse(result.content[0].text || 'null') };
  };

  it("starts a card's run, and reads where each card is by its key", async () => {
    const { pipeline } = await gwerh([]);
    const rock = await card({ pipelineId: pipeline.id });
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const token = await tokenFor(['workflow:read', 'production:read', 'jobs:run'], 'eli');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const started = await call(client, 'start_pipeline_run', { projectId: 'p1', pipelineId: pipeline.id, shotId: rock.id });
    expect(started.error).toBeNull();
    expect(started.data).toMatchObject({ status: 'running', current: ['plan'] });
    expect((await call(client, 'list_pipeline_runs', { projectId: 'p1', pipelineId: pipeline.id })).data).toEqual([expect.objectContaining({ card: expect.objectContaining({ key: rock.key }) })]);
    const where = await call(client, 'get_shot_pipeline_runs', { projectId: 'p1', shot: rock.key });
    expect(where.data[0].steps.find((s: any) => s.nodeId === 'plan')).toMatchObject({ status: 'active', reason: 'Waiting for its document to be published' });
    await client.close();
  });
});
