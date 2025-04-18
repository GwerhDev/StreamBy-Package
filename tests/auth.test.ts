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
    image: '',
    rootFolders: [],
    settings: { allowUpload: true, allowSharing: false }
  }),
  create: async (data: any) => ({
    id: 'mock-id',
    name: data.name,
    description: data.description,
    image: '',
    rootFolders: [],
    settings: { allowUpload: true, allowSharing: false }
  }),
  getPresignedUrl: async (projectId: string, filename: string, type: string) => ({
    url: `https://mock-s3.com/${projectId}/${filename}`,
    key: `${projectId}/${filename}`
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
