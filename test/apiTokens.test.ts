import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Records in memory, by model: found by their fields, written as given.
const store: Record<string, any[]> = {};
let made = 0;
const matches = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matches(r, filter)),
    findOne: async (filter: any) => rows().find(r => matches(r, filter)) ?? null,
    create: async (doc: any) => {
      const { dbType: _d, ...row } = doc;
      if (name === 'projects' && !row._id) row._id = row.id = `new-${++made}`;
      rows().push(row);
      return row;
    },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matches(r, filter));
      if (row && data.$pull?.members) row.members = row.members.filter((m: any) => m.userId !== data.$pull.members.userId);
      else if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row ?? null;
    },
    delete: async (filter: any) => {
      const before = rows().length;
      store[name] = rows().filter(r => !matches(r, filter));
      return before - store[name].length;
    },
  };
  model.useDbType = () => model;
  return model;
};
vi.mock('../src/models/manager', () => ({ getModel: (name: string) => fakeModel(name), registerModel: () => {} }));
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/database/connectionManager')>()),
  initConnections: async () => {},
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
const notified = vi.hoisted(() => [] as { userId: string; type: string; message: string }[]);
vi.mock('../src/services/notification', () => ({
  createNotification: async (userId: string, type: string, message: string) => { notified.push({ userId, type, message }); },
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');
const { PROJECT_PERMISSIONS } = await import('../src/services/apiTokenPermissions');

// The host's authProvider, as Nhexa-API's: a session (here, a test header naming the user),
// or an API token as a bearer.
const app = express();
app.use(express.json());
app.use(createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
  authProvider: async (req) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer);
      if (!resolved) throw new Error('Invalid API token');
      return { userId: resolved.userId, username: resolved.name, role: 'viewer', apiToken: resolved.scope };
    }
    const user = req.headers['x-test-user'] as string | undefined;
    if (!user) throw new Error('No session');
    return { userId: user, username: user, role: 'viewer' };
  },
}));
const asUser = (user: string) => ({
  get: (p: string) => request(app).get(p).set('x-test-user', user),
  post: (p: string, body?: object) => request(app).post(p).set('x-test-user', user).send(body ?? {}),
  delete: (p: string) => request(app).delete(p).set('x-test-user', user),
});
const withToken = (token: string) => ({
  send: (method: string, p: string, body?: object) =>
    (request(app) as any)[method.toLowerCase()](p).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  patch: (p: string, body?: object) => request(app).patch(p).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  post: (p: string, body?: object) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});
const makeToken = async (body: object, user = 'eli') => {
  const res = await asUser(user).post('/user/api-tokens', { name: 'agent', ...body });
  expect(res.status).toBe(201);
  return res.body as { token: string; apiToken: any };
};
const makeProjectToken = async (projectId: string, body: object, user = 'ada') => {
  const res = await asUser(user).post(`/projects/${projectId}/api-tokens`, { name: 'ci', ...body });
  expect(res.status).toBe(201);
  return res.body as { token: string; apiToken: any };
};
// Turned down by the token's permissions (not by the route further on).
const deniedByToken = (res: request.Response) => res.status === 403 && /API token/.test(res.body?.error ?? '');

