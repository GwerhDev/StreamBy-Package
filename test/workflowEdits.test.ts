import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Editing a workflow node by node, as an agent does (edit_workflow): on the version it was read
// at, with the canvas's connections, and saved as the canvas saves it. Projects live in the
// models (in memory), review sessions in a fake Mongo, documents in the in-memory store.
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
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matchesRecord(r, filter));
      if (row && data.$pull) for (const [list, by] of Object.entries<any>(data.$pull)) row[list] = (row[list] ?? []).filter((item: any) => !matchesRecord(item, by));
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
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');
const { documentStore } = await import('../src/services/documents');
const { connectionOf } = await import('../src/services/workflowEdits');

const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
  authProvider: async (req: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer);
      if (!resolved) throw new Error('Invalid API token');
      return { userId: resolved.userId, username: resolved.name, role: 'viewer', apiToken: resolved.scope };
    }
    const user = req.headers['x-test-user'];
    if (!user) throw new Error('No session');
    // An app the user connected with OAuth (as claude.ai is), writing the workflow.
    if (req.headers['x-test-oauth']) {
      return {
        userId: user, username: user, role: 'viewer',
        apiToken: { tokenId: `oauth:app:${user}`, kind: 'user', projectIds: '*', permissions: ['workflow:read', 'workflow:write'] },
        oauth: { clientId: 'dyn_app', clientName: 'App' },
      };
    }
    return { userId: user, username: user, role: 'viewer' };
  },
}));

const P = '/projects/p1';
const READ_AT = '2026-11-10T10:00:00.000Z';
const project = () => store.projects[0];
const workflow = () => project().workflow;
const edit = (edits: object[], baseUpdatedAt = workflow().updatedAt, user = 'eli') =>
  request(app).post(`/streamby${P}/workflow/changes`).set('x-test-user', user).send({ baseUpdatedAt, edits });
const credits = async () =>
  (await request(app).post(`/streamby${P}/documents`).set('x-test-user', 'eli').send({ title: 'Model credits', kind: 'credits' })).body.document;

