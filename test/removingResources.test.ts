import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FakeDb, matches } from './fakeMongo';

// What depends on a project's connections, exports and pipelines (told before removing one),
// and its built-ins disconnected and connected again (as any integration is). Projects live in the models (here in
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
  delete: (p: string) => request(app).delete(`/streamby${p}`).set('x-test-user', user),
});
const eli = as('eli');
const vic = as('vic');

const builtinDb = (id: string, integrationId: string, dbType: string) => ({ id, name: dbType, dbType, projectId: 'p1', source: 'builtin', isBuiltin: true, integrationId });
const project = () => store.projects[0];

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Spellcast', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
    dbConnections: [builtinDb('db-mongo', 'mongo', 'mongodb'), builtinDb('db-pg', 'postgres', 'postgresql')],
    storageConnections: [{ id: 'st-1', name: 'AWS S3', type: 's3', projectId: 'p1', source: 'builtin', isBuiltin: true, integrationId: 's3-main' }],
    connections: [{ id: 'api-1', name: 'Weather' }],
    exports: [{ id: 'e1', name: 'Site', nodeSchema: { nodes: [{ id: 'n1', type: 'dataSourceNode', data: { label: 'Spells', connectionId: 'db-mongo' } }], edges: [] } }],
    workflow: { nodeSchema: { nodes: [
      { id: 'db-db-mongo', type: 'dataSourceNode', data: { label: 'MongoDB', connectionId: 'db-mongo' } },
      { id: 'ingest-x', type: 'ingestNode', data: { label: 'Ingest plates', storageConnectionId: 'st-1' } },
    ], edges: [] } },
  }];
});

describe('what depends on a resource', () => {
  it("lists the nodes that use a connection: the workflow's (not the one drawn for it), an export's, a pipeline's", async () => {
    mongo.db.collection('pipelines').docs.push({ id: 'pl1', projectId: 'p1', name: 'Shading', nodeSchema: { nodes: [{ id: 'q', data: { connectionId: 'db-mongo' } }] } });
    const { body } = await vic.get('/projects/p1/dependents/db/db-mongo');
    expect(body.dependents).toEqual([
      { type: 'export', id: 'e1', name: 'Site', count: 1 },
      { type: 'pipeline', id: 'pl1', name: 'Shading', count: 1 },
    ]);
    expect((await vic.get('/projects/p1/dependents/db/db-pg')).body.dependents).toEqual([]);
  });

  it("counts a storage's files and folders, a built-in's older ones too", async () => {
    mongo.db.collection('storage_files').docs.push(
      { fileId: 'a', projectId: 'p1', storageConnectionId: 'st-1' },
      { fileId: 'b', projectId: 'p1', storageConnectionId: 's3-main' },
      { fileId: 'c', projectId: 'p1' },
      { fileId: 'd', projectId: 'p1', storageConnectionId: 'other' },
    );
    mongo.db.collection('storage_folders').docs.push({ folderId: 'f', projectId: 'p1', storageConnectionId: 'st-1' });
    // The Ingest set to it is its own node: not something that depends on it.
    expect((await vic.get('/projects/p1/dependents/storage/st-1')).body.dependents).toEqual([
      { type: 'files', name: 'Files', count: 3 },
      { type: 'folders', name: 'Folders', count: 1 },
    ]);
  });

  it("counts an export's deliverables and shots", async () => {
    mongo.db.collection('deliverables').docs.push({ projectId: 'p1', exportId: 'e1' }, { projectId: 'p1', exportId: 'e2' });
    mongo.db.collection('production_shots').docs.push({ projectId: 'p1', exportId: 'e1' });
    expect((await vic.get('/projects/p1/dependents/export/e1')).body.dependents).toEqual([
      { type: 'deliverables', name: 'Deliverables', count: 1 },
      { type: 'shots', name: 'Shots', count: 1 },
    ]);
  });

  it('is asked of a resource the project has, by a member', async () => {
    expect((await vic.get('/projects/p1/dependents/db/nope')).status).toBe(404);
    expect((await vic.get('/projects/p1/dependents/table/db-mongo')).status).toBe(400);
    expect((await as('pat').get('/projects/p1/dependents/db/db-mongo')).status).toBe(403);
  });
});

