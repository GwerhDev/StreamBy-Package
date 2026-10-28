import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// Assets' license metadata (in asset_rights, the main nosql database's) and the credits sheets
// that read it. Projects live in the models (here in memory); documents in the main database's
// store, in memory too with no main database connected.
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
    create: async (doc: any) => { rows().push(doc); return doc; },
    update: async (filter: any, data: any) => rows().find(r => matchesRecord(r, filter)) ?? null,
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
const { documentStore } = await import('../src/services/documents');
const { checkRights, LICENSE_TYPES } = await import('../src/services/rights');

const authProvider = async (req: any) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (bearer?.startsWith(API_TOKEN_PREFIX)) {
    const resolved = await resolveApiToken(bearer);
    if (!resolved) throw new Error('Invalid API token');
    return { userId: resolved.userId, username: resolved.name, role: 'viewer' as const, apiToken: resolved.scope };
  }
  const user = req.headers['x-test-user'];
  if (!user) throw new Error('No session');
  return { userId: user, username: user, role: 'viewer' as const };
};
const adapter = { getPresignedUploadUrl: async (key: string) => `https://upload.test/${key}`, deleteFile: async () => {} };
const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({ storageProviders: [], adapter: adapter as any, databases: [{ id: 'pg', type: 'sql', main: true }], authProvider }));

const tokenFor = async (permissions: string[], userId = 'eli') =>
  (await createApiToken({ kind: 'user', userId }, { name: 'agent', permissions: permissions as any, projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any)).token;
const as = (who: { user?: string; token?: string }) => {
  const auth = (r: request.Test) => (who.token ? r.set('Authorization', `Bearer ${who.token}`) : r.set('x-test-user', who.user!));
  return {
    get: (p: string) => auth(request(app).get(`/streamby${p}`)),
    post: (p: string, body?: object) => auth(request(app).post(`/streamby${p}`)).send(body ?? {}),
    put: (p: string, body?: object) => auth(request(app).put(`/streamby${p}`)).send(body ?? {}),
    patch: (p: string, body?: object) => auth(request(app).patch(`/streamby${p}`)).send(body ?? {}),
    delete: (p: string) => auth(request(app).delete(`/streamby${p}`)),
  };
};
const ada = as({ user: 'ada' });
const eli = as({ user: 'eli' });
const vic = as({ user: 'vic' });
const P = '/projects/p1';

const file = (fileId: string, extra: object = {}) =>
  mongo.db.collection('storage_files').docs.push({ fileId, projectId: 'p1', category: 'images', storageKey: `p1/images/${fileId}.png`, displayName: `${fileId}.png`, ...extra });
const folder = (folderId: string, parentId: string | null = null) =>
  mongo.db.collection('storage_folders').docs.push({ folderId, projectId: 'p1', name: folderId, parentId });
const rightsOf = (assetId: string) => mongo.db.collection('asset_rights').docs.find((r: any) => r.assetId === assetId);
const complete = { creatorName: 'Jane Doe', sourceUrl: 'https://sketchfab.com/rock', licenseType: 'CC BY' };

// A credits sheet's document, and (with `ingest`) its node in the workflow with Ingest nodes
// connected to it, importing those assets.
const sheet = async (sources: { assetIds?: string[]; folderIds?: string[] }, title = 'Credits') =>
  (await eli.post(`${P}/documents`, { title, kind: 'credits', content: JSON.stringify(sources) })).body.document;
const connectIngest = (documentId: string, assetIds: string[]) => {
  const project = store.projects[0];
  const nodes = project.workflow?.nodeSchema?.nodes ?? [];
  const edges = project.workflow?.nodeSchema?.edges ?? [];
  const sheetNode = { id: `sheet-${documentId}`, type: 'creditsSheetNode', data: { documentId } };
  const ingests = assetIds.map((fileId, i) => ({ id: `ingest-${documentId}-${i}`, type: 'ingestNode', data: { fileId } }));
  project.workflow = { nodeSchema: {
    nodes: [...nodes, sheetNode, ...ingests],
    edges: [...edges, ...ingests.map(n => ({ id: `e-${n.id}`, source: n.id, target: sheetNode.id }))],
  } };
};
const read = async (id: string) => (await vic.get(`${P}/credits-sheets/${id}`)).body;

beforeEach(async () => {
  mongo.db = new FakeDb();
  events.length = 0;
  for (const k of Object.keys(store)) delete store[k];
  await documentStore().deleteProject('p1');
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Spellcast', dbType: 'sql', members: [
      { userId: 'ada', role: 'admin', status: 'active' }, { userId: 'eli', role: 'editor', status: 'active' },
      { userId: 'vic', role: 'viewer', status: 'active' }, { userId: 'pat', role: 'editor', status: 'pending' }] },
  ];
});
afterEach(() => vi.restoreAllMocks());