beforeEach(async () => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  await documentStore().deleteProject('p1');
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'World', dbType: 'sql',
    exports: [{ id: 'e1', name: 'site' }],
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
    workflow: {
      id: 'w1', name: 'Workflow', projectId: 'p1', updatedAt: READ_AT, resourceNodesAt: READ_AT,
      nodeSchema: {
        nodes: [
          { id: 'streamby', type: 'orchestratorNode', position: { x: 0, y: 0 }, data: { label: 'StreamBy' } },
          { id: 'deliver', type: 'deliverableNode', position: { x: 400, y: 0 }, data: { label: 'Release' } },
        ],
        edges: [],
      },
    },
  }];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('editing the workflow node by node', () => {
  it('adds a credits sheet and a Review Gate, connects them to the deliverable, and they hold it back', async () => {
    const sheet = await credits();
    mongo.db.collection('review_sessions').docs.push({ id: 'r1', projectId: 'p1', status: 'pending', assetId: 'a1' });
    const res = await edit([
      { op: 'add', type: 'creditsSheetNode', id: 'sheet', data: { documentId: sheet.id } },
      { op: 'add', type: 'reviewGateNode', id: 'gate', label: 'Art review', data: { reviewId: 'r1' }, position: { x: 200, y: 200 } },
      { op: 'connect', source: 'sheet', target: 'gate' },
      { op: 'connect', source: 'gate', target: 'deliver' },
    ]);
    expect(res.status).toBe(200);
    const { nodes, edges } = workflow().nodeSchema;
    expect(nodes.find((n: any) => n.id === 'sheet')).toMatchObject({ type: 'creditsSheetNode', data: { label: 'Credits sheet', documentId: sheet.id } });
    expect(nodes.find((n: any) => n.id === 'gate')).toMatchObject({ position: { x: 200, y: 200 }, data: { label: 'Art review', reviewId: 'r1' } });
    // With the canvas's handles, so it draws them as its own.
    expect(edges).toEqual([
      { id: 'e-sheet-gate', source: 'sheet', target: 'gate', sourceHandle: 'out-status', targetHandle: 'in-process' },
      { id: 'e-gate-deliver', source: 'gate', target: 'deliver', sourceHandle: 'out-review', targetHandle: 'in-filter' },
    ]);
    expect(new Date(workflow().updatedAt).getTime()).toBeGreaterThan(new Date(READ_AT).getTime());

    const { nodes: states } = (await request(app).get(`/streamby${P}/deliverables/gates`).set('x-test-user', 'eli')).body;
    expect(states.deliver).toMatchObject({ status: 'blocked', gated: true });
    expect(states.deliver.blockedBy.map((b: any) => b.nodeId).sort()).toEqual(['gate', 'sheet']);
  });

  it('is refused on an old version of the workflow (409), and nothing changes', async () => {
    const before = structuredClone(workflow());
    const res = await edit([{ op: 'move', id: 'deliver', position: { x: 1, y: 1 } }], '2026-11-10T09:00:00.000Z');
    expect(res.status).toBe(409);
    expect(res.body.data.updatedAt).toBe(READ_AT);
    expect(workflow()).toEqual(before);

    // Two agents on the same version: the second is told it changed.
    expect((await edit([{ op: 'move', id: 'deliver', position: { x: 1, y: 1 } }], READ_AT)).status).toBe(200);
    expect((await edit([{ op: 'move', id: 'deliver', position: { x: 2, y: 2 } }], READ_AT)).status).toBe(409);
    expect(workflow().nodeSchema.nodes.find((n: any) => n.id === 'deliver').position).toEqual({ x: 1, y: 1 });
  });

  it('moves, updates, disconnects and removes nodes, all or none', async () => {
    const sheet = await credits();
    await edit([
      { op: 'add', type: 'creditsSheetNode', id: 'sheet', data: { documentId: sheet.id } },
      { op: 'connect', source: 'sheet', target: 'deliver' },
    ]);
    const res = await edit([
      { op: 'update', id: 'deliver', data: { appliesTo: 'exports', exportId: 'e1', label: 'Site release' } },
      { op: 'move', id: 'sheet', position: { x: -100, y: 50 } },
      { op: 'disconnect', source: 'sheet', target: 'deliver' },
      { op: 'remove', id: 'sheet' },
    ]);
    expect(res.status).toBe(200);
    expect(workflow().nodeSchema.nodes.map((n: any) => n.id)).toEqual(['streamby', 'deliver']);
    expect(workflow().nodeSchema.nodes[1].data).toMatchObject({ appliesTo: 'exports', exportId: 'e1', label: 'Site release' });
    expect(workflow().nodeSchema.edges).toEqual([]);
    // A node removed takes its edges; its sheet stays, as the canvas leaves it.
    expect(await documentStore().get('p1', sheet.id)).toBeTruthy();

    // One edit that can't be made: none is.
    const saved = structuredClone(workflow());
    const failed = await edit([
      { op: 'move', id: 'deliver', position: { x: 9, y: 9 } },
      { op: 'remove', id: 'nope' },
    ]);
    expect(failed.status).toBe(400);
    expect(failed.body.message).toBe('Edit 2 (remove): no node nope in the workflow');
    expect(workflow()).toEqual(saved);
  });

  it("follows the canvas's rules: what connects, what a node is tied to, the orchestrator", async () => {
    const sheet = await credits();
    const cases: [object[], string][] = [
      [[{ op: 'connect', source: 'deliver', target: 'streamby' }], 'Edit 1 (connect): a deliverableNode doesn\'t connect to a orchestratorNode'],
      [[{ op: 'connect', source: 'deliver', target: 'deliver' }], "Edit 1 (connect): a node doesn't connect to itself"],
      [[{ op: 'add', type: 'requestNode' }], 'Edit 1 (add): a workflow\'s nodes are dataSourceNode, connectionNode, ingestNode, integrationConnectionNode, pipelineRefNode, exportNode, creditsSheetNode, reviewGateNode, annotationNode, exportFormatNode, deliverableNode'],
      [[{ op: 'add', type: 'creditsSheetNode' }], "Edit 1 (add): a Credits sheet node is its sheet's place: give its documentId (create_document with kind 'credits')"],
      [[{ op: 'add', type: 'creditsSheetNode', data: { documentId: 'nope' } }], "Edit 1 (add): nope isn't a credits sheet of the project"],
      [[{ op: 'add', type: 'reviewGateNode', data: { reviewId: 'nope' } }], "Edit 1 (add): nope isn't a review session of the project"],
      [[{ op: 'update', id: 'deliver', data: { appliesTo: 'exports', exportId: 'e9' } }], "Edit 1 (update): e9 isn't an export of the project"],
      [[{ op: 'add', type: 'exportNode', data: { exportId: 'e9' } }], "Edit 1 (add): e9 isn't one of the project's exports"],
      [[{ op: 'add', type: 'reviewGateNode', id: 'deliver' }], 'Edit 1 (add): the workflow has a node deliver already'],
      [[{ op: 'add', type: 'creditsSheetNode', id: 's', data: { documentId: sheet.id } }, { op: 'connect', source: 's', target: 'deliver' }, { op: 'connect', source: 's', target: 'deliver' }], 'Edit 3 (connect): s is connected to deliver already'],
      [[{ op: 'remove', id: 'streamby' }], "Edit 1 (remove): StreamBy's orchestrator is part of every workflow: it can't be removed"],
      [[{ op: 'update', id: 'streamby', data: { label: 'X' } }], "Edit 1 (update): StreamBy's orchestrator doesn't change"],
      [[{ op: 'shuffle' }], 'Edit 1 (shuffle): op is add, update, move, connect, disconnect or remove'],
    ];
    for (const [edits, message] of cases) {
      const res = await edit(edits);
      expect(res.status, message).toBe(400);
      expect(res.body.message).toBe(message);
    }
    expect((await edit([])).status).toBe(400);
    expect(workflow().updatedAt).toBe(READ_AT);
    expect(connectionOf('ingestNode', 'creditsSheetNode')).toEqual({ sourceHandle: 'out-stream', targetHandle: 'in-assets' });
  });

  it("is for who can edit the project, and removes a resource with its node as saving the canvas does", async () => {
    expect((await edit([{ op: 'move', id: 'deliver', position: { x: 1, y: 1 } }], READ_AT, 'vic')).status).toBe(403);
    project().dbConnections = [{ id: 'c1', name: 'Spells', dbType: 'mongodb', source: 'integration' }];
    project().workflow.nodeSchema.nodes.push({ id: 'db', type: 'dataSourceNode', position: { x: 0, y: 300 }, data: { label: 'Spells', connectionId: 'c1' } });
    // An app connected with OAuth removes nothing, through the workflow either.
    const byApp = await request(app).post(`/streamby${P}/workflow/changes`).set('x-test-user', 'eli').set('x-test-oauth', '1')
      .send({ baseUpdatedAt: READ_AT, edits: [{ op: 'remove', id: 'db' }] });
    expect(byApp.status).toBe(403);
    expect(byApp.body.message).toBe('An app connected with OAuth removes nothing: this would remove Spells');
    expect(project().dbConnections).toHaveLength(1);
    // It moves a node, though.
    expect((await request(app).post(`/streamby${P}/workflow/changes`).set('x-test-user', 'eli').set('x-test-oauth', '1')
      .send({ baseUpdatedAt: READ_AT, edits: [{ op: 'move', id: 'db', position: { x: 5, y: 5 } }] })).status).toBe(200);

    const res = await edit([{ op: 'remove', id: 'db' }]);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(project().dbConnections).toEqual([]);
  });
});

