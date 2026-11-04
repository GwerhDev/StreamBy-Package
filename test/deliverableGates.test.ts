import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Gates before a Deliverable node of the workflow (a Review Gate linked to a review session, a
// Credits sheet) holding back the deliverables it applies to. Projects live in the models (here in
// memory); documents in the main database's store, in memory too with no main database connected.
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
    update: async (filter: any, data: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
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
// The workers set to process a deliverable's asset by themselves: what's asked of them is all.
const started = vi.hoisted(() => [] as { assetId: string; userId: string }[]);
vi.mock('../src/services/workerJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/workerJobs')>()),
  enqueueAutomaticJobs: async (_project: any, assetId: string, _versionId: any, auth: any) => {
    started.push({ assetId, userId: auth.userId });
    return [{ jobId: `job-${started.length}`, assetId }];
  },
  publicJob: (job: any) => job,
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
vi.mock('../src/services/wsHub', () => ({
  initWsHub: () => {},
  emitToUser: (userId: string, event: any) => { events.push({ userId, event }); },
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');
const { documentStore } = await import('../src/services/documents');
const { gatesBefore, gatesChanged } = await import('../src/services/deliverableGates');

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
const adapter = { getPresignedUploadUrl: async (key: string) => `https://upload.test/${key}`, deleteFile: async () => {} };
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
    put: (p: string, body?: object) => auth(request(app).put(`/streamby${p}`)).send(body ?? {}),
    patch: (p: string, body?: object) => auth(request(app).patch(`/streamby${p}`)).send(body ?? {}),
    delete: (p: string) => auth(request(app).delete(`/streamby${p}`)),
  };
};
const ada = as({ user: 'ada' });
const eli = as({ user: 'eli' });
const vic = as({ user: 'vic' });
const P = '/projects/p1';

const file = (fileId: string) =>
  mongo.db.collection('storage_files').docs.push({ fileId, projectId: 'p1', category: '3d-models', storageKey: `p1/3d/${fileId}.glb`, displayName: `${fileId}.glb` });
const complete = { creatorName: 'Jane Doe', sourceUrl: 'https://sketchfab.com/rock', licenseType: 'CC BY' };
const project = () => store.projects[0];
const workflow = (nodes: any[], edges: [string, string][]) => {
  project().workflow = { nodeSchema: { nodes, edges: edges.map(([source, target]) => ({ id: `${source}-${target}`, source, target })) } };
};
const sheet = async (assetIds: string[]) =>
  (await eli.post(`${P}/documents`, { title: 'Credits', kind: 'credits', content: JSON.stringify({ assetIds }) })).body.document;
const review = async (assetId = 'a1') => (await eli.post(`${P}/reviews`, { assetId, assetVersionId: 'v1' })).body.review;
const decide = (reviewId: string, decision: 'approve' | 'reject', who = ada) => who.post(`${P}/reviews/${reviewId}/decision`, { decision });
const mark = (body: object) => eli.post(`${P}/deliverables`, { assetId: 'a1', ...body });
const listed = async (query = '') => (await vic.get(`${P}/deliverables${query}`)).body.deliverables;

// The workflow of a project releasing a model: its credits sheet feeds a Review Gate, the gate
// a Deliverable node (as the canvas connects them).
const releasing = async (deliverable: object = {}) => {
  const doc = await sheet(['a1']);
  const session = await review();
  workflow([
    { id: 'sheet', type: 'creditsSheetNode', data: { label: 'Model credits', documentId: doc.id } },
    { id: 'gate', type: 'reviewGateNode', data: { label: 'Art review', reviewId: session.id } },
    { id: 'deliver', type: 'deliverableNode', data: { label: 'Release', ...deliverable } },
  ], [['sheet', 'gate'], ['gate', 'deliver']]);
  return { doc, session };
};

beforeEach(async () => {
  mongo.db = new FakeDb();
  events.length = 0;
  started.length = 0;
  for (const k of Object.keys(store)) delete store[k];
  await documentStore().deleteProject('p1');
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Spellcast', dbType: 'sql', exports: [{ id: 'e1', name: 'Site' }, { id: 'e2', name: 'Docs' }], members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }] },
  ];
  store.exports = [{ id: 'e1', projectId: 'p1', name: 'Site' }, { id: 'e2', projectId: 'p1', name: 'Docs' }];
  file('a1'); file('a2');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a deliverable's state", () => {
  it('is ready, with no gates, as deliverables always were, and its workers start', async () => {
    const made = await mark({ shotId: undefined, exportId: 'e1' });
    expect(made.status).toBe(201);
    expect(made.body.deliverable).toMatchObject({ status: 'ready', gated: false, blockedBy: [] });
    expect(made.body.jobs).toHaveLength(1);
    // A Deliverable node with no gates before it changes nothing.
    workflow([{ id: 'deliver', type: 'deliverableNode', data: {} }], []);
    expect((await listed())[0]).toMatchObject({ status: 'ready', gated: false });
  });

  it('is blocked by an incomplete credits sheet before it, and ready once it is complete and the Review Gate approved', async () => {
    const { session } = await releasing();
    const made = await mark({ exportId: 'e1' });
    expect(made.body.deliverable.status).toBe('blocked');
    expect(made.body.deliverable.blockedBy).toEqual([
      { nodeId: 'gate', type: 'reviewGateNode', label: 'Art review', reason: 'Waiting for approvals: 0 of 1' },
      { nodeId: 'sheet', type: 'creditsSheetNode', label: 'Model credits', reason: '1 of 1 assets lack credits' },
    ]);
    // It's never in its answers that its workers are held.
    expect(made.body.deliverable).not.toHaveProperty('heldJobs');

    await eli.put(`${P}/assets/a1/rights`, complete);
    expect((await listed())[0]).toMatchObject({ status: 'blocked', blockedBy: [expect.objectContaining({ nodeId: 'gate' })] });
    await decide(session.id, 'approve');
    expect((await listed())[0]).toMatchObject({ status: 'ready', gated: true, blockedBy: [] });
  });

  it('says what each gate lacks: a session not linked, gone or rejected, a sheet with no assets or gone', async () => {
    const doc = await sheet([]);
    const rejected = await review();
    await decide(rejected.id, 'reject');
    workflow([
      { id: 'unlinked', type: 'reviewGateNode', data: { label: 'Unlinked' } },
      { id: 'gone', type: 'reviewGateNode', data: { label: 'Gone', reviewId: 'nope' } },
      { id: 'rejected', type: 'reviewGateNode', data: { label: 'Rejected', reviewId: rejected.id } },
      { id: 'empty', type: 'creditsSheetNode', data: { label: 'Empty', documentId: doc.id } },
      { id: 'deleted', type: 'creditsSheetNode', data: { label: 'Deleted', documentId: 'nope' } },
      { id: 'deliver', type: 'deliverableNode', data: {} },
    ], [['unlinked', 'deliver'], ['gone', 'deliver'], ['rejected', 'deliver'], ['empty', 'deliver'], ['deleted', 'deliver']]);
    const { nodes } = (await vic.get(`${P}/deliverables/gates`)).body;
    expect(nodes.deliver).toMatchObject({ status: 'blocked', gated: true, appliesTo: 'all', exportId: null });
    expect(Object.fromEntries(nodes.deliver.blockedBy.map((b: any) => [b.nodeId, b.reason]))).toEqual({
      unlinked: 'No review session linked to it',
      gone: 'Its review session no longer exists',
      rejected: 'Its review session was rejected',
      empty: 'Its credits sheet has no assets',
      deleted: 'Its credits sheet no longer exists',
    });
  });

  it('counts the gates before its node step by step, through other nodes, and none after it', () => {
    const schema = {
      nodes: [
        { id: 'sheet', type: 'creditsSheetNode' }, { id: 'gate', type: 'reviewGateNode' }, { id: 'streamby', type: 'orchestratorNode' },
        { id: 'deliver', type: 'deliverableNode' }, { id: 'later', type: 'reviewGateNode' }, { id: 'aside', type: 'reviewGateNode' },
      ],
      edges: [
        { source: 'sheet', target: 'gate' }, { source: 'gate', target: 'streamby' }, { source: 'streamby', target: 'deliver' },
        { source: 'deliver', target: 'later' }, { source: 'later', target: 'deliver' }, { source: 'aside', target: 'later' },
      ],
    };
    // A cycle back into it brings what's before it on the way: here the gate after it, and the one feeding that.
    expect(gatesBefore(schema, 'deliver').map(n => n.id).sort()).toEqual(['aside', 'gate', 'later', 'sheet']);
    expect(gatesBefore({ ...schema, edges: schema.edges.slice(0, 4) }, 'deliver').map(n => n.id).sort()).toEqual(['gate', 'sheet']);
  });

  it("is held only by the Deliverable nodes that apply to it: all, its shots', its exports' or one export's", async () => {
    mongo.db.collection('production_shots').docs.push({ id: 's1', projectId: 'p1', name: 'Opening' });
    workflow([
      { id: 'gate', type: 'reviewGateNode', data: { label: 'Review' } },
      { id: 'shots', type: 'deliverableNode', data: { appliesTo: 'shots' } },
      { id: 'site', type: 'deliverableNode', data: { appliesTo: 'exports', exportId: 'e1' } },
    ], [['gate', 'shots'], ['gate', 'site']]);
    await mark({ shotId: 's1' });
    await mark({ exportId: 'e1' });
    await mark({ exportId: 'e2' });
    const byFor = async () => Object.fromEntries((await listed()).map((d: any) => [d.shotId ?? d.exportId, d.status]));
    expect(await byFor()).toEqual({ s1: 'blocked', e1: 'blocked', e2: 'ready' });

    project().workflow.nodeSchema.nodes[2].data = { appliesTo: 'exports' };
    expect(await byFor()).toEqual({ s1: 'blocked', e1: 'blocked', e2: 'blocked' });
    project().workflow.nodeSchema.nodes = project().workflow.nodeSchema.nodes.slice(0, 2);
    expect(await byFor()).toEqual({ s1: 'blocked', e1: 'ready', e2: 'ready' });
    // Of an unknown kind, it applies to all.
    project().workflow.nodeSchema.nodes[1].data = { appliesTo: 'everything' };
    expect(await byFor()).toEqual({ s1: 'blocked', e1: 'blocked', e2: 'blocked' });
  });
});

describe('a blocked deliverable', () => {
  it("doesn't start its automatic workers: they start once it's ready, once, as who made it ready", async () => {
    const { session } = await releasing();
    await eli.put(`${P}/assets/a1/rights`, complete);
    const made = await mark({ exportId: 'e1' });
    expect(made.body.jobs).toEqual([]);
    expect(started).toEqual([]);
    expect(mongo.db.docs('deliverables')[0].heldJobs).toBe(true);

    await decide(session.id, 'approve');
    expect(started).toEqual([{ assetId: 'a1', userId: 'ada' }]);
    expect(mongo.db.docs('deliverables')[0].heldJobs).toBeUndefined();
    // Another change, still ready: nothing starts again.
    await eli.put(`${P}/assets/a1/rights`, { comments: 'Retextured' });
    expect(started).toHaveLength(1);
  });

  it("stays held when the change doesn't make it ready, or comes from a token that can't run jobs", async () => {
    const { session } = await releasing();
    await mark({ exportId: 'e1' });
    await decide(session.id, 'approve');
    expect(started).toEqual([]);
    const token = await tokenFor(['rights:write', 'assets:read']);
    expect((await as({ token }).put(`${P}/assets/a1/rights`, complete)).status).toBe(200);
    expect((await listed())[0].status).toBe('ready');
    expect(started).toEqual([]);
    expect(mongo.db.docs('deliverables')[0].heldJobs).toBe(true);
    // The next change made by someone who runs jobs starts them.
    await eli.put(`${P}/assets/a1/rights`, { comments: 'Checked' });
    expect(started).toEqual([{ assetId: 'a1', userId: 'eli' }]);
  });

  it('starts its workers only once, of two changes at the same time that find it ready', async () => {
    const { session } = await releasing();
    await mark({ exportId: 'e1' });
    await eli.put(`${P}/assets/a1/rights`, complete);
    // Approved with no gate change heard: two changes at once find it ready, held.
    mongo.db.collection('review_sessions').docs.find((r: any) => r.id === session.id).status = 'approved';
    const runs: string[] = [];
    const release = (who: string) => ({ run: async () => { runs.push(who); } });
    await Promise.all([gatesChanged(project(), release('one')), gatesChanged(project(), release('two'))]);
    expect(runs).toHaveLength(1);
  });

  it("holds its export: it can't be published until each deliverable of it is ready", async () => {
    const { session } = await releasing({ appliesTo: 'exports', exportId: 'e1' });
    await mark({ exportId: 'e1' });
    const publish = (exportId: string) => eli.post(`${P}/deliverables/${exportId}/publish`, { targets: [{ connectionId: 'cdn' }] });
    const refused = await publish('e1');
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Blocked: Art review (Waiting for approvals: 0 of 1); Model credits (1 of 1 assets lack credits)');
    expect(refused.body.blockedBy).toHaveLength(2);
    // Another export, with nothing gating it, is published.
    expect((await publish('e2')).status).toBe(202);

    await eli.put(`${P}/assets/a1/rights`, complete);
    await decide(session.id, 'approve');
    expect((await publish('e1')).status).toBe(202);
  });
});

describe("a gate's change", () => {
  it("tells the project's members to read the deliverables' states again", async () => {
    const { session, doc } = await releasing();
    const told = () => events.filter(e => e.event.type === 'deliverableGatesEvent').map(e => e.userId).sort();
    events.length = 0;
    await decide(session.id, 'approve');
    expect(told()).toEqual(['ada', 'eli', 'vic']);
    expect(events.find(e => e.event.type === 'deliverableGatesEvent')!.event.data).toEqual({ projectId: 'p1' });

    events.length = 0;
    await eli.put(`${P}/assets/a1/rights`, complete);
    expect(told()).toEqual(['ada', 'eli', 'vic']);

    events.length = 0;
    await eli.patch(`${P}/documents/${doc.id}`, { baseVersion: 1, content: JSON.stringify({ assetIds: ['a1', 'a2'] }) });
    expect(told()).toEqual(['ada', 'eli', 'vic']);

    events.length = 0;
    expect((await eli.delete(`${P}/storage/files/a2`)).status).toBe(200);
    expect(told()).toEqual(['ada', 'eli', 'vic']);

    // A document that isn't a credits sheet changes no gate.
    const notes = (await eli.post(`${P}/documents`, { title: 'Notes' })).body.document;
    events.length = 0;
    await eli.patch(`${P}/documents/${notes.id}`, { baseVersion: 1, content: 'Hi' });
    expect(told()).toEqual([]);
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

  it('marks and lists deliverables with their state and what holds them', async () => {
    await releasing();
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const token = await tokenFor(['assets:read', 'assets:write'], 'eli');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const marked = await call(client, 'mark_deliverable', { projectId: 'p1', assetId: 'a1', exportId: 'e1' });
    expect(marked.error).toBeNull();
    expect(marked.data).toMatchObject({ status: 'blocked', blockedBy: [expect.objectContaining({ label: 'Art review' }), expect.objectContaining({ label: 'Model credits' })] });
    const list = await call(client, 'list_deliverables', { projectId: 'p1' });
    expect(list.data).toEqual([expect.objectContaining({ id: marked.data.id, status: 'blocked', gated: true })]);
    await client.close();
  });
});