describe("an asset's license metadata", () => {
  it('takes a license from the list only, and links that are links', () => {
    for (const licenseType of LICENSE_TYPES) expect(checkRights({ licenseType })).toEqual({ values: { licenseType } });
    expect(checkRights({ licenseType: 'CC BY 4.0' })).toEqual({ error: expect.stringContaining('licenseType is one of: CC BY, CC BY-SA') });
    expect(checkRights({ licenseType: 'Royalty free' })).toHaveProperty('error');
    expect(checkRights({ sourceUrl: 'sketchfab' })).toEqual({ error: 'sourceUrl must be an http(s) URL' });
    expect(checkRights({ creatorUrl: 'javascript:alert(1)' })).toEqual({ error: 'creatorUrl must be an http(s) URL' });
    expect(checkRights({ creatorName: '  Jane  ', comments: '', licenseType: null })).toEqual({ values: { creatorName: 'Jane', comments: null, licenseType: null } });
  });

  it('is set by who may edit the asset, read by every member, and tells the project of each change', async () => {
    file('a1');
    const saved = await eli.put(`${P}/assets/a1/rights`, { ...complete, creatorUrl: 'https://sketchfab.com/jane', comments: 'Retextured' });
    expect(saved.status).toBe(200);
    expect(saved.body.rights).toMatchObject({ assetId: 'a1', ...complete, creatorUrl: 'https://sketchfab.com/jane', comments: 'Retextured' });
    expect((await vic.get(`${P}/assets/a1/rights`)).body.rights).toMatchObject(complete);

    expect((await vic.put(`${P}/assets/a1/rights`, { comments: 'no' })).status).toBe(403);
    expect((await eli.put(`${P}/assets/a1/rights`, { licenseType: 'Public domain' })).status).toBe(400);
    expect((await eli.put(`${P}/assets/nope/rights`, complete)).status).toBe(404);
    expect(rightsOf('a1').licenseType).toBe('CC BY');

    // A change sets the fields given, keeping the others.
    await eli.put(`${P}/assets/a1/rights`, { comments: '' });
    expect(rightsOf('a1')).toMatchObject({ ...complete, comments: null });

    const told = events.filter(e => e.event.type === 'assetRightsEvent');
    expect(told.map(e => e.userId).sort()).toEqual(['ada', 'ada', 'eli', 'eli', 'vic', 'vic']);
    expect(told[0].event.data).toMatchObject({ projectId: 'p1', action: 'saved', assetIds: ['a1'], rights: expect.objectContaining(complete) });
  });

  it('drops the fields of the old record that no longer fit', async () => {
    file('a1');
    mongo.db.collection('asset_rights').docs.push({ assetId: 'a1', projectId: 'p1', licenseType: 'CC BY 4.0', rightsHolder: 'Jane', territory: 'World', expiresAt: new Date(), usageRestrictions: 'None' });
    expect((await vic.get(`${P}/assets/a1/rights`)).body.rights).toEqual({
      assetId: 'a1', projectId: 'p1', sourceUrl: null, creatorName: null, creatorUrl: null, licenseType: null, comments: null,
    });
    await eli.put(`${P}/assets/a1/rights`, complete);
    expect(Object.keys(rightsOf('a1'))).not.toEqual(expect.arrayContaining(['rightsHolder']));
    expect(rightsOf('a1').territory).toBeUndefined();
  });

  it('goes with the upload: saved with the new asset, and refused before it is made', async () => {
    const query = new URLSearchParams({ fileName: 'rock.png', contentType: 'image/png', ...complete });
    const uploaded = await eli.get(`${P}/storage/images/upload-url?${query}`);
    expect(uploaded.status).toBe(200);
    expect(rightsOf(uploaded.body.fileId)).toMatchObject({ ...complete, updatedBy: 'eli' });

    const bad = new URLSearchParams({ fileName: 'sky.png', contentType: 'image/png', licenseType: 'Royalty free' });
    expect((await eli.get(`${P}/storage/images/upload-url?${bad}`)).status).toBe(400);
    expect(mongo.db.docs('storage_files').map((f: any) => f.displayName)).toEqual(['rock.png']);

    // Without metadata, an upload is as it was.
    const plain = await eli.get(`${P}/storage/images/upload-url?${new URLSearchParams({ fileName: 'sun.png', contentType: 'image/png' })}`);
    expect(rightsOf(plain.body.fileId)).toBeUndefined();
  });

  it("is gone with its asset, telling the open sheets, and with its project", async () => {
    file('a1'); file('a2');
    await eli.put(`${P}/assets/a1/rights`, complete);
    await eli.put(`${P}/assets/a2/rights`, complete);
    events.length = 0;
    expect((await eli.delete(`${P}/storage/files/a1`)).status).toBe(200);
    expect(rightsOf('a1')).toBeUndefined();
    expect(rightsOf('a2')).toBeDefined();
    expect(events.find(e => e.userId === 'vic')?.event).toEqual({ type: 'assetRightsEvent', data: { projectId: 'p1', action: 'deleted', assetIds: ['a1'] } });

    mongo.db.collection('asset_rights').docs.push({ assetId: 'x1', projectId: 'p2', licenseType: 'CC0' });
    expect((await ada.delete(P)).status).toBe(200);
    expect(mongo.db.docs('asset_rights').map((r: any) => r.projectId)).toEqual(['p2']);
  });
});