const project = (id: string, members: object[], dbType = 'sql') => ({ _id: id, id, name: id, dbType, members });
let logged: string[] = [];
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  notified.length = 0;
  store.projects = [
    project('p1', [
      { userId: 'ada', role: 'admin', status: 'active' },
      { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' },
    ], 'nosql'),
    project('p2', [{ userId: 'eli', role: 'editor', status: 'active' }]),
    project('p3', [{ userId: 'someone', role: 'admin', status: 'active' }]),
  ];
  store.users = [{ _id: 'eli', id: 'eli', username: 'eli' }];
  store.user_subscriptions = [{ user_id: 'eli', plan: 'subscriber' }];
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("making a user's token", () => {
  it('shows it once; only its hash is kept, and the list never shows it', async () => {
    const { token, apiToken } = await makeToken({ permissions: ['project:read'], projectIds: ['p1'], expiresInDays: 30 });
    expect(token).toMatch(/^sbt_[A-Za-z0-9_-]{43}$/);
    expect(apiToken).toMatchObject({ name: 'agent', kind: 'user', permissions: ['project:read'], projectIds: ['p1'], prefix: token.slice(0, 12) });
    expect(JSON.stringify(store.api_tokens)).not.toContain(token);
    expect(store.api_tokens[0].hash).toMatch(/^[0-9a-f]{64}$/);

    const list = await asUser('eli').get('/user/api-tokens');
    expect(list.body.apiTokens).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.apiTokens[0]).not.toHaveProperty('hash');
    // Nor anything else's: another user sees none of it.
    expect((await asUser('vic').get('/user/api-tokens')).body.apiTokens).toEqual([]);
  });

  // Stored as a list (valid JSON in SQL), ['*'] being every project; a list can't ask for it.
  it("keeps the projects it reaches as a list, and takes '*' only as every project", async () => {
    await makeToken({ permissions: ['project:read'], projectIds: '*' });
    await makeToken({ permissions: ['project:read'], projectIds: ['p1'] });
    expect(store.api_tokens.map(t => t.projectIds)).toEqual([['*'], ['p1']]);
    expect((await asUser('eli').post('/user/api-tokens', { name: 'x', permissions: ['project:read'], projectIds: ['*'] })).status).toBe(400);
  });

  it('reaches only projects its owner is in', async () => {
    const res = await asUser('eli').post('/user/api-tokens', { name: 'x', permissions: ['project:read'], projectIds: ['p1', 'p3'] });
    expect(res.status).toBe(400);
    expect(store.api_tokens ?? []).toHaveLength(0);
  });

  it('takes only known permissions, at least one', async () => {
    for (const permissions of [[], ['project:fly'], 'project:read', undefined]) {
      expect((await asUser('eli').post('/user/api-tokens', { name: 'x', permissions, projectIds: ['p1'] })).status).toBe(400);
    }
    expect(store.api_tokens ?? []).toHaveLength(0);
  });

  it('needs a project, unless it can create them', async () => {
    expect((await asUser('eli').post('/user/api-tokens', { name: 'x', permissions: ['project:read'], projectIds: [] })).status).toBe(400);
    const { apiToken } = await makeToken({ permissions: ['projects:create', 'project:read'], projectIds: [] });
    expect(apiToken.projectIds).toEqual([]);
  });

  it('takes only a known expiry, or none', async () => {
    expect((await asUser('eli').post('/user/api-tokens', { name: 'x', permissions: ['project:read'], projectIds: '*', expiresInDays: 5 })).status).toBe(400);
    const { apiToken } = await makeToken({ permissions: ['project:read'], projectIds: '*', expiresInDays: null });
    expect(apiToken.expiresAt).toBeNull();
  });
});

