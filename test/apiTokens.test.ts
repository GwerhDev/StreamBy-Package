import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Records in memory, by model: found by their fields, written as given.
const store: Record<string, any[]> = {};
const matches = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matches(r, filter)),
    findOne: async (filter: any) => rows().find(r => matches(r, filter)) ?? null,
    create: async (doc: any) => { const { dbType: _d, ...row } = doc; rows().push(row); return row; },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matches(r, filter));
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
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

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/index').then(async (index) => ({
  ...index, ...(await import('../src/services/apiTokens')),
}));

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
      return { userId: resolved.userId, username: resolved.userId, role: 'viewer', apiToken: resolved.scope };
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
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  patch: (p: string, body?: object) => request(app).patch(p).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  post: (p: string, body?: object) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(body ?? {}),
});
const makeToken = async (body: object, user = 'eli') => {
  const res = await asUser(user).post('/user/api-tokens', { name: 'agent', ...body });
  expect(res.status).toBe(201);
  return res.body as { token: string; apiToken: any };
};

const project = (id: string, members: object[]) => ({ _id: id, id, name: id, dbType: 'sql', members });
let logged: string[] = [];
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    project('p1', [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }]),
    project('p2', [{ userId: 'eli', role: 'editor', status: 'active' }]),
    project('p3', [{ userId: 'someone', role: 'admin', status: 'active' }]),
  ];
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});
afterEach(() => vi.restoreAllMocks());

describe('making a token', () => {
  it('shows it once; only its hash is kept, and the list never shows it', async () => {
    const { token, apiToken } = await makeToken({ access: 'read', projectIds: ['p1'], expiresInDays: 30 });
    expect(token).toMatch(/^sbt_[A-Za-z0-9_-]{43}$/);
    expect(apiToken).toMatchObject({ name: 'agent', access: 'read', projectIds: ['p1'], prefix: token.slice(0, 12) });
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
    await makeToken({ access: 'read', projectIds: '*' });
    await makeToken({ access: 'read', projectIds: ['p1'] });
    expect(store.api_tokens.map(t => t.projectIds)).toEqual([['*'], ['p1']]);
    expect((await asUser('eli').post('/user/api-tokens', { name: 'x', access: 'read', projectIds: ['*'] })).status).toBe(400);
    await expect(createApiToken('eli', { name: 'x', access: 'read', projectIds: ['*'], expiresInDays: 7 }, { databases: [] } as any)).rejects.toThrow();
  });

  it('reaches only projects its owner is in', async () => {
    const res = await asUser('eli').post('/user/api-tokens', { name: 'x', access: 'read', projectIds: ['p1', 'p3'] });
    expect(res.status).toBe(400);
    expect(store.api_tokens ?? []).toHaveLength(0);
  });

  it('takes only a known expiry, or none', async () => {
    expect((await asUser('eli').post('/user/api-tokens', { name: 'x', access: 'read', projectIds: '*', expiresInDays: 5 })).status).toBe(400);
    const { apiToken } = await makeToken({ access: 'read', projectIds: '*', expiresInDays: null });
    expect(apiToken.expiresAt).toBeNull();
  });
});

