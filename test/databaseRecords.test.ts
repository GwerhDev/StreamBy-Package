import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { ObjectId } from 'mongodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// A project's database records, as an agent reads and changes them (the MCP server's database
// tools) through the routes the Database section uses: on the version it read. The project's
// built-in MongoDB is a fake Mongo; projects live in the models, in memory.
const mongo = vi.hoisted(() => ({ db: null as any }));
const store: Record<string, any[]> = {};
const matchesRecord = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matchesRecord(r, filter)),
    findOne: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    create: async (doc: any) => { rows().push(doc); return doc; },
    update: async (filter: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
    delete: async () => 0,
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
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');

const signedFor = (key: string) => `https://signed.test/${key}`;
const adapter = { getPresignedGetUrl: async (key: string) => signedFor(key) };
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [{ id: 's3', type: 's3', config: { region: 'sa-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } } as any],
  adapter: adapter as any, databases: [{ id: 'mongo', type: 'nosql' }, { id: 'pg', type: 'sql', main: true }],
  authProvider: async (req: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer);
      if (!resolved) throw new Error('Invalid API token');
      return { userId: resolved.userId, username: resolved.name, role: 'viewer', apiToken: resolved.scope };
    }
    const user = req.headers['x-test-user'];
    if (!user) throw new Error('No session');
    return { userId: user, username: user, role: 'viewer' };
  },
}));

const RECORD_ID = new ObjectId();
const BUCKET = 'https://streamby.s3.sa-east-1.amazonaws.com/p1/images';
// The portfolio's record, as the develop export serves it.
const portfolio = () => ({
  _id: RECORD_ID, _projectId: 'p1', _tableName: 'portfolio',
  title: 'Projects',
  items: [{ name: 'ShadowClan', image: `${BUCKET}/a1.png` }, { name: 'Latiuna Hub', image: `${BUCKET}/a2.png` }],
});
const records = () => mongo.db.collection('records').docs;
const DB = '/projects/p1/connections/db/c-mongo';

