import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStreamByRouter } from '../src/middleware/createRouter';
import { mockAuthProvider } from './mocks/mockAuth';
import { mockAdapter } from './mocks/mockAdapter';

const mockProjectProvider = {
  getById: async (id: string) => ({
    id,
    name: 'Test Project',
    description: 'Mock project for testing',
    rootFolders: [],
    settings: { allowUpload: true }
  }),
  create: async (data: any) => ({
    id: 'mock-project-id',
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
    authProvider: mockAuthProvider,
    adapter: mockAdapter,
    projectProvider: mockProjectProvider,
  })
);

describe('GET /streamby/files', () => {
  it('should return mocked file list for authorized project', async () => {
    const res = await request(app).get('/streamby/files?projectId=test-project');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]?.key).toContain('test-project/');
  });

  it('should return 403 for unauthorized project', async () => {
    const res = await request(app).get('/streamby/files?projectId=unauthorized-project');
    expect(res.status).toBe(403);
  });

  it('should return 403 if no projectId is provided', async () => {
    const res = await request(app).get('/streamby/files');
    expect(res.status).toBe(403);
  });
});
