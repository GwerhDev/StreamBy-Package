import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Records in memory, by model, as in mcp.test.ts.
const store: Record<string, any[]> = {};
const matches = (record: any, filter: any = {}) =>
  Object.entries(filter).every(([k, v]) => (k === '_id' ? record._id === v || record.id === v : record[k] === v));
const fakeModel = (name: string): any => {
  const rows = () => (store[name] ??= []);
  const model: any = {
    find: async (filter: any) => rows().filter(r => matches(r, filter)),
    findOne: async (filter: any) => rows().find(r => matches(r, filter)) ?? null,
    create: async (doc: any) => { const { dbType: _d, ...row } = doc; rows().push(row); return row; },
    update: async (filter: any, data: any) => { const row = rows().find(r => matches(r, filter)); if (row) Object.assign(row, data); return row ?? null; },
    delete: async () => 0,
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
const {
  createOAuthTokenVerifier, permissionsForOAuthScopes, protectedResourceMetadata, defaultResourceMetadataUrl, looksLikeOAuthAccessToken,
} = await import('../src/services/oauthTokens');

// ── An authorization server's keys, and tokens it signs ──

const ISSUER = 'https://api.nhexa.test';
const MCP_RESOURCE = 'https://api.nhexa.test/streamby/mcp';
const AUDIENCES = ['https://api.nhexa.test/streamby', MCP_RESOURCE];

const keyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const kid = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url');
  return { privateKey, kid, jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' } };
};
const signer = keyPair();
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

const sign = (claims: Record<string, unknown>, { key = signer, header = {} }: { key?: ReturnType<typeof keyPair>; header?: object } = {}) => {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const body = b64(claims);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
};
const now = () => Math.floor(Date.now() / 1000);
const claimsFor = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, sub: 'eli', aud: MCP_RESOURCE, client_id: 'dyn_claude', scope: 'profile streamby:read',
  jti: crypto.randomUUID(), iat: now(), exp: now() + 3600, ...over,
});

const verifierWith = (keys: object[] = [signer.jwk]) => {
  let fetched = 0;
  const verify = createOAuthTokenVerifier({
    issuer: ISSUER, audiences: AUDIENCES, jwks: 'https://api.nhexa.test/.well-known/jwks.json',
    fetcher: async () => { fetched += 1; return new Response(JSON.stringify({ keys })); },
  });
  return { verify, fetched: () => fetched };
};

describe('an OAuth access token', () => {
  it("is the user's, for the app, with what its scopes grant, when the issuer's keys say it's genuine", async () => {
    const { verify } = verifierWith();
    const verified = await verify(sign(claimsFor()));
    expect(verified).toMatchObject({ userId: 'eli', clientId: 'dyn_claude', scopes: ['profile', 'streamby:read'] });
    expect(verified!.scope).toMatchObject({ kind: 'user', projectIds: '*', tokenId: 'oauth:dyn_claude:eli' });
    expect(verified!.scope.permissions).toContain('assets:read');
    expect(verified!.scope.permissions).not.toContain('assets:write');
  });

  it("is refused when it's for another resource, from another issuer, expired, or not yet valid", async () => {
    const { verify } = verifierWith();
    for (const over of [{ aud: 'https://api.nhexa.test/other' }, { aud: ['https://elsewhere.test'] }, { iss: 'https://evil.test' }, { exp: now() - 3600 }, { nbf: now() + 3600 }, { sub: '' }, { client_id: undefined }]) {
      expect(await verify(sign(claimsFor(over))), JSON.stringify(over)).toBeNull();
    }
    // An audience among several is enough.
    expect(await verify(sign(claimsFor({ aud: ['https://elsewhere.test', AUDIENCES[0]] })))).not.toBeNull();
  });

  it("is refused when it isn't signed by the issuer's key, or not with RS256", async () => {
    const { verify } = verifierWith();
    const token = sign(claimsFor());
    const [head, , signature] = token.split('.');
    // Its claims changed after signing (more scopes).
    expect(await verify(`${head}.${b64(claimsFor({ scope: 'streamby:write' }))}.${signature}`)).toBeNull();
    // Another key, claiming the issuer's id.
    const stranger = keyPair();
    expect(await verify(sign(claimsFor(), { key: { ...stranger, kid: signer.kid } }))).toBeNull();
    // An HMAC or unsigned token, whatever its claims.
    const hmac = `${b64({ alg: 'HS256', kid: signer.kid })}.${b64(claimsFor())}.${crypto.createHmac('sha256', 'x').update('y').digest('base64url')}`;
    expect(await verify(hmac)).toBeNull();
    expect(await verify(`${b64({ alg: 'none', kid: signer.kid })}.${b64(claimsFor())}.`)).toBeNull();
    expect(await verify('sbt_not-a-jwt')).toBeNull();
  });

  it("keeps the issuer's keys, and fetches them again for a key it doesn't know (a rotation)", async () => {
    const rotated = keyPair();
    let keys: object[] = [signer.jwk];
    let fetched = 0;
    let clock = Date.now();
    const verify = createOAuthTokenVerifier({
      issuer: ISSUER, audiences: AUDIENCES, jwks: async () => { fetched += 1; return { keys } as any; }, now: () => clock,
    });
    expect(await verify(sign(claimsFor()))).not.toBeNull();
    expect(await verify(sign(claimsFor()))).not.toBeNull();
    expect(fetched).toBe(1);

    keys = [rotated.jwk, signer.jwk];
    clock += 2 * 60 * 1000;
    expect(await verify(sign(claimsFor(), { key: rotated }))).not.toBeNull();
    expect(fetched).toBe(2);
    // An unknown key right after: not fetched again at once.
    expect(await verify(sign(claimsFor(), { key: keyPair() }))).toBeNull();
    expect(fetched).toBe(2);
  });

  it('is told from a session token by its shape', () => {
    expect(looksLikeOAuthAccessToken(sign(claimsFor()))).toBe(true);
    expect(looksLikeOAuthAccessToken(`${b64({ alg: 'HS256' })}.${b64({})}.x`)).toBe(false);
    expect(looksLikeOAuthAccessToken('sbt_x')).toBe(false);
    expect(looksLikeOAuthAccessToken(undefined)).toBe(false);
  });
});

