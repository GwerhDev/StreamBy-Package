import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// A project's permissions live in the NoSQL database (here in memory), with its teams and
// documents; projects, users and tokens in the models (here in memory too).
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
      if (row && data.$pull?.members) row.members = row.members.filter((m: any) => m.userId !== data.$pull.members.userId);
      else if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
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

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');
const { permissionsForOAuthScopes } = await import('../src/services/oauthTokens');

const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'mongo', type: 'nosql', main: true }],
  authProvider: async (req: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer);
      if (!resolved) throw new Error('Invalid API token');
      return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
    }
    // An app acting for a user (an OAuth access token): app:<user>:<scope>.
    if (bearer?.startsWith('app:')) {
      const [, userId, scope] = bearer.split(':');
      return {
        userId, username: userId, role: 'viewer' as const,
        apiToken: { kind: 'user' as const, tokenId: 'oauth', projectIds: '*' as const, permissions: permissionsForOAuthScopes([`streamby:${scope}`]) },
        oauth: { clientId: 'claude', clientName: 'Claude' },
      };
    }
    return { userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer' as const };
  },
}));
const as = (user: string) => ({
  get: (p: string) => request(app).get(`/streamby${p}`).set('x-test-user', user),
  post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  put: (p: string, body?: object) => request(app).put(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
  delete: (p: string) => request(app).delete(`/streamby${p}`).set('x-test-user', user),
});
const appOf = (user: string, scope = 'write') => {
  const auth = { Authorization: `Bearer app:${user}:${scope}` };
  return {
    post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set(auth).send(body ?? {}),
    patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set(auth).send(body ?? {}),
    put: (p: string, body?: object) => request(app).put(`/streamby${p}`).set(auth).send(body ?? {}),
    delete: (p: string) => request(app).delete(`/streamby${p}`).set(auth),
  };
};
const ada = as('ada');
const eli = as('eli');
const permissionsOf = async (projectId = 'p1') => (await ada.get(`/projects/${projectId}/permissions`)).body.permissions;
const newDocument = async (projectId: string, title = 'Notes') =>
  (await ada.post(`/projects/${projectId}/documents`, { title, content: 'x' })).body.document.id;

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'nosql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }] },
    { _id: 'p2', id: 'p2', name: 'Other', dbType: 'nosql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' }] },
  ];
  store.users = ['ada', 'eli', 'vic'].map(id => ({ _id: id, id, username: id }));
});
afterEach(() => vi.restoreAllMocks());

