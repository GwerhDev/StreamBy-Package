import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Projects live in the models (here in memory); documents in the main database's store, which
// with no main database connected is in memory too.
const mongo = vi.hoisted(() => ({ db: null as any }));
const events = vi.hoisted(() => [] as { userId: string; event: any }[]);
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
vi.mock('../src/services/wsHub', () => ({
  initWsHub: () => {},
  emitToUser: (userId: string, event: any) => { events.push({ userId, event }); },
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');
const { permissionsForOAuthScopes } = await import('../src/services/oauthTokens');
const { documentStore, replaceSection } = await import('../src/services/documents');
const { executeExport } = await import('../src/services/executor');

// A session ('x-test-user'), an API token, or an app the user connected with OAuth
// ('x-test-oauth': its name, acting for 'x-test-user').
const authProvider = async (req: any) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (bearer?.startsWith(API_TOKEN_PREFIX)) {
    const resolved = await resolveApiToken(bearer);
    if (!resolved) throw new Error('Invalid API token');
    return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
  }
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  const app = req.headers['x-test-oauth'];
  if (app) {
    return {
      userId: user, username: user, role: 'viewer' as const,
      apiToken: {
        tokenId: `oauth:${app}:${user}`, kind: 'user' as const, projectIds: '*' as const,
        // 'x-test-oauth-grants': what a scope might grant some day, beyond today's.
        permissions: [...permissionsForOAuthScopes(['streamby:read', 'streamby:write']), ...((req.headers['x-test-oauth-grants'] as string | undefined)?.split(',') ?? [])] as any,
      },
      oauth: { clientId: `dyn_${app}`, clientName: app },
    };
  }
  return { userId: user, username: user, role: 'viewer' as const };
};
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({ storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider }));

const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
const as = (who: { user?: string; token?: string; oauth?: string; grants?: string }) => {
  const auth = (r: request.Test) => {
    if (who.token) return r.set('Authorization', `Bearer ${who.token}`);
    r.set('x-test-user', who.user!);
    if (who.grants) r.set('x-test-oauth-grants', who.grants);
    return who.oauth ? r.set('x-test-oauth', who.oauth) : r;
  };
  return {
    get: (p: string) => auth(request(app).get(`/streamby${p}`)),
    post: (p: string, body?: object) => auth(request(app).post(`/streamby${p}`)).send(body ?? {}),
    patch: (p: string, body?: object) => auth(request(app).patch(`/streamby${p}`)).send(body ?? {}),
    delete: (p: string) => auth(request(app).delete(`/streamby${p}`)),
  };
};
const ada = as({ user: 'ada' });
const eli = as({ user: 'eli' });
const vic = as({ user: 'vic' });
const pat = as({ user: 'pat' });
const claude = as({ user: 'eli', oauth: 'Claude' });
const D = '/projects/p1/documents';

const create = async (body: object, who = eli) => (await who.post(D, body)).body.document;

beforeEach(async () => {
  mongo.db = new FakeDb();
  events.length = 0;
  for (const k of Object.keys(store)) delete store[k];
  await documentStore().deleteProject('p1');
  await documentStore().deleteProject('p2');
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Spellcast', dbType: 'sql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }, { userId: 'pat', role: 'editor', status: 'pending' }] },
    { _id: 'p2', id: 'p2', name: 'Other', dbType: 'sql', members: [{ userId: 'ada', role: 'admin', status: 'active' }] },
  ];
});
afterEach(() => vi.restoreAllMocks());