describe('a credits sheet', () => {
  it("is a document that keeps only its sources, checked", async () => {
    const empty = await sheet({});
    expect(empty).toMatchObject({ kind: 'credits', content: '{"assetIds":[],"folderIds":[]}' });
    expect((await eli.post(`${P}/documents`, { title: 'Bad', kind: 'credits', content: 'not json' })).status).toBe(400);
    expect((await eli.post(`${P}/documents`, { title: 'Bad', kind: 'credits', content: '{"assetIds":"a1"}' })).status).toBe(400);
    expect((await eli.patch(`${P}/documents/${empty.id}/sections`, { baseVersion: 1, heading: '# Credits', content: '' })).status).toBe(400);
    const changed = await eli.patch(`${P}/documents/${empty.id}`, { baseVersion: 1, content: JSON.stringify({ assetIds: ['a1', 'a1'] }) });
    expect(changed.body.document.content).toBe('{"assetIds":["a1"],"folderIds":[]}');
  });

  it("makes its rows from the assets picked, the folders picked (and inside them), and the Ingest nodes connected", async () => {
    file('picked'); file('inside', { folderId: 'f1' }); file('deeper', { folderId: 'f2' }); file('elsewhere', { folderId: 'f3' });
    file('ingested'); file('both', { folderId: 'f1' });
    folder('f1'); folder('f2', 'f1'); folder('f3');
    const doc = await sheet({ assetIds: ['picked', 'both', 'deleted'], folderIds: ['f1'] });
    connectIngest(doc.id, ['ingested', 'both']);

    const { rows } = await read(doc.id);
    expect(rows.map((r: any) => [r.assetId, r.from])).toEqual([
      ['picked', ['asset']], ['both', ['asset', 'folder', 'ingest']], ['inside', ['folder']], ['deeper', ['folder']], ['ingested', ['ingest']],
    ]);
    expect(rows[0]).toMatchObject({ name: 'picked.png', category: 'images' });
  });

  it("is complete when it has an asset and each has its creator, source and license; its rows say what's missing", async () => {
    expect((await read((await sheet({})).id)).status).toBe('incomplete');

    file('a1'); file('a2');
    const doc = await sheet({ assetIds: ['a1', 'a2'] });
    await eli.put(`${P}/assets/a1/rights`, complete);
    await eli.put(`${P}/assets/a2/rights`, { creatorName: 'Sam', comments: 'Bought' });
    let read1 = await read(doc.id);
    expect(read1.status).toBe('incomplete');
    expect(read1.rows.map((r: any) => r.missing)).toEqual([[], ['sourceUrl', 'licenseType']]);

    await eli.put(`${P}/assets/a2/rights`, { sourceUrl: 'https://store.test/a2', licenseType: 'Standard' });
    read1 = await read(doc.id);
    expect(read1.status).toBe('complete');
    expect(read1.rows[1]).toMatchObject({ creatorName: 'Sam', licenseType: 'Standard', comments: 'Bought', missing: [] });

    // An asset deleted leaves it.
    await eli.delete(`${P}/storage/files/a2`);
    expect((await read(doc.id)).rows.map((r: any) => r.assetId)).toEqual(['a1']);
  });

  it('shows an asset in two sheets with the same metadata, changed in both by one edit', async () => {
    file('a1');
    const one = await sheet({ assetIds: ['a1'] }, 'Trailer');
    const two = await sheet({}, 'Teaser');
    connectIngest(two.id, ['a1']);
    await eli.put(`${P}/assets/a1/rights`, complete);
    expect((await read(one.id)).rows[0]).toMatchObject(complete);
    expect((await read(two.id)).rows[0]).toMatchObject(complete);
    await eli.put(`${P}/assets/a1/rights`, { creatorName: 'Jane D.' });
    expect((await read(one.id)).rows[0].creatorName).toBe('Jane D.');
    expect((await read(two.id)).rows[0].creatorName).toBe('Jane D.');

    const listed = (await vic.get(`${P}/credits-sheets`)).body.sheets;
    expect(listed).toEqual([
      { id: one.id, title: 'Trailer', status: 'complete', rows: 1, incomplete: 0 },
      { id: two.id, title: 'Teaser', status: 'complete', rows: 1, incomplete: 0 },
    ]);
    // A document of another kind isn't a sheet.
    const plain = (await eli.post(`${P}/documents`, { title: 'Notes' })).body.document;
    expect((await vic.get(`${P}/credits-sheets/${plain.id}`)).status).toBe(404);
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

  // As Claude bringing a CC model into the project from Blender, and checking the credits.
  it('uploads an asset with its license metadata, and reads a sheet with its status', async () => {
    const client = await connect(await tokenFor(['assets:write', 'rights:read', 'rights:write']));
    const uploaded = (await call(client, 'request_asset_upload', {
      projectId: 'p1', category: 'images', fileName: 'rock.png', contentType: 'image/png', creatorName: 'Jane Doe', licenseType: 'CC BY',
    })).data;
    expect(rightsOf(uploaded.assetId)).toMatchObject({ creatorName: 'Jane Doe', licenseType: 'CC BY' });

    const doc = await sheet({ assetIds: [uploaded.assetId] });
    let read1 = (await call(client, 'get_credits_sheet', { projectId: 'p1', documentId: doc.id })).data;
    expect(read1).toMatchObject({ id: doc.id, title: 'Credits', status: 'incomplete' });
    expect(read1.rows[0]).toMatchObject({ assetId: uploaded.assetId, name: 'rock.png', missing: ['sourceUrl'] });

    expect((await call(client, 'set_asset_rights', { projectId: 'p1', assetId: uploaded.assetId, sourceUrl: 'https://sketchfab.com/rock' })).error).toBeNull();
    read1 = (await call(client, 'get_credits_sheet', { projectId: 'p1', documentId: doc.id })).data;
    expect(read1.status).toBe('complete');

    // A license off the list doesn't get past the tool.
    expect((await call(client, 'set_asset_rights', { projectId: 'p1', assetId: uploaded.assetId, licenseType: 'CC BY 4.0' })).error).toBeTruthy();
  });

  it("uploads with license metadata only with rights:write", async () => {
    const client = await connect(await tokenFor(['assets:write']));
    const refused = await call(client, 'request_asset_upload', { projectId: 'p1', category: 'images', fileName: 'rock.png', contentType: 'image/png', licenseType: 'CC0' });
    expect(refused.error).toContain('rights:write');
    expect(mongo.db.docs('storage_files')).toEqual([]);
    expect((await call(client, 'request_asset_upload', { projectId: 'p1', category: 'images', fileName: 'rock.png', contentType: 'image/png' })).error).toBeNull();
  });
});
