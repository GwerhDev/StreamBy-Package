import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import { FakeDb } from './fakeMongo';

// Review notes and production data live in the NoSQL database (here in memory); projects and
// tokens in the models (here in memory too).
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
const events = vi.hoisted(() => [] as { userId: string; event: any }[]);
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: (userId: string, event: any) => { events.push({ userId, event }); } }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');

const authProvider = async (req: any) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (!bearer?.startsWith(API_TOKEN_PREFIX)) throw new Error('No session');
  const resolved = await resolveApiToken(bearer);
  if (!resolved) throw new Error('Invalid API token');
  return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({ storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider }));

const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;

let server: http.Server;
let base = '';
beforeEach(async () => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
});

const connect = async (token: string) => {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const call = (client: Client, name: string, args: object) => client.callTool({ name, arguments: args as any }) as Promise<any>;

const N = '/streamby/projects/p1/assets/a1/versions/v2/annotations';
const asToken = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, body: object = {}) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(body),
});
const card = (id: string, assetId: string, extra: object = {}) =>
  mongo.db.collection('production_shots').docs.push({ id, key: `POR-${id}`, name: `Card ${id}`, projectId: 'p1', sequenceId: 's1', assetId, status: 'todo', ...extra });

describe('review notes on a moment of an audio version', () => {
  it('a note is on an instant or a range, its time read as a clock; a time out of place is refused', async () => {
    const eli = asToken(await tokenFor(['assets:write', 'assets:read']));
    const at = await eli.post(N, { type: 'timecoded', startSeconds: 83.4, text: 'The bass covers the vocal' });
    expect(at.status).toBe(201);
    expect(at.body.annotation).toMatchObject({ assetVersionId: 'v2', startSeconds: 83.4, timecode: '1:23', resolved: false });
    expect(at.body.annotation.endSeconds).toBeUndefined();
    const range = await eli.post(N, { type: 'timecoded', startSeconds: 83, endSeconds: 100.9, text: 'Too much reverb' });
    expect(range.body.annotation).toMatchObject({ startSeconds: 83, endSeconds: 100.9, timecode: '1:23–1:40' });
    for (const time of [{}, { startSeconds: -1 }, { startSeconds: '83' }, { startSeconds: 10, endSeconds: 10 }, { startSeconds: 10, endSeconds: 4 }]) {
      expect((await eli.post(N, { type: 'timecoded', text: 'x', ...time })).status).toBe(400);
    }
    // Only that version's.
    const listed = (await eli.get(N)).body.annotations;
    expect(listed.map((n: any) => n.timecode)).toEqual(['1:23', '1:23–1:40']);
    expect((await eli.get('/streamby/projects/p1/assets/a1/versions/v1/annotations')).body.annotations).toEqual([]);
  });

  it("a note past the end of its file is refused, when it's known how long the file lasts", async () => {
    const eli = asToken(await tokenFor(['assets:write']));
    // Not measured yet: any time is taken.
    expect((await eli.post(N, { type: 'timecoded', startSeconds: 540, text: 'Unknown length' })).status).toBe(201);
    mongo.db.collection('asset_versions').docs.push({ versionId: 'v2', assetId: 'a1', projectId: 'p1', version: 2, measurements: { kind: 'audio', duration: 180 } });
    const past = await eli.post(N, { type: 'timecoded', startSeconds: 540, text: 'At 9:00' });
    expect([past.status, past.body.message]).toEqual([400, 'The note is past the end of the file, which lasts 3:00 (180 s)']);
    expect((await eli.post(N, { type: 'timecoded', startSeconds: 170, endSeconds: 181, text: 'Runs past it' })).status).toBe(400);
    expect((await eli.post(N, { type: 'timecoded', startSeconds: 170, endSeconds: 180, text: 'To the end' })).status).toBe(201);
    expect(mongo.db.docs('annotations').map((n: any) => n.text)).toEqual(['Unknown length', 'To the end']);
  });

  it("a note's members hear of it, so whoever has the review open reads it again", async () => {
    events.length = 0;
    const eli = asToken(await tokenFor(['assets:write']));
    await eli.post(N, { type: 'timecoded', startSeconds: 5, text: 'Click at the start' });
    expect(events.filter(e => e.event.type === 'annotationEvent').map(e => [e.userId, e.event.data])).toEqual([
      ['eli', { projectId: 'p1', assetId: 'a1', assetVersionId: 'v2' }],
      ['vic', { projectId: 'p1', assetId: 'a1', assetVersionId: 'v2' }],
    ]);
  });

  it("becomes a task of the asset's card, its time in the name; once", async () => {
    card('c1', 'a1');
    card('c9', 'other');
    const eli = asToken(await tokenFor(['assets:write', 'production:write']));
    const note = (await eli.post(N, { type: 'timecoded', startSeconds: 83, endSeconds: 91, text: 'The bass\n covers the vocal' })).body.annotation;
    const made = await eli.post(`${N}/${note.id}/task`);
    expect(made.status).toBe(201);
    expect(made.body.task).toMatchObject({ shotId: 'c1', name: '[1:23–1:31] The bass covers the vocal', status: 'todo', createdBy: 'eli' });
    expect(made.body.task.notes).toBe('Review note at 1:23–1:31 of version v2:\nThe bass\n covers the vocal');
    expect(mongo.db.docs('production_tasks').map((t: any) => t.shotId)).toEqual(['c1']);
    expect(mongo.db.docs('annotations')[0]).toMatchObject({ taskId: made.body.task.id, shotId: 'c1' });
    expect((await eli.post(`${N}/${note.id}/task`)).status).toBe(409);
    expect(mongo.db.docs('production_tasks')).toHaveLength(1);
  });

  it('with no card linked it can\'t; with several, the one given', async () => {
    const eli = asToken(await tokenFor(['assets:write', 'production:write']));
    const note = (await eli.post(N, { type: 'timecoded', startSeconds: 1, text: 'Hiss' })).body.annotation;
    const none = await eli.post(`${N}/${note.id}/task`);
    expect([none.status, none.body.message]).toEqual([409, 'No card on the board is linked to this asset']);
    card('c1', 'a1');
    card('c2', 'a1');
    const several = await eli.post(`${N}/${note.id}/task`);
    expect(several.status).toBe(409);
    expect(several.body.shots.map((s: any) => s.id)).toEqual(['c1', 'c2']);
    expect((await eli.post(`${N}/${note.id}/task`, { shotId: 'c9' })).status).toBe(400);
    const chosen = await eli.post(`${N}/${note.id}/task`, { shotId: 'c2' });
    expect([chosen.status, chosen.body.task.shotId]).toEqual([201, 'c2']);
  });

  it('a task needs production:write; a note without a time never becomes one', async () => {
    card('c1', 'a1');
    const writer = asToken(await tokenFor(['assets:write']));
    const note = (await writer.post(N, { type: 'timecoded', startSeconds: 1, text: 'Hiss' })).body.annotation;
    expect((await writer.post(`${N}/${note.id}/task`)).status).toBe(403);
    const producer = asToken(await tokenFor(['assets:write', 'production:write']));
    const spatial = (await producer.post(N, { type: 'spatial', position3d: { x: 0, y: 0, z: 0 }, text: 'Here' })).body.annotation;
    expect((await producer.post(`${N}/${spatial.id}/task`)).status).toBe(400);
    expect(mongo.db.docs('production_tasks')).toHaveLength(0);
  });
});