beforeEach(() => {
  mongo.db = new FakeDb();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Portfolio', dbType: 'sql', allowedOrigin: ['*'],
    dbConnections: [{ id: 'c-mongo', name: 'MongoDB', dbType: 'mongodb', source: 'builtin', integrationId: 'mongo' }],
    exports: [{
      id: 'e1', name: 'develop',
      nodeSchema: {
        nodes: [
          { id: 'streamby', type: 'streambyNode', position: { x: 0, y: 0 }, data: {} },
          { id: 'source', type: 'dataSourceNode', position: { x: 0, y: 200 }, data: { connectionId: 'c-mongo', tableName: 'portfolio', recordId: String(RECORD_ID) } },
        ],
        edges: [{ id: 'a', source: 'source', target: 'streamby', targetHandle: 'in-bottom' }],
      },
    }],
    members: [{ userId: 'eli', role: 'admin', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  records().push(portfolio());
  mongo.db.collection('storage_files').docs.push(
    { fileId: 'f1', projectId: 'p1', storageKey: 'p1/images/a1.png', displayName: 'shadowclan.png' },
    { fileId: 'f2', projectId: 'p1', storageKey: 'p1/images/a2.png', displayName: 'latiunahub.png' },
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a database record, read and changed on the version it was read at", () => {
  const eli = (method: 'get' | 'put' | 'post' | 'delete', path: string, body?: object) =>
    request(app)[method](`/streamby${DB}${path}`).set('x-test-user', 'eli').send(body);

  it('is read with its version, which changes when what it holds does, and only then', async () => {
    const read = await eli('get', `/tables/portfolio/${RECORD_ID}`);
    expect(read.status).toBe(200);
    expect(read.body.data.title).toBe('Projects');
    expect(read.body.version).toMatch(/^[0-9a-f]{16}$/);
    expect((await eli('get', `/tables/portfolio/${RECORD_ID}`)).body.version).toBe(read.body.version);
    records()[0].title = 'Work';
    expect((await eli('get', `/tables/portfolio/${RECORD_ID}`)).body.version).not.toBe(read.body.version);
    expect((await eli('get', `/tables/portfolio/${new ObjectId()}`)).status).toBe(404);
  });

  it('is changed field by field, or replaced whole, on its version; on an older one, a 409', async () => {
    const { version } = (await eli('get', `/tables/portfolio/${RECORD_ID}`)).body;
    const changed = await eli('put', `/tables/portfolio/${RECORD_ID}?baseVersion=${version}`, { title: 'Work' });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ title: 'Work', items: portfolio().items });
    expect(changed.body.version).not.toBe(version);

    const stale = await eli('put', `/tables/portfolio/${RECORD_ID}?baseVersion=${version}`, { title: 'Again' });
    expect(stale.status).toBe(409);
    expect(stale.body.version).toBe(changed.body.version);
    expect(records()[0].title).toBe('Work');

    const replaced = await eli('put', `/tables/portfolio/${RECORD_ID}?replace=true&baseVersion=${changed.body.version}`, { title: 'Only this' });
    expect(replaced.status).toBe(200);
    expect(records()[0]).not.toHaveProperty('items');
    expect(records()[0]).toMatchObject({ _id: RECORD_ID, _projectId: 'p1', _tableName: 'portfolio', title: 'Only this' });
    expect((await eli('put', `/tables/portfolio/${new ObjectId()}?baseVersion=${version}`, { title: 'x' })).status).toBe(404);
  });

  it('is created and deleted', async () => {
    const made = await eli('post', '/tables/portfolio', { title: 'Drafts' });
    expect(made.status).toBe(201);
    expect(records()).toHaveLength(2);
    expect((await eli('delete', `/tables/portfolio/${made.body.data._id}`)).status).toBe(200);
    expect(records()).toHaveLength(1);
  });

  it("is for the project's members to read and its editors to change", async () => {
    expect((await request(app).get(`/streamby${DB}/tables/portfolio/${RECORD_ID}`).set('x-test-user', 'mallory')).status).toBe(403);
    expect((await request(app).put(`/streamby${DB}/tables/portfolio/${RECORD_ID}`).set('x-test-user', 'vic').send({ title: 'x' })).status).toBe(403);
  });
});

describe('the database tools, from an agent', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const connect = async (permissions: string[]) => {
    const { token } = await createApiToken({ kind: 'user', userId: 'eli' }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: { projectId: 'p1', ...args } });
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return JSON.parse(result.content?.[0]?.text);
  };

  it("reads develop's record, refers to its assets in place of bucket URLs, and the export serves signed ones", async () => {
    const agent = await connect(['project:read', 'project:update']);
    const [conn] = await call(agent, 'list_database_connections', {});
    expect(conn.id).toBe('c-mongo');
    expect(await call(agent, 'list_database_records', { connectionId: 'c-mongo', table: 'portfolio' })).toHaveLength(1);

    const { record, version } = await call(agent, 'get_database_record', { connectionId: 'c-mongo', table: 'portfolio', recordId: String(RECORD_ID) });
    const items = record.items.map((item: any) => ({ ...item, image: item.image.replace(`${BUCKET}/a1.png`, 'streamby://asset/f1').replace(`${BUCKET}/a2.png`, 'streamby://asset/f2') }));
    const changed = await call(agent, 'update_database_record', { connectionId: 'c-mongo', table: 'portfolio', recordId: String(RECORD_ID), fields: { items }, baseVersion: version });
    expect(changed.record.items.map((i: any) => i.image)).toEqual(['streamby://asset/f1', 'streamby://asset/f2']);

    const served = (await request(app).get('/streamby/p1/export/develop')).body;
    expect(served.items.map((i: any) => i.image)).toEqual([signedFor('p1/images/a1.png'), signedFor('p1/images/a2.png')]);

    // Again on the version it read before: refused, and nothing changes.
    await expect(call(agent, 'update_database_record', { connectionId: 'c-mongo', table: 'portfolio', recordId: String(RECORD_ID), fields: { title: 'x' }, baseVersion: version }))
      .rejects.toThrow(/changed since it was read/);
    expect(records()[0].title).toBe('Projects');

    const replaced = await call(agent, 'replace_database_record', { connectionId: 'c-mongo', table: 'portfolio', recordId: String(RECORD_ID), record: { title: 'Projects', items: [] }, baseVersion: changed.version });
    expect(replaced.record.items).toEqual([]);
  });

  it('creates and deletes records; reading needs project:read, changing project:update', async () => {
    const reader = await connect(['project:read']);
    const names = (await reader.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_database_connections', 'list_database_tables', 'list_database_records', 'get_database_record']));
    for (const name of ['update_database_record', 'replace_database_record', 'create_database_record', 'delete_database_record']) expect(names).not.toContain(name);

    const writer = await connect(['project:read', 'project:update']);
    expect((await writer.listTools()).tools.find(t => t.name === 'delete_database_record')?.annotations).toMatchObject({ destructiveHint: true });
    const made = await call(writer, 'create_database_record', { connectionId: 'c-mongo', table: 'portfolio', record: { title: 'Drafts' } });
    await call(writer, 'delete_database_record', { connectionId: 'c-mongo', table: 'portfolio', recordId: String(made._id) });
    expect(records()).toHaveLength(1);
  });
});

