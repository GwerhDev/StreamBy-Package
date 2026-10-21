import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// The projects there are, in memory; every other model answers empty. Nothing is connected.
const projects = new Map<string, any>();
const deleted: string[] = [];
const fakeModel = (name: string): any => {
  const model: any = {
    find: async () => (name === 'projects' ? [...projects.values()] : []),
    findOne: async (q: any) => (name === 'projects' ? projects.get(q?._id) ?? null : null),
    create: async (doc: any) => doc,
    update: async () => ({}),
    delete: async (q: any) => { deleted.push(q?._id); },
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
const { createJob } = await import('../src/services/jobQueue');

// A user signed in, with a platform role of their own (never what decides in a project).
const as = (userId: string, role: 'viewer' | 'admin' = 'viewer') => {
  const app = express();
  app.use(express.json());
  app.use(createStreamByRouter({
    storageProviders: [],
    adapter: { getPresignedProjectImageUrl: async () => ({}) } as any,
    databases: [{ id: 'mongo', type: 'nosql', main: true }],
    authProvider: async () => ({ userId, username: userId, role } as any),
  }));
  return request(app);
};

beforeEach(() => {
  projects.clear();
  deleted.length = 0;
  projects.set('p1', {
    _id: 'p1', id: 'p1', name: 'P', dbType: 'nosql', members: [
      { userId: 'ada', role: 'admin', status: 'active' },
      { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' },
      { userId: 'pat', role: 'admin', status: 'pending' },
      { userId: 'arc', role: 'admin', status: 'active', archived: true },
    ],
  });
});

describe('deleting a project', () => {
  it('is for its admins only', async () => {
    for (const user of ['eli', 'vic', 'pat', 'outsider']) {
      expect((await as(user).delete('/projects/p1')).status, user).toBe(403);
    }
    expect(deleted).toEqual([]);
    expect((await as('ada').delete('/projects/p1')).status).toBe(200);
    expect(deleted).toEqual(['p1']);
  });

  it('is not for a platform admin who is not an admin of it', async () => {
    expect((await as('outsider', 'admin').delete('/projects/p1')).status).toBe(403);
  });

  // A member's archived flag is only them having archived it in their own list.
  it('is for an admin who archived it in their list', async () => {
    expect((await as('arc').delete('/projects/p1')).status).toBe(200);
  });
});

describe('managing members', () => {
  it('is for the project\'s admins, whatever the platform role', async () => {
    for (const user of ['eli', 'vic', 'pat']) {
      expect((await as(user, 'admin').post('/projects/p1/members').send({ userId: 'new', role: 'viewer' })).status, user).toBe(403);
    }
    expect((await as('ada').post('/projects/p1/members').send({ userId: 'new', role: 'viewer' })).status).not.toBe(403);
  });
});

describe('changing a project and its connections', () => {
  it('is for its editors and admins, not its viewers nor someone pending', async () => {
    for (const user of ['vic', 'pat', 'outsider']) {
      expect((await as(user).patch('/projects/p1').send({ name: 'X' })).status, user).toBe(403);
      expect((await as(user).post('/projects/p1/connections').send({ name: 'c', apiUrl: 'https://api.example.com', method: 'GET' })).status, user).toBe(403);
    }
    for (const user of ['eli', 'ada']) {
      expect((await as(user).patch('/projects/p1').send({ name: 'X' })).status, user).not.toBe(403);
      expect((await as(user).post('/projects/p1/connections').send({ name: 'c', apiUrl: 'https://api.example.com', method: 'GET' })).status, user).not.toBe(403);
    }
  });

  it("asks for the project's role to change its image", async () => {
    expect((await as('vic').get('/upload-project-image-url/p1')).status).toBe(403);
    expect((await as('eli').get('/upload-project-image-url/p1')).status).not.toBe(403);
  });
});

describe("seeing a job", () => {
  it("is for whoever started it, or a member of its project", async () => {
    const job = createJob('ingest', 'vic', 'p1', {});
    expect((await as('vic').get(`/jobs/${job.jobId}`)).status).toBe(200);
    expect((await as('eli').get(`/jobs/${job.jobId}`)).status).toBe(200);
    // Someone else's job is as if it didn't exist.
    expect((await as('outsider').get(`/jobs/${job.jobId}`)).status).toBe(404);
    expect((await as('pat').get(`/jobs/${job.jobId}`)).status).toBe(404);
  });
});