describe('review notes through MCP', () => {
  it('an agent finds the review, leaves a note on a moment of its version and reads it back', async () => {
    mongo.db.collection('review_sessions').docs.push({
      id: 'r1', projectId: 'p1', assetId: 'a1', assetVersionId: 'v2', status: 'open', requiredApprovers: 1, approvals: [], createdAt: new Date(), updatedAt: new Date(),
    });
    const client = await connect(await tokenFor(['assets:read', 'assets:write']));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_reviews', 'list_review_notes', 'create_review_note']));
    const reviews = JSON.parse((await call(client, 'list_reviews', { projectId: 'p1' })).content[0].text);
    expect(reviews).toEqual([expect.objectContaining({ id: 'r1', assetId: 'a1', assetVersionId: 'v2', status: 'open' })]);
    const made = await call(client, 'create_review_note', { projectId: 'p1', assetId: 'a1', versionId: 'v2', startSeconds: 83, endSeconds: 95, text: 'Bass masks the vocal: cut 200 Hz' });
    expect(made.isError).toBeFalsy();
    const notes = JSON.parse((await call(client, 'list_review_notes', { projectId: 'p1', assetId: 'a1', versionId: 'v2' })).content[0].text);
    expect(notes).toEqual([expect.objectContaining({ timecode: '1:23–1:35', startSeconds: 83, endSeconds: 95, text: 'Bass masks the vocal: cut 200 Hz', author: 'agent', taskId: null })]);
  });

  it("an agent's note past the end of the file is refused, saying how long it lasts", async () => {
    mongo.db.collection('asset_versions').docs.push({ versionId: 'v2', assetId: 'a1', projectId: 'p1', version: 2, measurements: { kind: 'audio', duration: 180 } });
    const client = await connect(await tokenFor(['assets:read', 'assets:write']));
    const past = await call(client, 'create_review_note', { projectId: 'p1', assetId: 'a1', versionId: 'v2', startSeconds: 540, text: 'At 9:00' });
    expect(past.isError).toBe(true);
    expect(past.content[0].text).toContain('lasts 3:00 (180 s)');
    expect(mongo.db.docs('annotations')).toHaveLength(0);
  });

  it('a token that only reads gets the lists, not the note', async () => {
    const names = (await (await connect(await tokenFor(['assets:read']))).listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_reviews', 'list_review_notes']));
    expect(names).not.toContain('create_review_note');
  });
});