describe('a PostgreSQL record', async () => {
  const { replaceRecordInternal, recordVersion, RecordError } = await import('../src/services/dbConnection');
  // A pool answering a table's one row, and keeping the UPDATE it was sent.
  const poolWith = (row: Record<string, unknown>) => {
    const sent: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        sent.push({ sql, params });
        if (sql.startsWith('SELECT')) return { rows: [row] };
        if (sql.startsWith('UPDATE')) return { rows: [{ ...row, ...Object.fromEntries(sent.at(-1)!.sql.match(/"(\w+)" = \$\d+/g)!.map((m, i) => [m.split('"')[1], params[i]])) }] };
        return { rows: [] };
      },
    };
    return { pool: pool as any, sent };
  };

  it("is replaced whole: a column it isn't given is set to null, its id stays", async () => {
    const { pool, sent } = poolWith({ id: 7, title: 'Projects', cover: 'https://old', notes: 'x' });
    const replaced = await replaceRecordInternal(pool, 'sql', 'portfolio', '7', { id: 99, title: 'Work', cover: 'streamby://asset/f1' }, 'p1');
    const update = sent.find(q => q.sql.startsWith('UPDATE'))!;
    expect(update.sql).toBe('UPDATE "db_p1_portfolio" SET "title" = $1, "cover" = $2, "notes" = $3 WHERE id = $4 RETURNING *');
    expect(update.params).toEqual(['Work', 'streamby://asset/f1', null, '7']);
    expect(replaced).toMatchObject({ id: 7, title: 'Work', notes: null });
  });

  it("refuses a column its table doesn't have", async () => {
    const { pool, sent } = poolWith({ id: 7, title: 'Projects' });
    await expect(replaceRecordInternal(pool, 'sql', 'portfolio', '7', { title: 'Work', colour: 'red' }, 'p1')).rejects.toThrow(RecordError);
    expect(sent.some(q => q.sql.startsWith('UPDATE'))).toBe(false);
  });

  it("has a version by what it holds, whatever its fields' order", () => {
    const at = new Date('2026-11-10T00:00:00Z');
    expect(recordVersion({ a: 1, b: { c: at } })).toBe(recordVersion({ b: { c: new Date(at) }, a: 1 }));
    expect(recordVersion({ a: 1 })).not.toBe(recordVersion({ a: 2 }));
    expect(recordVersion({ _id: new ObjectId('0123456789abcdef01234567') })).toBe(recordVersion({ _id: '0123456789abcdef01234567' }));
  });
});