describe('documents', () => {
  it('are created by editors, read by every member, and by nobody outside', async () => {
    const doc = await create({ title: 'Architecture', content: '# Spellcast\n' });
    expect(doc).toMatchObject({ title: 'Architecture', kind: 'document', version: 1, parentId: null, exportable: false, publishedVersion: null });
    expect(doc.createdBy).toEqual({ userId: 'eli', username: 'eli', via: 'session' });

    const listed = (await vic.get(D)).body.documents;
    expect(listed.map((d: any) => d.title)).toEqual(['Architecture']);
    expect(listed[0].content).toBeUndefined(); // the tree, not the text
    expect((await vic.get(`${D}/${doc.id}`)).body.document.content).toBe('# Spellcast\n');

    expect((await vic.post(D, { title: 'Nope' })).status).toBe(403);
    expect((await pat.get(D)).status).toBe(403);
    expect((await ada.get(`/projects/p2/documents/${doc.id}`)).status).toBe(404);
  });

  it('go in folders, at the end of theirs, and a folder takes everything in it when deleted', async () => {
    const folder = await create({ title: 'Concept', kind: 'folder' });
    const a = await create({ title: 'Vision', parentId: folder.id });
    const b = await create({ title: 'Model', parentId: folder.id });
    const outside = await create({ title: 'Roadmap' });
    expect([a.position, b.position]).toEqual([0, 1]);

    expect((await eli.post(D, { title: 'In a doc', parentId: a.id })).status).toBe(400);
    expect((await eli.post(D, { title: 'Folder text', kind: 'folder', content: 'x' })).status).toBe(400);
    expect((await eli.patch(`${D}/${folder.id}`, { parentId: folder.id })).status).toBe(400);

    const deleted = (await ada.delete(`${D}/${folder.id}`)).body.deleted;
    expect(deleted.sort()).toEqual([folder.id, a.id, b.id].sort());
    expect((await eli.get(D)).body.documents.map((d: any) => d.id)).toEqual([outside.id]);
  });

  it('keep every save as a version, with who saved it and when', async () => {
    const doc = await create({ title: 'Architecture', content: 'v1' });
    const saved = (await ada.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'v2' })).body.document;
    expect(saved).toMatchObject({ version: 2, content: 'v2', updatedBy: { userId: 'ada', via: 'session' } });

    const versions = (await vic.get(`${D}/${doc.id}/versions`)).body.versions;
    expect(versions.map((v: any) => [v.version, v.author.userId])).toEqual([[2, 'ada'], [1, 'eli']]);
    expect(versions[0].content).toBeUndefined();
    expect((await vic.get(`${D}/${doc.id}/versions/1`)).body.version.content).toBe('v1');
    expect((await vic.get(`${D}/${doc.id}/versions/9`)).status).toBe(404);
  });

  it("refuse a save made on a version that's no longer the latest, and lose nothing", async () => {
    const doc = await create({ title: 'Architecture', content: 'base' });
    const first = await ada.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'by ada' });
    expect(first.status).toBe(200);
    const second = await eli.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'by eli' });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/version 2/);
    expect(second.body.document).toMatchObject({ version: 2, content: 'by ada' });
    expect((await eli.get(`${D}/${doc.id}`)).body.document.content).toBe('by ada');

    expect((await eli.patch(`${D}/${doc.id}`, { content: 'no base' })).status).toBe(400);
  });

  it('move and become exportable without a new version', async () => {
    const folder = await create({ title: 'Concept', kind: 'folder' });
    const doc = await create({ title: 'Vision' });
    const moved = (await eli.patch(`${D}/${doc.id}`, { parentId: folder.id, position: 3, exportable: true })).body.document;
    expect(moved).toMatchObject({ parentId: folder.id, position: 3, exportable: true, version: 1 });
  });
});

describe("a document's section", () => {
  const TEXT = '# Spellcast\n\nIntro.\n\n## Architecture\n\nOld.\n\n### Storage\n\nIndexedDB.\n\n## Roadmap\n\nLater.\n';

  it('is replaced alone, up to the next heading of its level', async () => {
    const doc = await create({ title: 'Spellcast', content: TEXT });
    const saved = (await claude.patch(`${D}/${doc.id}/sections`, { baseVersion: 1, heading: '## Architecture', content: 'New.\n' })).body.document;
    expect(saved.content).toBe('# Spellcast\n\nIntro.\n\n## Architecture\n\nNew.\n\n## Roadmap\n\nLater.\n');
    expect(saved.version).toBe(2);
  });

  it("is found by its title, never by a heading inside code, and isn't guessed", () => {
    const fenced = '## A\n\n```\n## B\n```\n\n## B\n\nx\n';
    expect(replaceSection(fenced, 'B', 'y')).toEqual({ content: '## A\n\n```\n## B\n```\n\n## B\n\ny\n' });
    expect(replaceSection('## A\n\n## A\n', 'A', 'x')).toEqual({ error: 'ambiguous' });
    expect(replaceSection('## A\n\n### A\n', '### A', 'x')).toEqual({ content: '## A\n\n### A\n\nx\n' });
    expect(replaceSection('## A\n', 'Missing', 'x')).toEqual({ error: 'not-found' });
  });

  it('answers when the heading is missing, ambiguous, or the document changed', async () => {
    const doc = await create({ title: 'Spellcast', content: '## A\n\n## A\n' });
    expect((await eli.patch(`${D}/${doc.id}/sections`, { baseVersion: 1, heading: 'Missing', content: 'x' })).status).toBe(404);
    expect((await eli.patch(`${D}/${doc.id}/sections`, { baseVersion: 1, heading: 'A', content: 'x' })).status).toBe(400);
    await eli.patch(`${D}/${doc.id}`, { baseVersion: 1, content: '## A\n' });
    expect((await eli.patch(`${D}/${doc.id}/sections`, { baseVersion: 1, heading: 'A', content: 'x' })).status).toBe(409);
  });
});

