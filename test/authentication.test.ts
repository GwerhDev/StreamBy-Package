import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// No databases reached: the routers are the real ones, their models registered, only nothing
// is connected (a request that gets past authentication fails further on, not with a 401).
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/database/connectionManager')>()),
  initConnections: async () => {},
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { isPublicRoute } = await import('../src/services/auth');

const appWith = (signedIn: boolean) => {
  const app = express();
  app.use(createStreamByRouter({
    storageProviders: [],
    adapter: {} as any,
    databases: [{ id: 'mongo', type: 'nosql', main: true }],
    authProvider: async () => (signedIn ? { userId: 'u1', role: 'viewer' } as any : null),
  }));
  return app;
};

describe('isPublicRoute', () => {
  it('is only the public export route, read', () => {
    expect(isPublicRoute('GET', '/p1/export/menu')).toBe(true);
    expect(isPublicRoute('GET', '/p1/export/menu/')).toBe(true);
    expect(isPublicRoute('OPTIONS', '/p1/export/menu')).toBe(true);
  });

  it('is no other path with an export segment, nor a write', () => {
    for (const path of ['/projects/p1/storage/export/x', '/p1/export/menu/extra', '/export/menu', '/a/b/export/c', '/p1/exports/menu', '/p1/export/']) {
      expect(isPublicRoute('GET', path), path).toBe(false);
    }
    expect(isPublicRoute('POST', '/p1/export/menu')).toBe(false);
    expect(isPublicRoute('DELETE', '/p1/export/menu')).toBe(false);
  });
});

describe('authenticate, in the mounted router', () => {
  it('asks for a session to search users', async () => {
    const res = await request(appWith(false)).get('/users/search?q=a');
    expect(res.status).toBe(401);
  });

  it('asks for a session on any path with an export segment but the public one', async () => {
    for (const path of ['/projects/p1/exports/e1', '/projects/p1/storage/export/x', '/p1/export/menu/extra']) {
      expect((await request(appWith(false)).get(path)).status, path).toBe(401);
    }
    expect((await request(appWith(false)).post('/p1/export/menu')).status).toBe(401);
  });

  it('lets the public export route through without one', async () => {
    const res = await request(appWith(false)).get('/p1/export/menu');
    expect(res.status).not.toBe(401);
  });

  it('answers /auth either way', async () => {
    expect((await request(appWith(false)).get('/auth')).status).toBe(401);
    expect((await request(appWith(true)).get('/auth')).status).toBe(200);
  });
});
