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

const B = `${P}/board`;
const columnsOf = async (user = ada) => (await user.get(B)).body.columns;
const view = (columns: any[]) => columns.map((c: any) => `${c.name}:${c.status}`);
const shotsOf = async (seqId: string) => (await ada.get(`${P}/sequences/${seqId}/shots`)).body.shots;

describe("a project's board", () => {
  it('starts with a column per status, and its existing cards in the column of their status', async () => {
    expect(view(await columnsOf())).toEqual(['To do:todo', 'In progress:in_progress', 'Review:review', 'Done:done']);
    const seq = await sequence();
    // Saved before columns existed: no columnId.
    mongo.db.collection('production_shots').docs.push(
      { id: 'old-1', sequenceId: seq.id, projectId: 'p1', name: 'Old review', status: 'review', order: 0, createdAt: new Date(1) },
      { id: 'old-2', sequenceId: seq.id, projectId: 'p1', name: 'Old done', status: 'done', order: 1, createdAt: new Date(2) },
    );
    expect((await shotsOf(seq.id)).map((s: any) => [s.name, s.columnId, s.status])).toEqual([['Old review', 'review', 'review'], ['Old done', 'done', 'done']]);
  });

  it('adds a QA column in in_progress, moves it among the others, and renames it', async () => {
    const added = await ada.post(`${B}/columns`, { name: ' QA ', status: 'in_progress' });
    expect(added.status).toBe(201);
    expect(view(added.body.columns)).toEqual(['To do:todo', 'In progress:in_progress', 'Review:review', 'Done:done', 'QA:in_progress']);
    const qa = added.body.columns.at(-1).id;

    const ids = added.body.columns.map((c: any) => c.id);
    const order = ['todo', 'in_progress', qa, 'review', 'done'];
    expect(view((await ada.patch(B, { order })).body.columns)).toEqual(['To do:todo', 'In progress:in_progress', 'QA:in_progress', 'Review:review', 'Done:done']);
    expect(ids).toHaveLength(5);

    expect(view((await ada.patch(`${B}/columns/${qa}`, { name: 'Quality' })).body.columns)).toContain('Quality:in_progress');
    expect(view(await columnsOf())).toEqual(['To do:todo', 'In progress:in_progress', 'Quality:in_progress', 'Review:review', 'Done:done']);
  });

  it('a card moved to QA takes its status, in_progress', async () => {
    const qa = (await ada.post(`${B}/columns`, { name: 'QA', status: 'in_progress' })).body.columns.at(-1).id;
    const sh = await shot((await sequence()).id);
    expect(sh).toMatchObject({ columnId: 'todo', status: 'todo' });
    const moved = await ada.patch(`${P}/shots/${sh.id}`, { columnId: qa });
    expect(moved.body.shot).toMatchObject({ columnId: qa, status: 'in_progress' });
    expect(docs('production_shots')[0]).toMatchObject({ columnId: qa, status: 'in_progress' });
    // Given the status it has, it stays in its column.
    expect((await ada.patch(`${P}/shots/${sh.id}`, { status: 'in_progress', name: 'SH011' })).body.shot).toMatchObject({ columnId: qa, status: 'in_progress' });
  });

  it('a card given a status goes to the first column of it; one given another column\'s status, or a column that isn\'t, is refused', async () => {
    const triage = (await ada.post(`${B}/columns`, { name: 'Triage', status: 'review', position: 0 })).body.columns[0].id;
    const seq = await sequence();
    expect(await shot(seq.id, { status: 'review' })).toMatchObject({ columnId: triage, status: 'review' });
    const sh = await shot(seq.id);
    expect((await ada.patch(`${P}/shots/${sh.id}`, { status: 'done' })).body.shot).toMatchObject({ columnId: 'done', status: 'done' });
    expect((await ada.patch(`${P}/shots/${sh.id}`, { columnId: 'review', status: 'todo' })).status).toBe(400);
    expect((await ada.patch(`${P}/shots/${sh.id}`, { columnId: 'nope' })).status).toBe(400);
    expect((await ada.post(`${P}/sequences/${seq.id}/shots`, { name: 'X', columnId: 'nope' })).status).toBe(400);
  });

  it('a column put before an existing one of the same status leaves its cards where they were', async () => {
    const seq = await sequence();
    mongo.db.collection('production_shots').docs.push({ id: 'old', sequenceId: seq.id, projectId: 'p1', name: 'Old', status: 'todo', order: 0, createdAt: new Date() });
    await ada.post(`${B}/columns`, { name: 'Backlog', status: 'todo', position: 0 });
    expect((await shotsOf(seq.id))[0]).toMatchObject({ columnId: 'todo', status: 'todo' });
  });

  it('deleting a column with cards needs where to move them, which take its status', async () => {
    const qa = (await ada.post(`${B}/columns`, { name: 'QA', status: 'in_progress' })).body.columns.at(-1).id;
    const seq = await sequence();
    const sh = await shot(seq.id, { columnId: qa });
    const refused = await ada.delete(`${B}/columns/${qa}`);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/moveTo/);
    expect((await ada.delete(`${B}/columns/${qa}?moveTo=${qa}`)).status).toBe(400);

    const deleted = await ada.delete(`${B}/columns/${qa}?moveTo=review`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ moved: 1 });
    expect(view(deleted.body.columns)).toEqual(['To do:todo', 'In progress:in_progress', 'Review:review', 'Done:done']);
    expect((await shotsOf(seq.id)).find((s: any) => s.id === sh.id)).toMatchObject({ columnId: 'review', status: 'review' });
  });

  it('deletes a column without cards, but never the last of a status', async () => {
    const qa = (await ada.post(`${B}/columns`, { name: 'QA', status: 'in_progress' })).body.columns.at(-1).id;
    expect((await ada.delete(`${B}/columns/${qa}`)).status).toBe(200);
    for (const id of ['todo', 'in_progress', 'review', 'done']) {
      const res = await ada.delete(`${B}/columns/${id}?moveTo=todo`);
      expect(res.status, id).toBe(400);
      expect(res.body.message).toMatch(/at least one column/);
    }
    // Nor by giving it another status.
    expect((await ada.patch(`${B}/columns/done`, { status: 'review' })).status).toBe(400);
  });

  it("a column given another status gives it to its cards", async () => {
    const extra = (await ada.post(`${B}/columns`, { name: 'Extra', status: 'todo' })).body.columns.at(-1).id;
    const sh = await shot((await sequence()).id, { columnId: extra });
    expect((await ada.patch(`${B}/columns/${extra}`, { status: 'done' })).status).toBe(200);
    expect(docs('production_shots').find((s: any) => s.id === sh.id)).toMatchObject({ columnId: extra, status: 'done' });
  });

  it("checks what a column is given, and an order that isn't every column once", async () => {
    expect((await ada.post(`${B}/columns`, { name: '  ', status: 'todo' })).status).toBe(400);
    expect((await ada.post(`${B}/columns`, { name: 'QA', status: 'later' })).status).toBe(400);
    expect((await ada.patch(`${B}/columns/nope`, { name: 'X' })).status).toBe(404);
    for (const order of [['todo'], ['todo', 'todo', 'review', 'done'], ['todo', 'in_progress', 'review', 'nope'], 'todo']) {
      expect((await ada.patch(B, { order })).status, JSON.stringify(order)).toBe(400);
    }
  });

  it('editors change it; viewers only see it', async () => {
    expect((await as('eli').post(`${B}/columns`, { name: 'QA', status: 'review' })).status).toBe(201);
    expect((await as('vic').post(`${B}/columns`, { name: 'No', status: 'review' })).status).toBe(403);
    expect((await as('vic').patch(B, { order: [] })).status).toBe(403);
    expect(view(await columnsOf(as('vic')))).toContain('QA:review');
    expect((await as('pat').get(B)).status).toBe(403);
  });

  it("is each project's own, and goes with it", async () => {
    await ada.post(`${B}/columns`, { name: 'QA', status: 'review' });
    expect(view((await ada.get('/projects/p2/production/board')).body.columns)).not.toContain('QA:review');
    expect((await ada.delete('/projects/p1')).status).toBe(200);
    expect(docs('production_boards')).toEqual([]);
  });
});
