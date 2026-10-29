import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FakeDb } from './fakeMongo';

// Production data lives in the NoSQL database (here in memory); projects in the models (here
// in memory too).
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
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
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

const app = express();
app.use(express.json());
app.use(createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
  authProvider: async (req: any) => ({ userId: req.headers['x-test-user'], username: req.headers['x-test-user'], role: 'viewer' as const }),
}));
const as = (user: string) => ({
  get: (p: string) => request(app).get(p).set('x-test-user', user),
  post: (p: string, body?: object) => request(app).post(p).set('x-test-user', user).send(body ?? {}),
  patch: (p: string, body?: object) => request(app).patch(p).set('x-test-user', user).send(body ?? {}),
  delete: (p: string) => request(app).delete(p).set('x-test-user', user),
});
const ada = as('ada');
const P = '/projects/p1/production';
const docs = (name: string) => mongo.db.docs(name);

const sequence = async (name = 'Opening') => (await ada.post(`${P}/sequences`, { name })).body.sequence;
const shot = async (seqId: string, body: object = {}) => (await ada.post(`${P}/sequences/${seqId}/shots`, { name: 'SH010', ...body })).body.shot;
const task = async (shotId: string, body: object = {}) => (await ada.post(`${P}/shots/${shotId}/tasks`, { name: 'Layout', ...body })).body.task;

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }, { userId: 'pat', role: 'editor', status: 'pending' }] },
    { _id: 'p2', id: 'p2', name: 'Other', dbType: 'sql', members: [{ userId: 'ada', role: 'admin', status: 'active' }] },
  ];
});
afterEach(() => vi.restoreAllMocks());

