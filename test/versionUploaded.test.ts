import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import request from 'supertest';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeDb } from './fakeMongo';

// A pipeline that starts a card's run when a new version of the card's asset is uploaded: as an
// agent uploads a render from a DAW or an export from Blender, and says it's done. Files,
// versions, cards and runs live in the NoSQL database (here in memory); projects and tokens in
// the models (in memory too).
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
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matchesRecord(r, filter));
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row ?? null;
    },
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

// The storage, in memory: its files by key, each one's size and sha256 as S3 answers them.
const objects = new Map<string, string>();
const hex = (content: string) => crypto.createHash('sha256').update(content).digest('hex');
const adapter = {
  getPresignedUploadUrl: async (key: string) => `https://storage.test/put/${key}`,
  getPresignedGetUrl: async (key: string) => `https://storage.test/get/${key}`,
  copyFile: async (from: string, to: string) => { if (objects.has(from)) objects.set(to, objects.get(from)!); },
  contentInfo: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length, sha256: hex(objects.get(key)!) } : null),
};
// What the tool that has the file does with the URL.
const put = (url: string, content: string) => objects.set(new URL(url).pathname.replace(/^\/put\//, ''), content);

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
    patch: (p: string, body?: object) => auth(request(app).patch(`/streamby${p}`)).send(body ?? {}),
  };
};
const eli = as({ user: 'eli' });
const P = '/projects/p1';
const query = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

// A pipeline whose run waits on its Review Gate: it stays going until someone decides.
const newPipeline = async (body: object) => {
  const pipeline = (await eli.post(`${P}/pipelines`, { name: 'Mix', ...body })).body.pipeline;
  await eli.patch(`${P}/pipelines/${pipeline.id}`, {
    nodeSchema: { nodes: [{ id: 'review', type: 'reviewGateNode', data: { label: 'Mix review', assignedTo: ['eli'] } }], edges: [] },
  });
  return pipeline;
};
const cardFor = async (assetId: string, pipelineId: string, name = 'Theme') => {
  const seq = (await eli.post(`${P}/production/sequences`, { name: 'Soundtrack' })).body.sequence;
  return (await eli.post(`${P}/production/sequences/${seq.id}/shots`, { name, assetId, pipelineId })).body.shot;
};
// An asset uploaded (its first version, its bytes sent), in a category and a folder.
const asset = async (fields: { category?: string; fileName?: string; contentType?: string; folderId?: string } = {}) => {
  const { category = 'audios', fileName = 'theme.wav', contentType = 'audio/wav', folderId } = fields;
  const made = (await eli.get(`${P}/storage/${category}/upload-url?${query({ fileName, contentType, ...(folderId ? { folderId } : {}) })}`)).body;
  put(made.url, 'v1');
  return made.fileId as string;
};
const newVersion = async (assetId: string, content: string, sha256?: string) => {
  const res = (await eli.get(`${P}/storage/files/${assetId}/replace-url?${query({ fileName: 'theme.wav', contentType: 'audio/wav', ...(sha256 ? { sha256 } : {}) })}`)).body;
  return { ...res, send: () => put(res.url, content) };
};
const uploaded = (assetId: string, who = eli, body: object = {}) => who.post(`${P}/assets/${assetId}/uploaded`, body);
const runs = () => mongo.db.docs('pipeline_runs');