describe('a built-in', () => {
  // As the New connection form sends it: the integration picked, with its pool name and type.
  const connectDb = (integrationId: string) =>
    eli.post('/projects/p1/connections/db', { integrationId, name: 'PostgreSQL', dbType: 'sql' });

  it('is disconnected, and connected again from New connection with the id it had', async () => {
    const removed = await eli.delete('/projects/p1/connections/db/db-pg');
    expect(removed.status).toBe(200);
    // It answers the list as it is now, for the client to show.
    expect(removed.body.dbConnections.map((c: any) => c.id)).toEqual(['db-mongo']);
    expect(project().dbConnections.map((c: any) => c.id)).toEqual(['db-mongo']);
    expect(project().disconnectedBuiltins).toEqual([{ kind: 'db', integrationId: 'postgres', connectionId: 'db-pg' }]);

    expect((await vic.post('/projects/p1/connections/db', { integrationId: 'postgres' })).status).toBe(403);
    const again = await connectDb('postgres');
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ id: 'db-pg', name: 'PostgreSQL', dbType: 'postgresql', source: 'builtin', integrationId: 'postgres' });
    expect(again.body.dbConnections.map((c: any) => c.id)).toEqual(['db-mongo', 'db-pg']);
    expect(project().disconnectedBuiltins).toEqual([]);
    expect((await connectDb('postgres')).body.message).toBe('This integration is already connected to the project');
  });

  it("isn't connected as another kind", async () => {
    await eli.delete('/projects/p1/connections/db/db-pg');
    expect((await eli.post('/projects/p1/connections/storage', { integrationId: 'postgres' })).body.message).toBe("This integration isn't a storage");
  });

  it('storage too, and from the project\'s integrations: connected again, its files are its own again', async () => {
    const removed = await eli.delete('/projects/p1/integrations/s3-main');
    expect(removed.status).toBe(200);
    expect(removed.body.project.storageConnections).toEqual([]);
    expect(project().storageConnections).toEqual([]);
    expect(project().disconnectedBuiltins).toEqual([{ kind: 'storage', integrationId: 's3-main', connectionId: 'st-1' }]);
    const again = await eli.post('/projects/p1/integrations', { integrationId: 's3-main' });
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ id: 'st-1', type: 's3', source: 'builtin' });
  });

  it('a project that never had it connects it with a new id', async () => {
    project().dbConnections = [builtinDb('db-mongo', 'mongo', 'mongodb')];
    const added = await connectDb('postgres');
    expect(added.status).toBe(201);
    expect(added.body.data.id).not.toBe('db-pg');
    expect(matches(project().dbConnections[1], { integrationId: 'postgres', source: 'builtin' })).toBe(true);
  });
});

describe("an account's integration", () => {
  it("tells the projects' connections that use it, and disconnects them when it's deleted", async () => {
    store.user_integrations = [{ id: 'ui-1', userId: 'eli', kind: 'database', provider: 'postgresql', name: 'My PG' }];
    project().dbConnections.push({ id: 'db-mine', name: 'My PG', dbType: 'postgresql', projectId: 'p1', source: 'integration', integrationId: 'ui-1' });
    expect((await eli.get('/user/integrations/ui-1/dependents')).body.dependents).toEqual([
      { projectId: 'p1', projectName: 'Spellcast', kind: 'db', connectionId: 'db-mine', name: 'My PG' },
    ]);
    expect((await vic.get('/user/integrations/ui-1/dependents')).status).toBe(404);

    const deleted = await eli.delete('/user/integrations/ui-1');
    expect(deleted.body).toMatchObject({ disconnected: 1 });
    expect(deleted.body.affected).toEqual([expect.objectContaining({ projectId: 'p1', dbConnections: [expect.objectContaining({ id: 'db-mongo' }), expect.objectContaining({ id: 'db-pg' })] })]);
    expect(project().dbConnections.map((c: any) => c.id)).toEqual(['db-mongo', 'db-pg']);
  });
});

