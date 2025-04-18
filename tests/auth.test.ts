import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStreamByRouter } from '../src/middleware/createRouter';
import { mockAdapter } from './mocks/mockAdapter';
import { mockAuthProvider } from './mocks/mockAuth';

const mockProjectProvider = {
  getById: async (id: string) => ({
    id,
    name: 'Mock Project',
    description: '',
    rootFolders: [],
    settings: { allowUpload: true }
  }),
  create: async (data: any) => ({
    id: 'mock-id',
    ...data
  })
};

const app = express();
app.use(express.json());

app.use(
  '/streamby',
  createStreamByRouter({
    storageProvider: {
      type: 's3',
      config: {} as any,
    },
    adapter: mockAdapter,
    authProvider: mockAuthProvider,
    projectProvider: mockProjectProvider
  })
);

describe('GET /streamby/auth', () => {
  it('should return user auth data if valid session', async () => {
    const res = await request(app).get('/streamby/auth');
    expect(res.status).toBe(200);
    expect(res.body.logged).toBe(true);
    expect(res.body.userId).toBe('test-user');
    expect(res.body.projects).toContain('test-project');
  });
});
