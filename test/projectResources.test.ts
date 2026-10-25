import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Each of a project's resources has its own list, so a client fetches the one it shows
// instead of the whole project. Projects live in the models (here in memory).
const store: Record<string, any[]> = {};
const matchesRecord = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matchesRecord(r, filter)),
    findOne: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    create: async (doc: any) => { rows().push(doc); return doc; },
    update: async () => null,
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
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
// The project itself asks the NoSQL database whether it has production data: it has none here.
vi.mock('../src/utils/nosqlDb', () => ({ nosqlDb: () => null }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { routeRuleFor } = await import('../src/services/apiTokenPermissions');

const app = express();
app.use(express.json());
app.use(createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
  authProvider: async (req: any) => ({ userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer' as const }),
}));
const get = (user: string, path: string) => request(app).get(path).set('x-test-user', user);

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Film',
    members: [{ userId: 'ada', role: 'viewer', status: 'active' }],
    allowedOrigin: ['https://film.example'],
    exports: [{ id: 'e1', name: 'menu', description: 'Menu', method: 'GET', private: false, nodeSchema: { nodes: [] }, encryptedCredential: 'secret' }],
    integrationConnections: [{ id: 'c1', name: 'Prod DB', provider: 'postgres', projectId: 'p1', integrationId: 'i1', source: 'integration' }],
  }];
});

describe("a project's resources, each on its own", () => {
  it('lists its exports as the project does: what each is, not its schema nor its secrets', async () => {
    const res = await get('ada', '/projects/p1/exports');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'e1', name: 'menu', description: 'Menu', method: 'GET', private: false }]);
    const project = await get('ada', '/projects/p1');
    expect(project.body.project.exports).toEqual(res.body.data);
  });

  // An integration holds no credential of its own (its account's integration does).
  it('lists its integrations as the project does', async () => {
    const res = await get('ada', '/projects/p1/integrations');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'c1', name: 'Prod DB', provider: 'postgres', projectId: 'p1', integrationId: 'i1', source: 'integration', hasCredential: true }]);
    const project = await get('ada', '/projects/p1');
    expect(project.body.project.integrationConnections).toEqual(res.body.data);
  });

  it('lists its allowed origins', async () => {
    const res = await get('ada', '/projects/p1/origins');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['https://film.example']);
  });

  it("is for the project's members only, and says when there's no such project", async () => {
    for (const path of ['exports', 'integrations', 'origins']) {
      expect((await get('bob', `/projects/p1/${path}`)).status).toBe(403);
      expect((await get('ada', `/projects/nope/${path}`)).status).toBe(404);
    }
  });

  it('asks an API token for the permission of what it lists', () => {
    expect(routeRuleFor('GET', '/projects/p1/exports')?.permission).toBe('exports:read');
    expect(routeRuleFor('GET', '/projects/p1/exports/e1')?.permission).toBe('exports:read');
    expect(routeRuleFor('GET', '/projects/p1/integrations')?.permission).toBe('project:read');
    expect(routeRuleFor('GET', '/projects/p1/origins')?.permission).toBe('project:read');
  });
});
