import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FakeDb, matches } from './fakeMongo';

// The workflow defines the project: each resource is one of its nodes. A resource added or
// removed from its section adds or removes its node; the workflow saved makes the project what
// it defines (a node set to an integration connects it, a node gone removes its resource). Projects live in the models (here in
// memory, with $push and $pull as the SQL ones do them: a $pull matching one key).
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
    delete: async (filter: any) => { const before = rows().length; store[name] = rows().filter(r => !matchesRecord(r, filter)); return before - store[name].length; },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matchesRecord(r, filter));
      if (!row) return null;
      for (const [field, value] of Object.entries(data.$push ?? {})) row[field] = [...(row[field] ?? []), value];
      for (const [field, value] of Object.entries(data.$pull ?? {})) {
        const [key, expected] = Object.entries(value as object)[0];
        row[field] = (row[field] ?? []).filter((item: any) => String(item[key]) !== String(expected));
      }
      if (!data.$push && !data.$pull) Object.assign(row, data);
      return row;
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
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { CONNECT_PREFIX } = await import('../src/services/workflowResources');

const authProvider = async (req: any) => {
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  return { userId: user, username: user, role: 'viewer' as const };
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [{ id: 's3-main', type: 's3' } as any], adapter: {} as any, authProvider,
  databases: [{ id: 'mongo', type: 'nosql' }, { id: 'postgres', type: 'sql', main: true }] as any,
}));
const as = (user: string) => ({
  get: (p: string) => request(app).get(`/streamby${p}`).set('x-test-user', user),
  post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  delete: (p: string) => request(app).delete(`/streamby${p}`).set('x-test-user', user),
});
const eli = as('eli');
const vic = as('vic');

const builtinDb = (id: string, integrationId: string, dbType: string) => ({ id, name: dbType === 'postgresql' ? 'PostgreSQL' : 'MongoDB', dbType, projectId: 'p1', source: 'builtin', isBuiltin: true, integrationId });
const project = () => store.projects[0];
const nodes = () => project().workflow?.nodeSchema?.nodes ?? [];
const bound = (field: string) => nodes().filter((n: any) => n.data?.[field]).map((n: any) => n.data[field]);
const W = '/projects/p1/workflow';

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Spellcast', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
    dbConnections: [builtinDb('db-mongo', 'mongo', 'mongodb')],
    storageConnections: [], connections: [], exports: [], pipelines: [],
  }];
});

describe('a workflow made before it defined the project', () => {
  it("is brought to it once: a node for each resource, the ones drawn before bound, one per resource", async () => {
    project().connections = [{ id: 'api-1', name: 'Weather', method: 'GET' }];
    project().workflow = { id: 'w1', name: 'Workflow', updatedAt: new Date('2026-10-01'), nodeSchema: {
      nodes: [
        { id: 'streamby', type: 'orchestratorNode', position: { x: 350, y: 20 }, data: {} },
        { id: 'api-api-1', type: 'connectionNode', position: { x: 0, y: -160 }, data: { label: 'Weather' } },
        { id: 'ds-1', type: 'dataSourceNode', position: { x: 0, y: 300 }, data: { label: 'Data Source', connectionId: 'db-mongo' } },
        { id: 'ds-2', type: 'dataSourceNode', position: { x: 0, y: 400 }, data: { label: 'Spells', connectionId: 'db-mongo', tableName: 'spells' } },
      ],
      edges: [{ id: 'e1', source: 'ds-1', target: 'streamby' }],
    } };
    const read = (await vic.get(W)).body.data;
    expect(read.resourceNodesAt).toBeTruthy();
    // The API's node bound by its id; the database's, its Data Source; the one reading a table stays its own.
    expect(read.nodeSchema.nodes.map((n: any) => [n.id, n.data.connectionId])).toEqual([
      ['streamby', undefined], ['api-api-1', 'api-1'], ['ds-1', 'db-mongo'], ['ds-2', 'db-mongo'],
    ]);
    const again = (await vic.get(W)).body.data;
    expect(again.updatedAt).toEqual(read.updatedAt);
  });

  it("merges the node once drawn for a connection with a node set to it (the duplicate), edges and all", async () => {
    project().workflow = { id: 'w1', name: 'Workflow', nodeSchema: {
      nodes: [
        { id: 'streamby', type: 'orchestratorNode', position: { x: 350, y: 20 }, data: {} },
        { id: 'db-db-mongo', type: 'dataSourceNode', position: { x: 0, y: -160 }, data: { label: 'MongoDB', connectionId: 'db-mongo' } },
        { id: 'ds-1', type: 'dataSourceNode', position: { x: 0, y: 300 }, data: { label: 'Data Source', connectionId: 'db-mongo' } },
        { id: 'gate', type: 'reviewGateNode', position: { x: 0, y: 500 }, data: {} },
      ],
      edges: [
        { id: 'e-db', source: 'db-db-mongo', target: 'streamby' },
        { id: 'e-ds', source: 'ds-1', target: 'streamby' },
        { id: 'e-gate', source: 'ds-1', target: 'gate' },
      ],
    } };
    const read = (await vic.get(W)).body.data;
    expect(read.nodeSchema.nodes.map((n: any) => n.id)).toEqual(['streamby', 'db-db-mongo', 'gate']);
    expect(read.nodeSchema.edges.map((e: any) => [e.source, e.target])).toEqual([['db-db-mongo', 'streamby'], ['db-db-mongo', 'gate']]);
  });

  it('a project with no workflow has one with its resources', async () => {
    const read = (await vic.get(W)).body.data;
    expect(read.nodeSchema.nodes.map((n: any) => n.type)).toEqual(['orchestratorNode', 'dataSourceNode']);
    expect(read.nodeSchema.nodes[1].data).toMatchObject({ label: 'MongoDB', subtitle: 'mongodb', connectionId: 'db-mongo' });
    expect(read.nodeSchema.edges).toEqual([expect.objectContaining({ source: read.nodeSchema.nodes[1].id, target: 'streamby', targetHandle: 'in-top' })]);
  });
});

