import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Records in memory, by model (nothing connected: a route that reaches past the project model
// fails further on, never with a 401/403/404 of its own checks).
const store: Record<string, any[]> = {};
const matches = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matches(r, filter)),
    findOne: async (filter: any) => rows().find(r => matches(r, filter)) ?? null,
    create: async (doc: any) => { const { dbType: _d, ...row } = doc; rows().push(row); return row; },
    update: async (filter: any, data: any) => {
      const row = rows().find(r => matches(r, filter));
      if (row && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(row, data);
      return row ?? null;
    },
    delete: async (filter: any) => { const before = rows().length; store[name] = rows().filter(r => !matches(r, filter)); return before - store[name].length; },
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
const { resolveApiToken, createApiToken, API_TOKEN_PREFIX } = await import('../src/services/apiTokens');

// A host as Nhexa-API: StreamBy under /streamby, its authProvider resolving API tokens.
let server: http.Server;
let base = '';
const startHost = async (mcp?: object) => {
  const app = express();
  app.use(express.json());
  app.use('/streamby', createStreamByRouter({
    storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
    ...(mcp ? { mcp } : {}),
    authProvider: async (req) => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      if (bearer?.startsWith(API_TOKEN_PREFIX)) {
        const resolved = await resolveApiToken(bearer);
        if (!resolved) throw new Error('Invalid API token');
        return { userId: resolved.userId, username: resolved.userId, role: 'viewer', apiToken: resolved.scope };
      }
      const user = req.headers['x-test-user'] as string | undefined;
      if (!user) throw new Error('No session');
      return { userId: user, username: user, role: 'viewer' };
    },
  }));
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/streamby`;
};
afterEach(async () => { await new Promise(resolve => server?.close(resolve)); });

const tokenFor = async (userId: string, access: 'read' | 'write', projectIds: string[] | '*') =>
  (await createApiToken(userId, { name: 'agent', access, projectIds, expiresInDays: 30 }, { databases: [] } as any)).token;

// An MCP client (as Claude Code is), connected with a token.
const connect = async (token: string) => {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
};
const textOf = (result: any) => result.content?.[0]?.text as string;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [
    { _id: 'p1', id: 'p1', name: 'Alpha', dbType: 'sql', members: [
      { userId: 'eli', role: 'editor', status: 'active' }, { userId: 'vic', role: 'viewer', status: 'active' }] },
    { _id: 'p2', id: 'p2', name: 'Beta', dbType: 'sql', members: [{ userId: 'eli', role: 'editor', status: 'active' }] },
  ];
});

describe('the MCP server', () => {
  it('lists only the reading tools for a read token, and the writing ones too for a write token', async () => {
    await startHost();
    const reader = await connect(await tokenFor('eli', 'read', ['p1']));
    const readNames = (await reader.listTools()).tools.map(t => t.name);
    expect(readNames).toContain('list_projects');
    expect(readNames).not.toContain('create_pipeline');
    const writer = await connect(await tokenFor('eli', 'write', ['p1']));
    expect((await writer.listTools()).tools.map(t => t.name)).toContain('create_pipeline');
  });

  it("reaches only the token's projects", async () => {
    await startHost();
    const client = await connect(await tokenFor('eli', 'read', ['p1']));
    const projects = JSON.parse(textOf(await client.callTool({ name: 'list_projects', arguments: {} })));
    expect(projects.map((p: any) => p.id)).toEqual(['p1']);
    expect((await client.callTool({ name: 'get_project', arguments: { projectId: 'p1' } })).isError).toBeFalsy();
    const other = await client.callTool({ name: 'get_project', arguments: { projectId: 'p2' } });
    expect(other.isError).toBe(true);
    expect(textOf(other)).toMatch(/not found/i);
  });

  it('a write tool goes only as far as its owner can', async () => {
    await startHost();
    // Vic is a viewer of p1: a write token of theirs is turned down there.
    const viewer = await connect(await tokenFor('vic', 'write', ['p1']));
    const denied = await viewer.callTool({ name: 'create_pipeline', arguments: { projectId: 'p1', name: 'Ingest' } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/unauthorized|permission/i);
    // Eli edits p1: past the checks (the pipeline store itself isn't connected here).
    const editor = await connect(await tokenFor('eli', 'write', ['p1']));
    const passed = await editor.callTool({ name: 'create_pipeline', arguments: { projectId: 'p1', name: 'Ingest' } });
    expect(textOf(passed)).not.toMatch(/unauthorized|permission|not found/i);
  });

  it('records every tool call: who, which token, which project, which tool, how it went', async () => {
    await startHost();
    const token = await tokenFor('eli', 'read', ['p1']);
    const client = await connect(token);
    await client.callTool({ name: 'get_project', arguments: { projectId: 'p1' } });
    await client.callTool({ name: 'get_project', arguments: { projectId: 'p2' } });
    const tokenId = store.api_tokens[0].id;
    expect(store.mcp_audit.map(({ userId, tokenId: t, projectId, tool, ok, status }) => ({ userId, t, projectId, tool, ok, status }))).toEqual([
      { userId: 'eli', t: tokenId, projectId: 'p1', tool: 'get_project', ok: true, status: 200 },
      { userId: 'eli', t: tokenId, projectId: 'p2', tool: 'get_project', ok: false, status: 404 },
    ]);
    expect(JSON.stringify(store.mcp_audit)).not.toContain(token);
  });

  it('limits the requests of a token', async () => {
    await startHost({ rateLimit: { requests: 3, windowMs: 60_000 } });
    const token = await tokenFor('eli', 'read', ['p1']);
    const post = () => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    for (let i = 0; i < 3; i++) expect((await post()).status).not.toBe(429);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('takes only an API token', async () => {
    await startHost();
    const session = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'x-test-user': 'eli', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(session.status).toBe(401);
    const none = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(401);
  });
});