describe('using a token', () => {
  it('a read token reads, and never writes', async () => {
    const { token } = await makeToken({ access: 'read', projectIds: ['p1'] });
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    expect((await withToken(token).patch('/projects/p1', { name: 'X' })).status).toBe(403);
    expect((await withToken(token).post('/projects/p1/exports', { name: 'e' })).status).toBe(403);
  });

  it('a write token writes, as far as its owner can', async () => {
    const { token } = await makeToken({ access: 'write', projectIds: ['p1'] });
    expect((await withToken(token).patch('/projects/p1', { name: 'X' })).status).toBe(200);
    // Vic is a viewer of p1: their token never does more.
    const viewers = await makeToken({ access: 'write', projectIds: ['p1'] }, 'vic');
    expect((await withToken(viewers.token).patch('/projects/p1', { name: 'X' })).status).toBe(403);
  });

  it("a project's token doesn't see another, nor lists it", async () => {
    const { token } = await makeToken({ access: 'write', projectIds: ['p1'] });
    expect((await withToken(token).get('/projects/p2')).status).toBe(404);
    expect((await withToken(token).patch('/projects/p2', { name: 'X' })).status).toBe(404);
    const list = await withToken(token).get('/projects');
    expect(list.body.projects.map((p: any) => p.id)).toEqual(['p1']);
  });

  it("an all-projects token reaches every project its owner is in, those joined later too", async () => {
    const { token } = await makeToken({ access: 'read', projectIds: '*' });
    expect((await withToken(token).get('/projects')).body.projects.map((p: any) => p.id).sort()).toEqual(['p1', 'p2']);
    store.projects[2].members.push({ userId: 'eli', role: 'viewer', status: 'active' });
    expect((await withToken(token).get('/projects/p3')).status).toBe(200);
  });

  it('stops working once its owner loses the project', async () => {
    const { token } = await makeToken({ access: 'read', projectIds: ['p1'] }, 'vic');
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    store.projects[0].members = store.projects[0].members.filter((m: any) => m.userId !== 'vic');
    expect((await withToken(token).get('/projects/p1')).status).toBe(403);
  });

  it("can't manage tokens, nor reach what's outside a project but a few reads", async () => {
    const { token } = await makeToken({ access: 'write', projectIds: '*' });
    expect((await withToken(token).get('/user/api-tokens')).status).toBe(403);
    expect((await withToken(token).post('/user/api-tokens', { name: 'more', access: 'write', projectIds: '*' })).status).toBe(403);
    expect((await withToken(token).post('/projects/create', { name: 'new' })).status).toBe(403);
    expect((await withToken(token).get('/user/integrations')).status).toBe(403);
    expect((await withToken(token).get('/auth')).status).toBe(200);
  });

  it('marks when it was last used', async () => {
    const { token } = await makeToken({ access: 'read', projectIds: ['p1'] });
    expect(store.api_tokens[0].lastUsedAt).toBeNull();
    await withToken(token).get('/projects/p1');
    await vi.waitFor(() => expect(store.api_tokens[0].lastUsedAt).toBeInstanceOf(Date));
  });
});

describe('ending a token', () => {
  it('revoking it ends it at once', async () => {
    const { token, apiToken } = await makeToken({ access: 'read', projectIds: ['p1'] });
    expect((await asUser('vic').delete(`/user/api-tokens/${apiToken.id}`)).status).toBe(404);
    expect((await asUser('eli').delete(`/user/api-tokens/${apiToken.id}`)).status).toBe(204);
    expect((await withToken(token).get('/projects/p1')).status).toBe(401);
  });

  it('once expired, it no longer works', async () => {
    const { token } = await createApiToken('eli', { name: 'x', access: 'read', projectIds: ['p1'], expiresInDays: 7 }, { databases: [] } as any);
    expect((await withToken(token).get('/projects/p1')).status).toBe(200);
    store.api_tokens[0].expiresAt = new Date(Date.now() - 1000);
    expect((await withToken(token).get('/projects/p1')).status).toBe(401);
    expect(await resolveApiToken(token)).toBeNull();
  });

  it('an unknown or malformed one is refused', async () => {
    expect((await withToken(`${API_TOKEN_PREFIX}nope`).get('/projects/p1')).status).toBe(401);
    expect(await resolveApiToken('not-a-token')).toBeNull();
  });
});

it('never writes a token in the logs', async () => {
  const { token } = await makeToken({ access: 'write', projectIds: ['p1'] });
  await withToken(token).get('/projects/p1');
  await withToken(token).patch('/projects/p1', { name: 'X' });
  await withToken(`${token}x`).get('/projects/p1');
  expect(logged.some(line => line.includes(token.slice(4)))).toBe(false);
});