describe('a section', () => {
  it("connecting a resource adds its node to the workflow; disconnecting it takes it away", async () => {
    await vic.get(W);
    const added = await eli.post('/projects/p1/connections/db', { integrationId: 'postgres' });
    expect(added.status).toBe(201);
    const pg = project().dbConnections.find((c: any) => c.integrationId === 'postgres');
    expect(bound('connectionId')).toEqual(['db-mongo', pg.id]);
    expect(nodes().find((n: any) => n.data?.connectionId === pg.id).data).toMatchObject({ label: 'PostgreSQL', subtitle: 'postgresql' });

    const api = await eli.post('/projects/p1/connections', { name: 'Weather', apiUrl: 'https://api.test', method: 'GET' });
    expect(api.status).toBe(201);
    expect(nodes().filter((n: any) => n.type === 'connectionNode').map((n: any) => n.data.label)).toEqual(['Weather']);
    const pipeline = await eli.post('/projects/p1/pipelines', { name: 'Shading' });
    expect(pipeline.status).toBe(201);
    expect(nodes().filter((n: any) => n.type === 'pipelineRefNode').map((n: any) => n.data.label)).toEqual(['Shading']);
    // Wired to the orchestrator as the canvas lays them out: inputs on its top, pipelines on its left.
    const edgeOf = (type: string) => { const node = nodes().find((n: any) => n.type === type); return project().workflow.nodeSchema.edges.find((e: any) => e.source === node.id || e.target === node.id); };
    expect(edgeOf('connectionNode')).toMatchObject({ target: 'streamby', sourceHandle: 'out-stream', targetHandle: 'in-top' });
    expect(edgeOf('pipelineRefNode')).toMatchObject({ source: 'streamby', sourceHandle: 'out-pipeline', targetHandle: 'in-orchestrator' });
    expect(nodes().find((n: any) => n.type === 'pipelineRefNode').data.pipelineId).toBe(project().pipelines[0].id);

    expect((await eli.delete(`/projects/p1/connections/db/${pg.id}`)).status).toBe(200);
    expect(bound('connectionId')).toEqual(['db-mongo', project().connections[0].id]);
  });
});

describe('saving the workflow', () => {
  const save = async (change: (n: any[]) => any[], base?: string) => {
    const read = (await eli.get(W)).body.data;
    return eli.patch(W, { nodeSchema: { nodes: change(read.nodeSchema.nodes), edges: read.nodeSchema.edges }, baseUpdatedAt: base ?? read.updatedAt });
  };

  it('connects the integration a node was set to, and binds the node to it', async () => {
    const saved = await save(n => [...n, { id: 'drop-1', type: 'dataSourceNode', position: { x: 0, y: 0 }, data: { label: 'PostgreSQL', connectionId: `${CONNECT_PREFIX}postgres` } }]);
    expect(saved.status).toBe(200);
    const pg = project().dbConnections.find((c: any) => c.integrationId === 'postgres');
    expect(saved.body.data.nodeSchema.nodes.find((n: any) => n.id === 'drop-1').data.connectionId).toBe(pg.id);
    expect(saved.body.project.dbConnections.map((c: any) => c.id)).toEqual(['db-mongo', pg.id]);
    expect(saved.body.errors).toEqual([]);
  });

  it("makes an API drafted on a node", async () => {
    const saved = await save(n => [...n, { id: 'api-draft', type: 'connectionNode', data: { connectionDraft: { name: 'Weather', apiUrl: 'https://api.test', method: 'GET' } } }]);
    const api = project().connections[0];
    expect(api).toMatchObject({ name: 'Weather', apiUrl: 'https://api.test' });
    expect(saved.body.data.nodeSchema.nodes.find((n: any) => n.id === 'api-draft').data).toEqual({ connectionId: api.id, label: 'Weather', subtitle: 'https://api.test' });
  });

  it("removes a resource whose node is gone (a built-in, remembered to come back as it was)", async () => {
    const saved = await save(n => n.filter((node: any) => node.data?.connectionId !== 'db-mongo'));
    expect(saved.body.project.dbConnections).toEqual([]);
    expect(project().disconnectedBuiltins).toEqual([{ kind: 'db', integrationId: 'mongo', connectionId: 'db-mongo' }]);
  });

  it("refuses a version saved over a newer one, removing nothing", async () => {
    const read = (await eli.get(W)).body.data;
    await eli.post('/projects/p1/connections/db', { integrationId: 'postgres' });
    const stale = await eli.patch(W, { nodeSchema: read.nodeSchema, baseUpdatedAt: read.updatedAt });
    expect(stale.status).toBe(409);
    expect(project().dbConnections.map((c: any) => c.integrationId)).toEqual(['mongo', 'postgres']);
  });

  it("an agent's change to a workflow not brought yet removes none of its resources", async () => {
    project().workflow = { id: 'w1', name: 'Workflow', nodeSchema: { nodes: [], edges: [] } };
    await eli.patch(W, { nodeSchema: { nodes: [{ id: 'shot', type: 'shotNode', data: {} }], edges: [] } });
    expect(project().dbConnections.map((c: any) => c.id)).toEqual(['db-mongo']);
    expect(nodes().map((n: any) => n.type)).toEqual(['orchestratorNode', 'shotNode', 'dataSourceNode']);
  });
});