describe("using a user's token", () => {
  // Every route a token reaches, and the permission it needs.
  const ROUTES: [string, string, string][] = [
    ['GET', '/projects/p1', 'project:read'],
    ['PATCH', '/projects/p1', 'project:update'],
    ['DELETE', '/projects/p1', 'project:delete'],
    ['PATCH', '/projects/p1/origins', 'project:update'],
    ['GET', '/upload-project-image-url/p1', 'project:update'],
    ['GET', '/projects/p1/connections', 'project:read'],
    ['POST', '/projects/p1/connections/db', 'project:update'],
    ['DELETE', '/projects/p1/render-farm-connections/c1', 'project:update'],
    ['GET', '/projects/p1/members', 'members:read'],
    ['POST', '/projects/p1/members', 'members:manage'],
    ['PATCH', '/projects/p1/members/vic', 'members:manage'],
    ['DELETE', '/projects/p1/members/vic', 'members:manage'],
    ['GET', '/users/search', 'members:manage'],
    ['GET', '/projects/p1/storage/images', 'assets:read'],
    ['GET', '/projects/p1/storage/images/upload-url', 'assets:write'],
    ['GET', '/projects/p1/storage/files/f1/replace-url', 'assets:write'],
    ['PATCH', '/projects/p1/storage/files/f1', 'assets:write'],
    ['DELETE', '/projects/p1/storage/files/f1', 'assets:delete'],
    ['GET', '/projects/p1/connections/storage/c1/files/images', 'assets:read'],
    ['GET', '/projects/p1/connections/storage/c1/upload-url', 'assets:write'],
    ['POST', '/projects/p1/connections/storage/c1/folders', 'assets:write'],
    ['DELETE', '/projects/p1/connections/storage/c1/folders/d1', 'assets:delete'],
    ['GET', '/projects/p1/assets/f1/metadata', 'assets:read'],
    ['PATCH', '/projects/p1/assets/f1/metadata', 'assets:write'],
    ['GET', '/projects/p1/reviews', 'assets:read'],
    ['POST', '/projects/p1/reviews/r1/decision', 'assets:write'],
    ['GET', '/projects/p1/assets/f1/rights', 'rights:read'],
    ['PUT', '/projects/p1/assets/f1/rights', 'rights:write'],
    ['GET', '/projects/p1/production/sequences', 'production:read'],
    ['POST', '/projects/p1/production/sequences', 'production:write'],
    ['PATCH', '/projects/p1/production/shots/s1', 'production:write'],
    ['DELETE', '/projects/p1/production/shots/s1/tasks/t1', 'production:delete'],
    ['GET', '/projects/p1/workflow', 'workflow:read'],
    ['PATCH', '/projects/p1/workflow', 'workflow:write'],
    ['GET', '/projects/p1/pipelines', 'workflow:read'],
    ['DELETE', '/projects/p1/pipelines/x', 'workflow:write'],
    ['GET', '/projects/p1/exports/e1', 'exports:read'],
    ['POST', '/projects/p1/exports', 'exports:write'],
    ['DELETE', '/projects/p1/exports/e1', 'exports:write'],
    ['GET', '/jobs/j1', 'jobs:read'],
    ['POST', '/projects/p1/jobs/transcode', 'jobs:run'],
    ['POST', '/projects/p1/deliverables/e1/publish', 'jobs:run'],
    ['POST', '/projects/create', 'projects:create'],
  ];

  it.each(ROUTES)('%s %s needs %s', async (method, path, permission) => {
    const others = PROJECT_PERMISSIONS.filter(p => p !== permission);
    const without = await makeToken({ permissions: [...others, ...(permission === 'projects:create' ? [] : ['projects:create'])], projectIds: ['p1'] });
    const res = await withToken(without.token).send(method, path, {});
    expect(deniedByToken(res)).toBe(true);
    expect(res.body.error).toContain(permission);

    const only = await makeToken({ permissions: [permission], projectIds: ['p1'] });
    expect(deniedByToken(await withToken(only.token).send(method, path, {}))).toBe(false);
  });

  it("doesn't reach a route no permission covers: personal ones, and managing tokens", async () => {
    const { token } = await makeToken({ permissions: [...PROJECT_PERMISSIONS, 'projects:create'], projectIds: '*' });
    for (const [method, path] of [
      ['GET', '/user/api-tokens'], ['POST', '/user/api-tokens'], ['GET', '/projects/p1/api-tokens'],
      ['POST', '/projects/p1/api-tokens'], ['GET', '/user/integrations'], ['GET', '/notifications'],
      ['GET', '/projects/explore'], ['PATCH', '/projects/p1/members/eli/accept'], ['GET', '/databases'],
    ]) {
      expect(deniedByToken(await withToken(token).send(method, path, { name: 'more', permissions: ['project:read'] }))).toBe(true);
    }
    expect((await withToken(token).get('/auth')).status).toBe(200);
  });

  it('goes as far as its owner can, never further', async () => {
    const { token } = await makeToken({ permissions: ['project:update'], projectIds: ['p1'] });
    expect((await withToken(token).patch('/projects/p1', { name: 'X' })).status).toBe(200);
    // Vic is a viewer of p1: their token never does more.
    const viewers = await makeToken({ permissions: ['project:update'], projectIds: ['p1'] }, 'vic');
    expect((await withToken(viewers.token).patch('/projects/p1', { name: 'X' })).status).toBe(403);
    // Eli is an editor: no deleting the project, whatever the token says.
    const editors = await makeToken({ permissions: ['project:delete'], projectIds: ['p1'] });
    expect((await withToken(editors.token).delete('/projects/p1')).status).toBe(403);
  });

  it("doesn't see a project outside its own, nor lists it", async () => {
    const { token } = await makeToken({ permissions: ['project:read', 'project:update'], projectIds: ['p1'] });
    expect((await withToken(token).get('/projects/p2')).status).toBe(404);
    expect((await withToken(token).patch('/projects/p2', { name: 'X' })).status).toBe(404);
    const list = await withToken(token).get('/projects');
    expect(list.body.projects.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('an all-projects token reaches every project its owner is in, those joined later too', async () => {
    const { token } = await makeToken({ permissions: ['project:read'], projectIds: '*' });
    expect((await withToken(token).get('/projects')).body.projects.map((p: any) => p.id).sort()).toEqual(['p1', 'p2']);
    store.projects[2].members.push({ userId: 'eli', role: 'viewer', status: 'active' });
    expect((await withToken(token).get('/projects/p3')).status).toBe(200);
  });

  it('stops working on a project once its owner leaves it', async () => {
    const { token } = await makeToken({ permissions: ['project:read'], projectIds: ['p1'] }, 'vic');
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    store.projects[0].members = store.projects[0].members.filter((m: any) => m.userId !== 'vic');
    expect((await withToken(token).get('/projects/p1')).status).toBe(403);
  });

  it('with projects:create, creates a project, and reaches it from then on', async () => {
    const { token } = await makeToken({ permissions: ['projects:create', 'project:read'], projectIds: ['p1'] });
    const res = await withToken(token).post('/projects/create', { name: 'Made by an agent' });
    expect(res.status).toBe(200);
    const made = store.projects.find(p => p.name === 'Made by an agent');
    expect(made.members).toEqual([expect.objectContaining({ userId: 'eli', role: 'admin', status: 'active' })]);
    expect(store.api_tokens[0].projectIds).toEqual(['p1', made._id]);
    expect((await withToken(token).get(`/projects/${made._id}`)).status).toBe(200);
  });

  it('without it, creates none', async () => {
    const { token } = await makeToken({ permissions: [...PROJECT_PERMISSIONS], projectIds: '*' });
    expect((await withToken(token).post('/projects/create', { name: 'No' })).status).toBe(403);
    expect(store.projects).toHaveLength(3);
  });

  it('marks when it was last used', async () => {
    const { token } = await makeToken({ permissions: ['project:read'], projectIds: ['p1'] });
    expect(store.api_tokens[0].lastUsedAt).toBeNull();
    await withToken(token).get('/projects/p1');
    await vi.waitFor(() => expect(store.api_tokens[0].lastUsedAt).toBeInstanceOf(Date));
  });
});

describe("a project's token", () => {
  it("is made, listed and revoked by the project's admins only", async () => {
    for (const user of ['eli', 'vic', 'someone']) {
      expect((await asUser(user).post('/projects/p1/api-tokens', { name: 'x', permissions: ['project:read'] })).status).toBe(403);
      expect((await asUser(user).get('/projects/p1/api-tokens')).status).toBe(403);
    }
    const { apiToken } = await makeProjectToken('p1', { permissions: ['project:read'], expiresInDays: 90 });
    expect(apiToken).toMatchObject({ kind: 'project', projectIds: ['p1'], createdBy: { userId: 'ada', username: 'ada' } });
    expect((await asUser('eli').delete(`/projects/p1/api-tokens/${apiToken.id}`)).status).toBe(403);
    // Not a user's own token: it's in no one's list but the project's.
    expect((await asUser('ada').get('/user/api-tokens')).body.apiTokens).toEqual([]);
    expect((await asUser('ada').get('/projects/p1/api-tokens')).body.apiTokens.map((t: any) => t.id)).toEqual([apiToken.id]);
  });

  it("can't have account permissions", async () => {
    const res = await asUser('ada').post('/projects/p1/api-tokens', { name: 'x', permissions: ['project:read', 'projects:create'] });
    expect(res.status).toBe(400);
  });

  it('reaches its project only', async () => {
    store.projects[1].members.push({ userId: 'ada', role: 'admin', status: 'active' });
    const { token } = await makeProjectToken('p1', { permissions: ['project:read'] });
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    expect((await withToken(token).get('/projects/p2')).status).toBe(404);
    expect((await withToken(token).get('/projects')).body.projects.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('does what its permissions allow, and nothing else', async () => {
    const { token } = await makeProjectToken('p1', { permissions: ['project:read', 'project:update'] });
    expect((await withToken(token).patch('/projects/p1', { name: 'Renamed' })).status).toBe(200);
    expect(store.projects[0].name).toBe('Renamed');
    expect(deniedByToken(await withToken(token).delete('/projects/p1'))).toBe(true);
    expect(deniedByToken(await withToken(token).post('/projects/create', { name: 'x' }))).toBe(true);
    // Archiving is a user's own list: a project's token has none.
    expect(deniedByToken(await withToken(token).patch('/projects/p1/archive'))).toBe(true);
  });

  it('keeps working after whoever made it leaves the project, and its admins are told', async () => {
    store.projects[0].members.push({ userId: 'bea', role: 'admin', status: 'active' });
    const { token } = await makeProjectToken('p1', { permissions: ['project:read'] });
    expect((await asUser('bea').delete('/projects/p1/members/ada')).status).toBe(200);
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    expect(notified).toEqual([expect.objectContaining({ userId: 'bea', type: 'api_token_creator_left' })]);
    const list = await asUser('bea').get('/projects/p1/api-tokens');
    expect(list.body.apiTokens[0].createdBy).toEqual({ userId: 'ada', username: 'ada', isMember: false });
  });

  it('ends when revoked, or when its project is deleted', async () => {
    const one = await makeProjectToken('p1', { permissions: ['project:read'] });
    const two = await makeProjectToken('p1', { permissions: ['project:read'] });
    expect((await asUser('ada').delete(`/projects/p1/api-tokens/${one.apiToken.id}`)).status).toBe(204);
    expect((await withToken(one.token).get('/projects/p1')).status).toBe(401);
    expect((await asUser('ada').delete('/projects/p1')).status).toBe(200);
    expect(await resolveApiToken(two.token)).toBeNull();
  });

  it("can't be revoked through another project", async () => {
    store.projects[2].members.push({ userId: 'ada', role: 'admin', status: 'active' });
    const { token, apiToken } = await makeProjectToken('p1', { permissions: ['project:read'] });
    expect((await asUser('ada').delete(`/projects/p3/api-tokens/${apiToken.id}`)).status).toBe(404);
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
  });
});

describe('ending a token', () => {
  it('revoking it ends it at once', async () => {
    const { token, apiToken } = await makeToken({ permissions: ['project:read'], projectIds: ['p1'] });
    expect((await asUser('vic').delete(`/user/api-tokens/${apiToken.id}`)).status).toBe(404);
    expect((await asUser('eli').delete(`/user/api-tokens/${apiToken.id}`)).status).toBe(204);
    expect((await withToken(token).get('/projects/p1')).status).toBe(401);
  });

  it('once expired, it no longer works', async () => {
    const { token } = await createApiToken({ kind: 'user', userId: 'eli' }, { name: 'x', permissions: ['project:read'], projectIds: ['p1'], expiresInDays: 7 }, { databases: [] } as any);
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    store.api_tokens[0].expiresAt = new Date(Date.now() - 1000);
    expect((await withToken(token).get('/projects/p1')).status).toBe(401);
    expect(await resolveApiToken(token)).toBeNull();
  });

  it('an unknown or malformed one is refused', async () => {
    expect((await withToken(`${API_TOKEN_PREFIX}nope`).get('/projects/p1')).status).toBe(401);
    expect(await resolveApiToken('not-a-token')).toBeNull();
  });

  // Tokens from before kinds and permissions: replaced, with no migration.
  it('one made before tokens had a kind no longer works, nor is listed', async () => {
    const { token } = await makeToken({ permissions: ['project:read'], projectIds: ['p1'] });
    delete store.api_tokens[0].kind;
    store.api_tokens[0].access = 'write';
    expect(await resolveApiToken(token)).toBeNull();
    expect((await asUser('eli').get('/user/api-tokens')).body.apiTokens).toEqual([]);
  });
});

it("a session can't pass for a project's token", async () => {
  const res = await request(app).get('/projects').set('x-test-user', 'project-token:t1:p1');
  expect(res.status).toBe(401);
});

it('never writes a token in the logs', async () => {
  const { token } = await makeToken({ permissions: ['project:read', 'project:update'], projectIds: ['p1'] });
  await withToken(token).get('/projects/p1');
  await withToken(token).patch('/projects/p1', { name: 'X' });
  await withToken(`${token}x`).get('/projects/p1');
  expect(logged.some(line => line.includes(token.slice(4)))).toBe(false);
});