describe('who may do what', () => {
  it("a token without docs:write can't change them; one without docs:delete can't delete them", async () => {
    const doc = await create({ title: 'Architecture', content: 'v1' });
    const reader = as({ token: await tokenFor(['docs:read']) });
    expect((await reader.get(`${D}/${doc.id}`)).status).toBe(200);
    expect((await reader.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'x' })).status).toBe(403);
    expect((await reader.post(D, { title: 'x' })).status).toBe(403);

    const writer = as({ token: await tokenFor(['docs:read', 'docs:write']) });
    const saved = (await writer.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'by a token' })).body.document;
    expect(saved.updatedBy).toMatchObject({ via: 'apiToken', userId: 'eli' });
    expect((await writer.delete(`${D}/${doc.id}`)).status).toBe(403);

    const deleter = as({ token: await tokenFor(['docs:delete']) });
    expect((await deleter.delete(`${D}/${doc.id}`)).status).toBe(200);
  });

  // Publishing is choosing what the exports deliver: apart from writing.
  it('a token publishes only with docs:publish, writing being not enough', async () => {
    const doc = await create({ title: 'Architecture', content: 'v1' });
    const writer = as({ token: await tokenFor(['docs:read', 'docs:write']) });
    expect((await writer.post(`${D}/${doc.id}/publish`, { version: 1 })).status).toBe(403);
    expect((await writer.patch(`${D}/${doc.id}`, { exportable: true })).status).toBe(403);
    expect((await writer.patch(`${D}/${doc.id}`, { parentId: null })).status).toBe(200); // moving is writing

    const publisher = as({ token: await tokenFor(['docs:read', 'docs:write', 'docs:publish']) });
    expect((await publisher.patch(`${D}/${doc.id}`, { exportable: true })).body.document.exportable).toBe(true);
    expect((await publisher.post(`${D}/${doc.id}/publish`, { version: 1 })).body.document.publishedVersion).toBe(1);
  });

  it("an app connected with OAuth publishes nothing: what it edits stays a draft", async () => {
    const doc = await create({ title: 'Architecture', content: 'v1' });
    await claude.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'by Claude' });
    expect((await claude.post(`${D}/${doc.id}/publish`, { version: 2 })).status).toBe(403);
    expect((await claude.patch(`${D}/${doc.id}`, { exportable: true })).status).toBe(403);
    expect((await eli.get(`${D}/${doc.id}`)).body.document).toMatchObject({ exportable: false, publishedVersion: null });

    // Not even if a scope granted docs:publish some day.
    const granted = as({ user: 'eli', oauth: 'Claude', grants: 'docs:publish' });
    expect((await granted.post(`${D}/${doc.id}/publish`, { version: 2 })).status).toBe(403);
    expect((await granted.patch(`${D}/${doc.id}`, { exportable: true })).status).toBe(403);
  });

  it('an app connected with OAuth reads and edits them, signs as itself for the user, and deletes none', async () => {
    const doc = await create({ title: 'Architecture', content: 'v1' });
    expect((await claude.get(`${D}/${doc.id}`)).status).toBe(200);
    const saved = (await claude.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'by Claude' })).body.document;
    expect(saved.updatedBy).toEqual({ userId: 'eli', username: 'eli', via: 'oauth', clientId: 'dyn_Claude', clientName: 'Claude' });
    expect((await claude.delete(`${D}/${doc.id}`)).status).toBe(403);
  });
});

describe('in real time', () => {
  it("tells the project's active members of each change, with the version and who made it", async () => {
    const doc = await create({ title: 'Architecture', content: 'v1' });
    await claude.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'v2' });
    await ada.delete(`${D}/${doc.id}`);

    const to = (action: string) => events.filter(e => e.event.data.action === action).map(e => e.userId).sort();
    expect(to('created')).toEqual(['ada', 'eli', 'vic']); // not pat: still invited
    const saved = events.find(e => e.event.data.action === 'saved')!.event;
    expect(saved).toEqual({
      type: 'documentEvent',
      data: { projectId: 'p1', action: 'saved', documentIds: [doc.id], version: 2, title: 'Architecture', author: expect.objectContaining({ via: 'oauth', clientName: 'Claude' }) },
    });
    expect(to('deleted')).toEqual(['ada', 'eli', 'vic']);
  });
});