describe('creating', () => {
  it('a shot only in a sequence of the project, and a task only in a shot of it', async () => {
    const seq = await sequence();
    expect((await ada.post(`${P}/sequences/nope/shots`, { name: 'SH010' })).status).toBe(404);
    expect((await ada.post(`/projects/p2/production/sequences/${seq.id}/shots`, { name: 'SH010' })).status).toBe(404);
    const sh = await shot(seq.id);
    expect((await ada.post(`${P}/shots/nope/tasks`, { name: 'x' })).status).toBe(404);
    expect((await task(sh.id)).shotId).toBe(sh.id);
    expect(docs('production_shots')).toHaveLength(1);
    expect(docs('production_tasks')).toHaveLength(1);
  });

  it('checks what it is given', async () => {
    const seq = await sequence();
    const sh = await shot(seq.id);
    for (const [path, body] of [
      [`${P}/sequences`, {}],
      [`${P}/sequences`, { name: '   ' }],
      [`${P}/sequences/${seq.id}/shots`, { name: 'x', status: 'shipped' }],
      [`${P}/sequences/${seq.id}/shots`, { name: 'x', assignedTo: ['stranger'] }],
      [`${P}/sequences/${seq.id}/shots`, { name: 'x', assignedTo: ['pat'] }],
      [`${P}/sequences/${seq.id}/shots`, { name: 'x', dueDate: 'someday' }],
      [`${P}/shots/${sh.id}/tasks`, { name: 'x', priority: 'urgent' }],
      [`${P}/shots/${sh.id}/tasks`, { name: 'x', assignedTo: 'stranger' }],
    ] as [string, object][]) {
      expect((await ada.post(path, body)).status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('assigns members of the project', async () => {
    const sh = await shot((await sequence()).id, { assignedTo: ['eli', 'ada', 'eli'], dueDate: '2026-11-30' });
    expect(sh.assignedTo).toEqual(['eli', 'ada']);
    expect(new Date(sh.dueDate).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect((await task(sh.id, { assignedTo: 'vic' })).assignedTo).toBe('vic');
  });
});

describe('editing', () => {
  it('renames a sequence', async () => {
    const seq = await sequence();
    const res = await ada.patch(`${P}/sequences/${seq.id}`, { name: 'Prologue', description: 'Before the titles' });
    expect(res.body.sequence).toMatchObject({ name: 'Prologue', description: 'Before the titles' });
    expect((await ada.patch(`${P}/sequences/${seq.id}`, { name: '' })).status).toBe(400);
  });

  it("lists a sequence's shots with how their tasks go: done of total, and the top open priority", async () => {
    const seq = await sequence();
    const a = await shot(seq.id, { name: 'SH010' });
    await shot(seq.id, { name: 'SH020' });
    await task(a.id, { priority: 'low' });
    await task(a.id, { priority: 'medium' });
    await task(a.id, { priority: 'high', status: 'done' });
    const other = await shot((await sequence('Chase')).id);
    await task(other.id, { priority: 'high' });

    const { shots } = (await ada.get(`${P}/sequences/${seq.id}/shots`)).body;
    expect(shots.map((sh: any) => [sh.name, sh.taskSummary])).toEqual([
      ['SH010', { done: 1, total: 3, priority: 'medium' }],
      ['SH020', { done: 0, total: 0, priority: null }],
    ]);
  });

  it("changes a shot's name, description, due date and assignees", async () => {
    const sh = await shot((await sequence()).id);
    const res = await ada.patch(`${P}/shots/${sh.id}`, { name: 'SH011', description: 'Wide', dueDate: '2026-12-01', assignedTo: ['eli'] });
    expect(res.body.shot).toMatchObject({ name: 'SH011', description: 'Wide', assignedTo: ['eli'] });
    expect((await ada.patch(`${P}/shots/${sh.id}`, { dueDate: null, description: '' })).body.shot).toMatchObject({ dueDate: null, description: null });
    expect((await ada.patch(`${P}/shots/${sh.id}`, { assignedTo: ['stranger'] })).status).toBe(400);
  });

  it("changes a task's name, notes, due date and assignee", async () => {
    const t = await task((await shot((await sequence()).id)).id);
    const res = await ada.patch(`${P}/shots/${t.shotId}/tasks/${t.id}`, { name: 'Blocking', notes: 'Use the old rig', assignedTo: 'eli', dueDate: '2026-11-01' });
    expect(res.body.task).toMatchObject({ name: 'Blocking', notes: 'Use the old rig', assignedTo: 'eli' });
    expect((await ada.patch(`${P}/shots/${t.shotId}/tasks/${t.id}`, { assignedTo: null })).body.task.assignedTo).toBeNull();
  });

  it("a viewer can't", async () => {
    const seq = await sequence();
    expect((await as('vic').patch(`${P}/sequences/${seq.id}`, { name: 'x' })).status).toBe(403);
    expect((await as('vic').post(`${P}/sequences/${seq.id}/shots`, { name: 'x' })).status).toBe(403);
  });
});

describe('deleting', () => {
  it('a sequence takes its shots, their tasks and deliverables, and nothing of other sequences', async () => {
    const [a, b] = [await sequence('A'), await sequence('B')];
    const [a1, b1] = [await shot(a.id), await shot(b.id)];
    await task(a1.id); await task(b1.id);
    docs('deliverables').push({ id: 'd1', projectId: 'p1', assetId: 'x', shotId: a1.id }, { id: 'd2', projectId: 'p1', assetId: 'x', shotId: b1.id });

    expect((await ada.delete(`${P}/sequences/${a.id}`)).status).toBe(200);
    expect(docs('production_sequences').map((s: any) => s.id)).toEqual([b.id]);
    expect(docs('production_shots').map((s: any) => s.id)).toEqual([b1.id]);
    expect(docs('production_tasks').map((t: any) => t.shotId)).toEqual([b1.id]);
    expect(docs('deliverables').map((d: any) => d.id)).toEqual(['d2']);
    expect((await ada.delete(`${P}/sequences/${a.id}`)).status).toBe(404);
  });

  it('a shot takes its tasks', async () => {
    const seq = await sequence();
    const [one, two] = [await shot(seq.id), await shot(seq.id)];
    await task(one.id); await task(two.id);
    await ada.delete(`${P}/shots/${one.id}`);
    expect(docs('production_tasks').map((t: any) => t.shotId)).toEqual([two.id]);
  });

  it("a project takes its production data, and no other project's", async () => {
    const own = await shot((await sequence()).id);
    await task(own.id);
    const other = (await ada.post('/projects/p2/production/sequences', { name: 'Kept' })).body.sequence;
    await ada.post(`/projects/p2/production/sequences/${other.id}/shots`, { name: 'Kept' });
    expect((await ada.delete('/projects/p1')).status).toBe(200);
    for (const name of ['production_sequences', 'production_shots', 'production_tasks']) {
      expect(docs(name).every((d: any) => d.projectId === 'p2'), name).toBe(true);
    }
    expect(docs('production_sequences')).toHaveLength(1);
  });
});

it('a project says whether it has production data', async () => {
  expect((await ada.get('/projects/p1')).body.project.hasProductionData).toBe(false);
  await sequence();
  expect((await ada.get('/projects/p1')).body.project.hasProductionData).toBe(true);
});
