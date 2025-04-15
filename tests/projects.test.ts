import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStreamByRouter } from '../src/middleware/createRouter';
import { mockAuthProvider } from './mocks/mockAuth';
import { mockAdapter } from './mocks/mockAdapter';

const app = express();

app.use(
  '/streamby',
  createStreamByRouter({
    storageProvider: {
      type: 's3',
      config: {} as any,
    },
    authProvider: mockAuthProvider,
    adapter: mockAdapter,
    projectProvider: async (id: string) => ({
      id,
      name: 'Mock Project',
      description: 'Test project metadata',
      rootFolders: [
        {
          id: 'folder-1',
          name: 'Assets',
          children: []
        }
      ],
      settings: {
        allowUpload: true,
        allowSharing: false
      }
    })
  })
);

describe('GET /streamby/projects/:id', () => {
  it('should return project metadata if user has access', async () => {
    const res = await request(app).get('/streamby/projects/test-project');
    expect(res.status).toBe(200);
    expect(res.body.project).toBeDefined();
    expect(res.body.project.id).toBe('test-project');
    expect(res.body.project.name).toBe('Mock Project');
  });

  it('should return 403 if user does not have access to the project', async () => {
    const res = await request(app).get('/streamby/projects/unauthorized-project');
    expect(res.status).toBe(403);
  });
});