describe("a project's permissions", () => {
  it("are today's rules until an admin changes them: editors do it all but manage teams; apps get nothing more", async () => {
    const { body } = await as('vic').get('/projects/p1/permissions');
    expect(body.permissions.apps).toEqual([]);
    expect(body.permissions.roles).toMatchObject({ 'teams:manage': 'admin', 'docs:delete': 'editor', 'production:delete': 'editor', 'project:update': 'editor' });
    expect(body.actions).toContain('teams:manage');
    expect(body.appPermissions).toEqual(expect.arrayContaining(['docs:delete', 'docs:publish']));
    expect((await eli.post('/projects/p1/teams', { name: 'Layout' })).status).toBe(403);
    const doc = await newDocument('p1');
    expect((await eli.delete(`/projects/p1/documents/${doc}`)).status).toBe(200);
  });

  it('only an admin changes them, from a session; what is wrong is refused, nothing saved', async () => {
    expect((await eli.put('/projects/p1/permissions', { roles: { 'teams:manage': 'editor' } })).status).toBe(403);
    expect((await appOf('ada').put('/projects/p1/permissions', { apps: ['docs:delete'] })).status).toBe(403);
    for (const body of [{ roles: { 'members:manage': 'editor' } }, { roles: { 'docs:delete': 'viewer' } }, { roles: [] }, { apps: ['project:delete'] }, { apps: 'docs:delete' }]) {
      expect((await ada.put('/projects/p1/permissions', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await permissionsOf()).roles['teams:manage']).toBe('admin');
  });

  it('an admin lets editors manage teams, and an editor makes one; a viewer still can\'t', async () => {
    const saved = await ada.put('/projects/p1/permissions', { roles: { 'teams:manage': 'editor' } });
    expect(saved.status).toBe(200);
    expect(saved.body.permissions.roles['teams:manage']).toBe('editor');
    const made = await eli.post('/projects/p1/teams', { name: 'Layout', memberIds: ['eli'] });
    expect(made.status).toBe(201);
    expect((await eli.patch(`/projects/p1/teams/${made.body.teams[0].id}`, { name: 'Animation' })).status).toBe(200);
    expect((await as('vic').post('/projects/p1/teams', { name: 'Nope' })).status).toBe(403);
    // Only in that project.
    expect((await eli.post('/projects/p2/teams', { name: 'Layout' })).status).toBe(403);
  });

  it("an admin keeps an action for admins only, and the server refuses it to editors, whatever they use", async () => {
    await ada.put('/projects/p1/permissions', { roles: { 'docs:delete': 'admin', 'production:delete': 'admin' } });
    const doc = await newDocument('p1');
    const refused = await eli.delete(`/projects/p1/documents/${doc}`);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/docs:delete/);
    // An editor's own app, and own API token, can't either.
    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    expect((await appOf('eli').delete(`/projects/p1/documents/${doc}`)).status).toBe(403);
    const token = (await createApiToken({ kind: 'user', userId: 'eli' }, { name: 'eli', permissions: ['docs:read', 'docs:delete'], projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
    expect((await request(app).delete(`/streamby/projects/p1/documents/${doc}`).set({ Authorization: `Bearer ${token}` })).status).toBe(403);
    // Editors still write; admins still delete.
    expect((await eli.post('/projects/p1/documents', { title: 'Still mine' })).status).toBe(201);
    expect((await ada.delete(`/projects/p1/documents/${doc}`)).status).toBe(200);
    // Columns too: deleting one is production:delete.
    const qa = (await eli.post('/projects/p1/production/board/columns', { name: 'QA', status: 'review' })).body.columns.at(-1).id;
    expect((await eli.delete(`/projects/p1/production/board/columns/${qa}`)).status).toBe(403);
    expect((await ada.delete(`/projects/p1/production/board/columns/${qa}`)).status).toBe(200);
  });

  it('a viewer still archives the project in their own list', async () => {
    await ada.put('/projects/p1/permissions', { roles: { 'project:update': 'admin' } });
    expect((await as('vic').patch('/projects/p1/archive')).status).not.toBe(403);
  });

  it('go with their project', async () => {
    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    expect((await ada.delete('/projects/p1')).status).toBe(200);
    expect(mongo.db.collection('project_permissions').docs).toEqual([]);
  });
});

describe('what a team adds for its editors', () => {
  const teamOf = async (name: string, memberIds: string[]) =>
    (await ada.post('/projects/p1/teams', { name, memberIds })).body.teams.find((t: any) => t.name === name).id;

  it("an admins' only action is let to the editors in a team, and to no other editor", async () => {
    store.projects[0].members.push({ userId: 'zoe', role: 'editor', status: 'active' });
    store.users.push({ _id: 'zoe', id: 'zoe', username: 'zoe' });
    const docsTeam = await teamOf('Docs', ['eli', 'vic']);
    await ada.put('/projects/p1/permissions', { roles: { 'docs:delete': 'admin' }, teams: { [docsTeam]: ['docs:delete'] } });
    expect((await permissionsOf()).teams).toEqual({ [docsTeam]: ['docs:delete'] });
    const [a, b, c] = [await newDocument('p1', 'A'), await newDocument('p1', 'B'), await newDocument('p1', 'C')];
    expect((await eli.delete(`/projects/p1/documents/${a}`)).status).toBe(200);
    expect((await as('zoe').delete(`/projects/p1/documents/${b}`)).status).toBe(403);
    // A viewer in the team still only reads.
    expect((await as('vic').delete(`/projects/p1/documents/${c}`)).status).toBe(403);
    // Their app too, if the project lets apps delete documents.
    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    expect((await appOf('eli').delete(`/projects/p1/documents/${b}`)).status).toBe(200);
    expect((await appOf('zoe').delete(`/projects/p1/documents/${c}`)).status).toBe(403);
  });

  it('a team can let its editors manage teams', async () => {
    const leads = await teamOf('Leads', ['eli']);
    await ada.put('/projects/p1/permissions', { teams: { [leads]: ['teams:manage'] } });
    expect((await eli.post('/projects/p1/teams', { name: 'Layout' })).status).toBe(201);
  });

  it('who leaves the team, or a deleted team, adds nothing any more', async () => {
    const docsTeam = await teamOf('Docs', ['eli']);
    await ada.put('/projects/p1/permissions', { roles: { 'docs:delete': 'admin' }, teams: { [docsTeam]: ['docs:delete'] } });
    const doc = await newDocument('p1');
    await ada.patch(`/projects/p1/teams/${docsTeam}`, { memberIds: [] });
    expect((await eli.delete(`/projects/p1/documents/${doc}`)).status).toBe(403);
    await ada.patch(`/projects/p1/teams/${docsTeam}`, { memberIds: ['eli'] });
    expect((await ada.delete(`/projects/p1/teams/${docsTeam}`)).status).toBe(200);
    expect((await permissionsOf()).teams).toEqual({});
    expect((await eli.delete(`/projects/p1/documents/${doc}`)).status).toBe(403);
  });

  it("takes only the project's teams, and actions a role may be let do", async () => {
    const theirs = (await ada.post('/projects/p2/teams', { name: 'Theirs' })).body.teams[0].id;
    const mine = await teamOf('Mine', []);
    for (const teams of [{ [theirs]: ['docs:delete'] }, { nope: ['docs:delete'] }, { [mine]: ['members:manage'] }, { [mine]: 'docs:delete' }, []]) {
      expect((await ada.put('/projects/p1/permissions', { teams })).status, JSON.stringify(teams)).toBe(400);
    }
    // A team with nothing left adds nothing, and isn't kept.
    await ada.put('/projects/p1/permissions', { teams: { [mine]: ['docs:delete', 'docs:delete'] } });
    expect((await permissionsOf()).teams).toEqual({ [mine]: ['docs:delete'] });
    await ada.put('/projects/p1/permissions', { teams: { [mine]: [] } });
    expect((await permissionsOf()).teams).toEqual({});
  });
});

describe('teams that grant permissions', () => {
  const T = '/projects/p1/teams';
  const teamOf = async (name: string, memberIds: string[] = []) =>
    (await ada.post(T, { name, memberIds })).body.teams.find((t: any) => t.name === name).id;
  // Editors manage teams here; one team grants docs:delete, another nothing.
  const setup = async () => {
    store.projects[0].members.push({ userId: 'zoe', role: 'editor', status: 'active' });
    store.users.push({ _id: 'zoe', id: 'zoe', username: 'zoe' });
    const granting = await teamOf('Docs', ['zoe']);
    const plain = await teamOf('Layout', ['zoe']);
    await ada.put('/projects/p1/permissions', { roles: { 'teams:manage': 'editor', 'docs:delete': 'admin' }, teams: { [granting]: ['docs:delete'] } });
    return { granting, plain };
  };
  const refused = (res: any) => {
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/managed by the project's admins/);
  };

  it('each team says whether it grants permissions', async () => {
    const { granting, plain } = await setup();
    const { teams } = (await eli.get(T)).body;
    expect(Object.fromEntries(teams.map((t: any) => [t.id, t.grantsPermissions]))).toEqual({ [granting]: true, [plain]: false });
  });

  it("an editor who manages teams makes one, renames a granting one, and changes and deletes one that grants nothing", async () => {
    const { granting, plain } = await setup();
    expect((await eli.post(T, { name: 'Sound', memberIds: ['eli'] })).status).toBe(201);
    const renamed = await eli.patch(`${T}/${granting}`, { name: 'Writers' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.teams.find((t: any) => t.id === granting)).toMatchObject({ name: 'Writers', grantsPermissions: true });
    // The same members, with a new name, is renaming.
    expect((await eli.patch(`${T}/${granting}`, { name: 'Docs', memberIds: ['zoe'] })).status).toBe(200);
    expect((await eli.patch(`${T}/${plain}`, { memberIds: ['eli', 'zoe'] })).status).toBe(200);
    expect((await eli.delete(`${T}/${plain}`)).status).toBe(200);
  });

  it("is refused changing a granting team's members, or deleting it: nobody gets a permission no admin gave them", async () => {
    const { granting } = await setup();
    refused(await eli.patch(`${T}/${granting}`, { memberIds: ['zoe', 'eli'] }));
    refused(await eli.patch(`${T}/${granting}`, { name: 'Renamed too', memberIds: ['eli'] }));
    refused(await eli.patch(`${T}/${granting}`, { memberIds: [] }));
    refused(await eli.delete(`${T}/${granting}`));
    const team = (await ada.get(T)).body.teams.find((t: any) => t.id === granting);
    expect(team).toMatchObject({ name: 'Docs', members: [expect.objectContaining({ userId: 'zoe' })] });
    // So eli still can't delete documents.
    const doc = await newDocument('p1');
    expect((await eli.delete(`/projects/p1/documents/${doc}`)).status).toBe(403);
  });

  it('also when an editor manages teams through a team of their own', async () => {
    const { granting } = await setup();
    const leads = await teamOf('Leads', ['eli']);
    await ada.put('/projects/p1/permissions', { roles: { 'teams:manage': 'admin' }, teams: { [granting]: ['docs:delete'], [leads]: ['teams:manage'] } });
    expect((await eli.post(T, { name: 'Sound' })).status).toBe(201);
    refused(await eli.patch(`${T}/${granting}`, { memberIds: ['eli'] }));
    // Leads grants a permission too: eli can't add others to it, nor take it away.
    refused(await eli.patch(`${T}/${leads}`, { memberIds: ['eli', 'zoe'] }));
    refused(await eli.delete(`${T}/${leads}`));
  });

  it('an admin changes and deletes any of them', async () => {
    const { granting } = await setup();
    expect((await ada.patch(`${T}/${granting}`, { memberIds: ['eli'] })).status).toBe(200);
    expect((await ada.delete(`${T}/${granting}`)).status).toBe(200);
  });

  it("a project's token, which acts as an admin, changes and deletes them", async () => {
    const { granting } = await setup();
    const { token } = await createApiToken({ kind: 'project', userId: 'ada', username: 'ada', projectId: 'p1' }, { name: 'ci', permissions: ['members:read', 'members:manage'], expiresInDays: 30 }, { databases: [] } as any);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).patch(`/streamby${T}/${granting}`).set(auth).send({ memberIds: ['eli'] })).status).toBe(200);
    expect((await request(app).delete(`/streamby${T}/${granting}`).set(auth)).status).toBe(200);
  });

  it('a team becomes protected once an admin gives it permissions, and not before', async () => {
    const { plain } = await setup();
    expect((await eli.patch(`${T}/${plain}`, { memberIds: ['eli'] })).status).toBe(200);
    await ada.put('/projects/p1/permissions', { teams: { [plain]: ['production:delete'] } });
    refused(await eli.patch(`${T}/${plain}`, { memberIds: [] }));
    refused(await eli.delete(`${T}/${plain}`));
    // Given nothing again, it's anyone's who manages teams.
    await ada.put('/projects/p1/permissions', { teams: {} });
    expect((await eli.delete(`${T}/${plain}`)).status).toBe(200);
  });
});

describe('apps connected to a project', () => {
  it("can't delete documents, until a project lets them: there, and only there", async () => {
    const here = await newDocument('p1');
    const there = await newDocument('p2');
    const refused = await appOf('ada').delete(`/projects/p1/documents/${here}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/can't delete here/);

    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    expect((await appOf('ada').delete(`/projects/p1/documents/${here}`)).status).toBe(200);
    expect((await appOf('ada').delete(`/projects/p2/documents/${there}`)).status).toBe(403);
  });

  it('get only what the project adds: other deletes stay refused', async () => {
    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    const seq = (await ada.post('/projects/p1/production/sequences', { name: 'Opening' })).body.sequence.id;
    expect((await appOf('ada').delete(`/projects/p1/production/sequences/${seq}`)).status).toBe(403);
  });

  it("publish only where the project lets them", async () => {
    const doc = await newDocument('p1');
    expect((await appOf('ada').patch(`/projects/p1/documents/${doc}`, { exportable: true })).status).toBe(403);
    await ada.put('/projects/p1/permissions', { apps: ['docs:publish'] });
    expect((await appOf('ada').patch(`/projects/p1/documents/${doc}`, { exportable: true })).status).toBe(200);
  });

  it('manage teams only if the project lets them and their user may', async () => {
    expect((await appOf('ada').post('/projects/p1/teams', { name: 'Layout' })).status).toBe(403);
    await ada.put('/projects/p1/permissions', { apps: ['members:manage'] });
    expect((await appOf('ada').post('/projects/p1/teams', { name: 'Layout' })).status).toBe(201);
    // Never more than their user's role: an editor's app, with teams the admins' only.
    expect((await appOf('eli').post('/projects/p1/teams', { name: 'Sound' })).status).toBe(403);
  });

  it("an app approved only to read gets nothing a project adds", async () => {
    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    const doc = await newDocument('p1');
    expect((await appOf('ada', 'read').delete(`/projects/p1/documents/${doc}`)).status).toBe(403);
  });
});

describe('documents through MCP', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });
  const connect = async (bearer: string) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    return client;
  };
  const call = (client: Client, name: string, args: object) => client.callTool({ name, arguments: args as any }) as Promise<any>;

  it('an agent deletes a document where its project lets apps, and is told 403 elsewhere', async () => {
    const here = await newDocument('p1');
    const there = await newDocument('p2');
    await ada.put('/projects/p1/permissions', { apps: ['docs:delete'] });
    const agent = await connect('app:ada:write');
    expect((await agent.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['delete_document', 'move_document']));
    expect((await call(agent, 'delete_document', { projectId: 'p1', documentId: here })).isError).toBeFalsy();
    const refused = await call(agent, 'delete_document', { projectId: 'p2', documentId: there });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/can't delete here/);
    expect(mongo.db.collection('documents').docs.map((d: any) => d.id)).toEqual([there]);
  });

  it('an agent moves a document into a folder and back to the top, with docs:write', async () => {
    const folder = (await ada.post('/projects/p1/documents', { title: 'Lore', kind: 'folder' })).body.document.id;
    const doc = await newDocument('p1');
    const agent = await connect('app:eli:write');
    const moved = await call(agent, 'move_document', { projectId: 'p1', documentId: doc, parentId: folder });
    expect(moved.isError).toBeFalsy();
    expect(JSON.parse(moved.content[0].text)).toMatchObject({ id: doc, parentId: folder });
    expect(JSON.parse((await call(agent, 'move_document', { projectId: 'p1', documentId: doc, parentId: null, position: 0 })).content[0].text)).toMatchObject({ parentId: null });
  });

  it("an app approved to read doesn't get them listed", async () => {
    const reader = await connect('app:ada:read');
    expect((await reader.listTools()).tools.map(t => t.name)).not.toContain('delete_document');
  });
});
