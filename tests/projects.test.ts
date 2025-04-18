import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStreamByRouter } from '../src/middleware/createRouter';
import { mockAuthProvider } from './mocks/mockAuth';
import { mockAdapter } from './mocks/mockAdapter';

const mockProjectProvider = {
  getById: async (id: string) => ({
    id,
    name: 'Mock Project',
    description: 'A mock project',
    rootFolders: [],
    settings: {
      allowUpload: true,
      allowSharing: false,
    },
  }),
  create: async (data: any) => ({
    id: 'mock-id',
    ...data,
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
    projectProvider: mockProjectProvider,
    adapter: mockAdapter,
  })
);

describe('POST /streamby/projects', () => {
  it('should create a new project and return its data', async () => {
    const res = await request(app).post('/streamby/projects').send({
      name: 'New Project',
      description: 'Some description',
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('project');
    expect(res.body.project.name).toBe('New Project');
  });
});