describe('scopes', () => {
  it('grant reading, or making and changing; never deleting nor managing members', () => {
    const read = permissionsForOAuthScopes(['streamby:read']);
    expect(read.every(p => p.endsWith(':read'))).toBe(true);
    const write = permissionsForOAuthScopes(['streamby:write']);
    expect(write).toEqual(expect.arrayContaining([...read, 'assets:write', 'production:write', 'workflow:write', 'jobs:run', 'projects:create']));
    for (const never of ['assets:delete', 'production:delete', 'project:delete', 'members:manage']) {
      expect(write, never).not.toContain(never);
    }
    expect(permissionsForOAuthScopes(['profile', 'email'])).toEqual([]);
  });
});

describe('the protected resource metadata (RFC 9728)', () => {
  it("says where to sign in, and what to ask for", () => {
    expect(protectedResourceMetadata({ issuer: ISSUER, resource: MCP_RESOURCE })).toEqual({
      resource: MCP_RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['streamby:read', 'streamby:write'],
      bearer_methods_supported: ['header'], resource_name: 'StreamBy',
    });
  });

  it("lives at the resource's origin, before its path", () => {
    expect(defaultResourceMetadataUrl(MCP_RESOURCE)).toBe('https://api.nhexa.test/.well-known/oauth-protected-resource/streamby/mcp');
    expect(defaultResourceMetadataUrl('https://api.nhexa.test/')).toBe('https://api.nhexa.test/.well-known/oauth-protected-resource');
  });
});

// ── StreamBy, with a host whose authProvider takes OAuth access tokens ──