describe('exported', () => {
  const schema = (data: object = {}) => ({
    nodes: [{ id: 'streamby', type: 'streambyNode', data: {} }, { id: 'docs', type: 'documentsNode', data }],
    edges: [{ id: 'e', source: 'docs', target: 'streamby', targetHandle: 'in-bottom' }],
  });
  // The server's storage, configured (nothing is reached).
  const config = { storageProviders: [{ id: 's3', type: 's3', config: { bucket: 'b', region: 'us-east-1', accessKeyId: 'x', secretAccessKey: 'y' } }] } as any;
  const run = (data?: object) => executeExport(schema(data) as any, store.projects[0], config, { public: true });

  it('delivers only the published version of exportable documents, never a draft', async () => {
    const doc = await create({ title: 'Architecture', content: 'published text' });
    const hidden = await create({ title: 'Internal', content: 'not exportable' });
    await eli.patch(`${D}/${doc.id}`, { exportable: true });
    await eli.post(`${D}/${hidden.id}/publish`, { version: 1 });
    expect(await run()).toEqual([]); // exportable, but nothing published yet

    await eli.post(`${D}/${doc.id}/publish`, { version: 1 });
    await claude.patch(`${D}/${doc.id}`, { baseVersion: 1, content: 'a draft by Claude' });
    expect(await run()).toEqual([expect.objectContaining({ id: doc.id, version: 1, content: 'published text', title: 'Architecture' })]);

    await eli.post(`${D}/${doc.id}/publish`, { version: 2 });
    expect((await run())[0]).toMatchObject({ version: 2, content: 'a draft by Claude' });

    expect((await eli.post(`${D}/${doc.id}/publish`, { version: 7 })).status).toBe(404);
    await eli.post(`${D}/${doc.id}/publish`, { version: null });
    expect(await run()).toEqual([]);
  });

  it("of one folder, when the node says so", async () => {
    const folder = await create({ title: 'Public', kind: 'folder' });
    const inside = await create({ title: 'FAQ', content: 'q', parentId: folder.id });
    const outside = await create({ title: 'Notes', content: 'n' });
    for (const d of [inside, outside]) {
      await eli.patch(`${D}/${d.id}`, { exportable: true });
      await eli.post(`${D}/${d.id}/publish`, { version: 1 });
    }
    expect((await run({ folderId: folder.id })).map((d: any) => d.id)).toEqual([inside.id]);
    expect((await run()).map((d: any) => d.id).sort()).toEqual([inside.id, outside.id].sort());
  });
});

describe('from the MCP server', () => {
  let server: http.Server;
  let base = '';
  beforeEach(async () => {
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const connect = async (token: string) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: args as any });
    return { error: result.isError ? result.content[0].text as string : null, data: result.isError ? null : JSON.parse(result.content[0].text || 'null') };
  };

  it('lists the document tools by permission', async () => {
    const reader = (await (await connect(await tokenFor(['docs:read']))).listTools()).tools.map(t => t.name);
    expect(reader).toEqual(expect.arrayContaining(['list_documents', 'get_document', 'list_document_versions']));
    expect(reader).not.toContain('update_document');
    const writer = (await (await connect(await tokenFor(['docs:read', 'docs:write']))).listTools()).tools.map(t => t.name);
    expect(writer).toEqual(expect.arrayContaining(['create_document', 'update_document', 'update_document_section']));
  });

  // As Claude keeping a project's architecture up to date while someone edits it in the UI.
  it('reads a document, updates a section, and is told to read it again when it changed', async () => {
    const client = await connect(await tokenFor(['docs:read', 'docs:write']));
    const created = (await call(client, 'create_document', { projectId: 'p1', title: 'Architecture', content: '## Storage\n\nIndexedDB.\n' })).data;
    expect(created.version).toBe(1);
    expect((await call(client, 'list_documents', { projectId: 'p1' })).data.map((d: any) => d.title)).toEqual(['Architecture']);

    const read = (await call(client, 'get_document', { projectId: 'p1', documentId: created.id })).data;
    await eli.patch(`${D}/${created.id}`, { baseVersion: read.version, content: '## Storage\n\nIndexedDB, persisted.\n' });

    const refused = await call(client, 'update_document_section', { projectId: 'p1', documentId: created.id, baseVersion: read.version, heading: '## Storage', content: 'Mine.' });
    expect(refused.error).toMatch(/changed.*version 2.*Read it again/s);

    const again = (await call(client, 'get_document', { projectId: 'p1', documentId: created.id })).data;
    const saved = (await call(client, 'update_document_section', { projectId: 'p1', documentId: created.id, baseVersion: again.version, heading: '## Storage', content: 'IndexedDB, persisted; cloud later.' })).data;
    expect(saved).toMatchObject({ version: 3, content: '## Storage\n\nIndexedDB, persisted; cloud later.\n' });

    const history = (await call(client, 'list_document_versions', { projectId: 'p1', documentId: created.id })).data;
    expect(history.map((v: any) => v.version)).toEqual([3, 2, 1]);
    expect((await call(client, 'get_document', { projectId: 'p1', documentId: created.id, version: 1 })).data.content).toBe('## Storage\n\nIndexedDB.\n');
  });
});