beforeEach(() => {
  mongo.db = new FakeDb();
  objects.clear();
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{
    _id: 'p1', id: 'p1', name: 'Harmowave', dbType: 'sql',
    members: [{ userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }],
  }];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a new version uploaded', () => {
  it("starts the run of its card's pipeline, when it's set to; once the bytes are there", async () => {
    const pipeline = await newPipeline({ triggers: ['version_uploaded'] });
    const assetId = await asset();
    const card = await cardFor(assetId, pipeline.id);
    expect(runs()).toEqual([]);

    const v2 = await newVersion(assetId, 'v2', hex('v2'));
    // Not sent yet: the storage has what it had, not the bytes declared.
    const early = await uploaded(assetId);
    expect([early.status, early.body.message]).toEqual([409, "What the storage has isn't the file declared (its sha256 differs): send it again"]);
    expect(runs()).toEqual([]);

    v2.send();
    const done = await uploaded(assetId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ assetId, versionId: v2.versionId, version: 2 });
    expect(done.body.runs).toEqual([{ shotId: card.id, pipelineId: pipeline.id, started: true, runId: runs()[0].id, reason: null }]);
    expect(runs().map((r: any) => [r.trigger, r.status, r.shotId])).toEqual([['version_uploaded', 'running', card.id]]);
  });

  it("an asset's first version isn't uploaded until its bytes are there", async () => {
    const made = (await eli.get(`${P}/storage/audios/upload-url?${query({ fileName: 'stem.wav', contentType: 'audio/wav' })}`)).body;
    expect((await uploaded(made.fileId)).body.message).toBe("The file isn't in the storage yet: send it to the upload URL first");
    put(made.url, 'stem');
    expect((await uploaded(made.fileId)).status).toBe(200);
  });

  it("never starts two runs for a card: one said again starts nothing, and with one going it's kept", async () => {
    const pipeline = await newPipeline({ triggers: ['version_uploaded'] });
    const assetId = await asset();
    const card = await cardFor(assetId, pipeline.id);
    (await newVersion(assetId, 'v2')).send();
    const both = await Promise.all([uploaded(assetId), uploaded(assetId)]);
    expect(both.map(r => r.status)).toEqual([200, 200]);
    expect(both.flatMap(r => r.body.runs).filter((r: any) => r.started)).toHaveLength(1);
    expect((await uploaded(assetId)).body.runs).toEqual([]);
    expect(runs()).toHaveLength(1);

    // A newer one while that run goes: refused with it, as a start by hand.
    (await newVersion(assetId, 'v3')).send();
    const third = await uploaded(assetId);
    expect(third.body.runs).toEqual([{
      shotId: card.id, pipelineId: pipeline.id, started: false, runId: runs()[0].id, reason: 'The shot already has a run of this pipeline going',
    }]);
    expect(runs()).toHaveLength(1);
  });

  it("only the asset's latest version is said uploaded", async () => {
    const assetId = await asset();
    const v1 = mongo.db.docs('asset_versions')[0].versionId;
    const v2 = await newVersion(assetId, 'v2');
    v2.send();
    expect((await uploaded(assetId, eli, { versionId: v1 })).status).toBe(409);
    expect((await uploaded(assetId, eli, { versionId: 'nope' })).status).toBe(404);
    expect((await uploaded(assetId, eli, { versionId: v2.versionId })).status).toBe(200);
  });

  it("starts nothing for a pipeline not set to, nor for someone who can't run jobs", async () => {
    const other = await newPipeline({ triggers: ['card_done'] });
    const assetId = await asset();
    await cardFor(assetId, other.id);
    (await newVersion(assetId, 'v2')).send();
    expect((await uploaded(assetId)).body.runs).toEqual([]);

    const set = await newPipeline({ triggers: ['version_uploaded'] });
    const second = await asset({ fileName: 'b.wav' });
    await cardFor(second, set.id);
    (await newVersion(second, 'v2')).send();
    const writer = as({ token: await tokenFor(['assets:write']) });
    const res = await uploaded(second, writer);
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: any) => [r.started, r.runId])).toEqual([[false, null]]);
    expect(runs()).toEqual([]);
    // A viewer can't say it at all.
    expect((await uploaded(second, as({ user: 'vic' }))).status).toBe(403);
  });

  it("isn't recorded when its runs couldn't start for a caller who can't run jobs: one who can starts them later", async () => {
    const pipeline = await newPipeline({ triggers: ['version_uploaded'] });
    const assetId = await asset();
    const card = await cardFor(assetId, pipeline.id);
    const v2 = await newVersion(assetId, 'v2');
    v2.send();
    const writer = as({ token: await tokenFor(['assets:write']) });
    const denied = await uploaded(assetId, writer);
    expect(denied.status).toBe(200);
    expect(denied.body.uploadedAt).toBeNull();
    expect(denied.body.runs).toEqual([{ shotId: card.id, pipelineId: pipeline.id, started: false, runId: null, reason: expect.stringContaining('may not run jobs') }]);
    const version = () => mongo.db.docs('asset_versions').find((v: any) => v.versionId === v2.versionId);
    expect(version().uploadedAt).toBeUndefined();
    expect(version().uploadedBy).toBeUndefined();

    const runner = as({ token: await tokenFor(['assets:write', 'jobs:run']) });
    const done = await uploaded(assetId, runner);
    expect(done.body.runs).toEqual([expect.objectContaining({ started: true })]);
    expect(version().uploadedAt).toBeTruthy();
    expect(runs()).toHaveLength(1);
  });

  it('nothing set to start on it: recorded all the same, by whoever says it', async () => {
    const assetId = await asset();
    (await newVersion(assetId, 'v2')).send();
    const writer = as({ token: await tokenFor(['assets:write']) });
    const res = await uploaded(assetId, writer);
    expect([res.body.uploadedAt !== null, res.body.runs]).toEqual([true, []]);
  });

  it("isn't recorded when starting its runs fails, so it can be said again", async () => {
    const pipeline = await newPipeline({ triggers: ['version_uploaded'] });
    const assetId = await asset();
    await cardFor(assetId, pipeline.id);
    const v2 = await newVersion(assetId, 'v2');
    v2.send();
    vi.spyOn(mongo.db.collection('pipelines'), 'findOne').mockRejectedValueOnce(new Error('database gone'));
    const failed = await uploaded(assetId);
    expect(failed.status).toBe(500);
    expect(mongo.db.docs('asset_versions').find((v: any) => v.versionId === v2.versionId).uploadedAt).toBeUndefined();
    expect(runs()).toEqual([]);
    const again = await uploaded(assetId);
    expect([again.status, again.body.runs[0]?.started]).toEqual([200, true]);
    expect(runs()).toHaveLength(1);
  });

  it('takes only the categories and Storage folders it is set to (a folder inside one too)', async () => {
    const folders = mongo.db.collection('storage_folders').docs;
    folders.push({ folderId: 'renders', projectId: 'p1', name: 'Renders', parentId: null });
    folders.push({ folderId: 'mixes', projectId: 'p1', name: 'Mixes', parentId: 'renders' });
    folders.push({ folderId: 'refs', projectId: 'p1', name: 'References', parentId: null });
    const pipeline = await newPipeline({ triggers: ['version_uploaded'], uploadFilter: { categories: ['audios'], folderIds: ['renders'] } });
    expect(pipeline.uploadFilter).toEqual({ categories: ['audios'], folderIds: ['renders'] });

    const inMixes = await asset({ folderId: 'mixes' });
    const inRefs = await asset({ folderId: 'refs', fileName: 'ref.wav' });
    const model = await asset({ category: '3d-models', fileName: 'rock.glb', contentType: 'model/gltf-binary', folderId: 'renders' });
    for (const [id, name] of [[inMixes, 'Mix'], [inRefs, 'Ref'], [model, 'Rock']]) {
      await cardFor(id, pipeline.id, name);
      put(`https://storage.test/put/${mongo.db.docs('storage_files').find((f: any) => f.fileId === id).storageKey}`, 'v2');
    }
    expect((await uploaded(inRefs)).body.runs).toEqual([]);
    expect((await uploaded(model)).body.runs).toEqual([]);
    expect((await uploaded(inMixes)).body.runs).toEqual([expect.objectContaining({ started: true })]);
  });

  it("is a pipeline's trigger with its filter, checked", async () => {
    const pipeline = await newPipeline({ triggers: ['version_uploaded'] });
    expect((await eli.get(`${P}/pipelines/${pipeline.id}`)).body.pipeline).toMatchObject({
      triggers: ['version_uploaded'], uploadFilter: { categories: [], folderIds: [] },
    });
    for (const uploadFilter of [{ categories: ['music'] }, { folderIds: [3] }, 'audios', []]) {
      expect((await eli.patch(`${P}/pipelines/${pipeline.id}`, { uploadFilter })).status).toBe(400);
    }
    expect((await eli.patch(`${P}/pipelines/${pipeline.id}`, { uploadFilter: { categories: ['videos'] } })).body.pipeline.uploadFilter)
      .toEqual({ categories: ['videos'], folderIds: [] });
    expect((await eli.patch(`${P}/pipelines/${pipeline.id}`, { uploadFilter: null })).body.pipeline.uploadFilter)
      .toEqual({ categories: [], folderIds: [] });
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
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text || 'null');
  };

  // As a DAW's render: the agent sets the pipeline up, uploads the new mix and says it's done.
  it('a version uploaded by an agent starts the run, with no step by hand', async () => {
    const client = await connect(await tokenFor(['assets:read', 'assets:write', 'workflow:write', 'workflow:read', 'production:write', 'jobs:run']));
    const pipeline = await call(client, 'create_pipeline', { projectId: 'p1', name: 'Mastering', triggers: ['version_uploaded'], uploadFilter: { categories: ['audios'] } });
    expect(pipeline.pipeline ?? pipeline).toMatchObject({ triggers: ['version_uploaded'], uploadFilter: { categories: ['audios'], folderIds: [] } });
    const pipelineId = (pipeline.pipeline ?? pipeline).id;
    const assetId = await asset();
    const card = await cardFor(assetId, pipelineId);

    const v2 = await call(client, 'request_asset_upload', { projectId: 'p1', category: 'audios', fileName: 'theme_v2.wav', contentType: 'audio/wav', assetId, sha256: hex('mix v2') });
    put(v2.upload.url, 'mix v2');
    const done = await call(client, 'complete_asset_upload', { projectId: 'p1', assetId, versionId: v2.versionId });
    expect(done.runs).toEqual([expect.objectContaining({ shotId: card.id, started: true })]);
    expect(runs().map((r: any) => r.trigger)).toEqual(['version_uploaded']);
  });

  it("a token that can't write assets doesn't get the tool", async () => {
    const names = (await (await connect(await tokenFor(['assets:read']))).listTools()).tools.map(t => t.name);
    expect(names).not.toContain('complete_asset_upload');
  });
});