let server: http.Server | undefined;
let base = '';
const verify = createOAuthTokenVerifier({ issuer: ISSUER, audiences: AUDIENCES, jwks: async () => ({ keys: [signer.jwk] }) as any });
const startHost = async ({ withScope = true } = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/streamby', createStreamByRouter({
    storageProviders: [], adapter: {} as any, databases: [{ id: 'pg', type: 'sql', main: true }],
    oauth: { issuer: ISSUER, resource: MCP_RESOURCE },
    authProvider: async (req) => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      if (bearer?.startsWith(API_TOKEN_PREFIX)) {
        const resolved = await resolveApiToken(bearer);
        if (!resolved) throw new Error('Invalid API token');
        return { userId: resolved.userId, username: resolved.name, role: 'viewer', apiToken: resolved.scope };
      }
      if (looksLikeOAuthAccessToken(bearer)) {
        const verified = await verify(bearer);
        if (!verified) throw new Error('Invalid OAuth token');
        return {
          userId: verified.userId, username: verified.userId, role: 'viewer',
          oauth: { clientId: verified.clientId, clientName: 'Claude' },
          ...(withScope ? { apiToken: verified.scope } : {}),
        };
      }
      const user = req.headers['x-test-user'] as string | undefined;
      if (!user) throw new Error('No session');
      return { userId: user, username: user, role: 'viewer' };
    },
  }));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/streamby`;
};
afterEach(async () => {
  if (server) await new Promise(resolve => server!.close(resolve));
  server = undefined;
});
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.projects = [{ _id: 'p1', id: 'p1', name: 'Alpha', dbType: 'sql', members: [{ userId: 'eli', role: 'editor', status: 'active' }] }];
});

const connect = async (token: string) => {
  const client = new Client({ name: 'claude.ai', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const toolsList = (headers: Record<string, string>) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

describe('StreamBy as an OAuth protected resource', () => {
  it('tells a client without a token where to sign in', async () => {
    await startHost();
    const none = await toolsList({});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://api.nhexa.test/.well-known/oauth-protected-resource/streamby/mcp"');
    // A token it refused: the same, and why.
    const expired = await toolsList({ Authorization: `Bearer ${sign(claimsFor({ exp: now() - 3600 }))}` });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // A browser session reaches the router, but isn't for the MCP server.
    const session = await toolsList({ 'x-test-user': 'eli' });
    expect(session.status).toBe(401);
    expect(session.headers.get('www-authenticate')).toContain('resource_metadata=');

    const meta = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(meta.status).toBe(200);
    expect((await meta.json()).authorization_servers).toEqual([ISSUER]);
  });

  it('gives an app only the tools its scopes grant, and records its calls by its client', async () => {
    await startHost();
    const reader = await connect(sign(claimsFor({ scope: 'profile streamby:read' })));
    const names = (await reader.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_projects', 'get_project', 'list_assets']));
    expect(names).not.toContain('create_pipeline');
    expect(names).not.toContain('delete_asset');

    await reader.callTool({ name: 'get_project', arguments: { projectId: 'p1' } });
    expect(store.mcp_audit.map(({ userId, tokenId, oauthClientId, tool, ok }) => ({ userId, tokenId, oauthClientId, tool, ok }))).toEqual([
      { userId: 'eli', tokenId: null, oauthClientId: 'dyn_claude', tool: 'get_project', ok: true },
    ]);

    const writer = await connect(sign(claimsFor({ scope: 'streamby:write' })));
    const writeNames = (await writer.listTools()).tools.map(t => t.name);
    expect(writeNames).toEqual(expect.arrayContaining(['create_pipeline', 'update_shot', 'request_asset_upload']));
    expect(writeNames).not.toContain('delete_asset');
    expect(writeNames).not.toContain('delete_project');
  });

  it("reaches no route its scopes don't grant", async () => {
    await startHost();
    const token = sign(claimsFor({ scope: 'profile' }));
    const project = await fetch(`${base}/projects/p1`, { headers: { Authorization: `Bearer ${token}` } });
    expect(project.status).toBe(403);
  });

  it("is refused when the host vouches for an app without the scope it's limited to", async () => {
    await startHost({ withScope: false });
    const res = await fetch(`${base}/projects/p1`, { headers: { Authorization: `Bearer ${sign(claimsFor())}` } });
    expect(res.status).toBe(401);
  });

  // project:update, workflow:write and exports:write reach routes that delete: an app's
  // consent is to make and change things, so it deletes nothing (but a deliverable's mark).
  it('lets an app with streamby:write delete nothing: no connection, worker, pipeline nor export', async () => {
    await startHost();
    const token = sign(claimsFor({ scope: 'streamby:write' }));
    for (const path of ['/projects/p1/connections/storage/c1', '/projects/p1/workers/w1', '/projects/p1/pipelines/pl1', '/projects/p1/exports/e1', '/projects/p1/integrations/i1']) {
      const res = await fetch(`${base}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(403);
      expect((await res.json()).error, path).toMatch(/OAuth can't delete/);
    }
    // Changing them is what it was approved for.
    const changed = await fetch(`${base}/projects/p1/pipelines/pl1`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(changed.status).not.toBe(403);
  });

  it("lets an app take a deliverable's mark off (the asset stays)", async () => {
    await startHost();
    const res = await fetch(`${base}/projects/p1/deliverables/d1`, { method: 'DELETE', headers: { Authorization: `Bearer ${sign(claimsFor({ scope: 'streamby:write' }))}` } });
    // Past the scope's checks: what answers is the route itself (no database here).
    expect(res.status).not.toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/OAuth/);
  });

  it('an API token with project:update still deletes connections', async () => {
    await startHost();
    const { token } = await createApiToken({ kind: 'user', userId: 'eli' }, { name: 'ci', permissions: ['project:update'], projectIds: ['p1'], expiresInDays: 30 }, { databases: [] } as any);
    const res = await fetch(`${base}/projects/p1/connections/storage/c1`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).not.toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/OAuth|permission/);
  });
});