describe('edit_workflow, from an agent', () => {
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
  const textOf = (result: any) => result.content?.[0]?.text as string;

  it('makes its credits sheet, adds it and a Review Gate before the deliverable, and is told when the workflow changed', async () => {
    const agent = await connect(['workflow:read', 'workflow:write', 'docs:write']);
    const tool = (await agent.listTools()).tools.find(t => t.name === 'edit_workflow');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    const sheet = JSON.parse(textOf(await agent.callTool({ name: 'create_document', arguments: { projectId: 'p1', title: 'Model credits', kind: 'credits' } })));
    expect(sheet.kind).toBe('credits');
    const read = JSON.parse(textOf(await agent.callTool({ name: 'get_workflow', arguments: { projectId: 'p1' } })));
    const edits = [
      { op: 'add', type: 'creditsSheetNode', id: 'sheet', data: { documentId: sheet.id } },
      { op: 'add', type: 'reviewGateNode', id: 'gate' },
      { op: 'connect', source: 'sheet', target: 'gate' },
      { op: 'connect', source: 'gate', target: 'deliver' },
    ];
    const made = await agent.callTool({ name: 'edit_workflow', arguments: { projectId: 'p1', baseUpdatedAt: read.data.updatedAt, edits } });
    expect(made.isError).toBeFalsy();
    const answer = JSON.parse(textOf(made));
    expect(answer.workflow.nodeSchema.edges.map((e: any) => `${e.source}>${e.target}`)).toEqual(['sheet>gate', 'gate>deliver']);
    expect(answer.errors).toEqual([]);

    // The same edits on the version it read before: refused.
    const stale = await agent.callTool({ name: 'edit_workflow', arguments: { projectId: 'p1', baseUpdatedAt: read.data.updatedAt, edits: [{ op: 'remove', id: 'gate' }] } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/409|changed since it was read/);
    expect(workflow().nodeSchema.nodes.map((n: any) => n.id)).toContain('gate');
  });

  it('is only for a token that writes the workflow', async () => {
    const reader = await connect(['workflow:read']);
    expect((await reader.listTools()).tools.map(t => t.name)).not.toContain('edit_workflow');
  });
});
