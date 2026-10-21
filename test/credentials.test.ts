import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The user integrations a test has, by id (the model the services read them from).
const integrations = new Map<string, any>();
vi.mock('../src/models/manager', () => ({
  getModel: () => ({ findOne: async ({ id }: { id: string }) => integrations.get(id) ?? null, update: async () => {} }),
}));

const { setEncryptionKey, encrypt } = await import('../src/utils/encryption');
const { getDecryptedIntegrationCredentialById } = await import('../src/services/userIntegration');
const { executeExport, NodeExecutionError } = await import('../src/services/executor');
const { isServiceEndpoint } = await import('../src/utils/serviceEndpoints');

setEncryptionKey('ab'.repeat(32));

const CLAUDE_KEY = 'sk-ant-owners-key';
const member = (userId: string, over: object = {}) => ({ userId, role: 'editor', status: 'active', archived: false, ...over });
// A project where Ana connected her Claude integration, Beto being another member.
const projectWith = (members: object[]) => ({
  id: 'p1', members,
  integrationConnections: [{ id: 'ic1', provider: 'claude', integrationId: 'claude-ana', projectId: 'p1', source: 'integration' }],
  dbConnections: [{ id: 'db-byoc', dbType: 'postgresql', source: 'integration', integrationId: 'pg-ana' }],
});
const claudeNode = (endpoint: string) => ({
  nodes: [{ id: 'n1', type: 'integrationConnectionNode', data: { connectionId: 'ic1', endpoint, method: 'POST', body: { prompt: 'hi' } } }],
  edges: [{ source: 'n1', target: 'streamby', targetHandle: 'in-bottom', sourceHandle: 'out' }],
});

const fetchMock = vi.fn();
beforeEach(() => {
  integrations.clear();
  integrations.set('claude-ana', { id: 'claude-ana', userId: 'ana', kind: 'service', provider: 'claude', encryptedCredential: encrypt(CLAUDE_KEY) });
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ answer: 42 }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('isServiceEndpoint', () => {
  it("is its provider's API, over https", () => {
    expect(isServiceEndpoint('claude', 'https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isServiceEndpoint('jira', 'https://api.atlassian.com/ex/jira/abc/rest/api/3/issue')).toBe(true);
    expect(isServiceEndpoint('jira', 'https://acme.atlassian.net/rest/api/3/issue')).toBe(true);
    expect(isServiceEndpoint('google', 'https://www.googleapis.com/drive/v3/files')).toBe(true);
  });

  it('is nowhere else, however it is dressed up', () => {
    for (const endpoint of [
      'https://evil.example.com/v1/messages', 'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com.evil.example.com',
      'https://api.anthropic.com@evil.example.com', 'https://user:pw@api.anthropic.com', 'https://api.anthropic.com:8443/v1',
      'https://acme.atlassian.net/x', '/v1/messages', '',
    ]) {
      expect(isServiceEndpoint('claude', endpoint), endpoint).toBe(false);
    }
    expect(isServiceEndpoint('google', 'https://evilgoogleapis.com')).toBe(false);
    expect(isServiceEndpoint('jira', 'https://atlassian.net.evil.example.com')).toBe(false);
  });
});

describe('getDecryptedIntegrationCredentialById', () => {
  it("resolves an integration in a project its owner is an active member of", async () => {
    const resolved = await getDecryptedIntegrationCredentialById('claude-ana', {} as any, projectWith([member('ana'), member('beto')]));
    expect(resolved?.credential).toBe(CLAUDE_KEY);
  });

  // Leaving a project takes the member out of it.
  it("never resolves it for a project its owner isn't in (never was, or left) or hasn't joined yet", async () => {
    for (const members of [[member('beto')], [member('ana', { status: 'pending' }), member('beto')]]) {
      expect(await getDecryptedIntegrationCredentialById('claude-ana', {} as any, projectWith(members))).toBeNull();
    }
  });

  // A member's archived flag is only them having archived the project in their own list.
  it('still resolves it for an owner who archived the project in their list', async () => {
    const resolved = await getDecryptedIntegrationCredentialById('claude-ana', {} as any, projectWith([member('ana', { archived: true })]));
    expect(resolved?.credential).toBe(CLAUDE_KEY);
  });
});

describe('executeExport', () => {
  // The server's storage, configured (nothing is reached).
  const config = { storageProviders: [{ id: 's3', type: 's3', config: { bucket: 'b', region: 'us-east-1', accessKeyId: 'x', secretAccessKey: 'y' } }] } as any;
  const run = (schema: any, project: any, isPublic?: boolean) => executeExport(schema, project, config, { public: isPublic });

  describe('an integration node, signed in', () => {
    it("calls its provider's API with the owner's credential", async () => {
      const result = await run(claudeNode('https://api.anthropic.com/v1/messages'), projectWith([member('ana'), member('beto')]), false);
      expect(result).toEqual({ answer: 42 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(init.headers['x-api-key']).toBe(CLAUDE_KEY);
      expect(init.redirect).toBe('error');
    });

    // A member pointing the node at a server of their own to catch someone else's key.
    it('never sends the credential anywhere but its provider', async () => {
      await expect(run(claudeNode('https://evil.example.com/catch'), projectWith([member('ana'), member('beto')]), false))
        .rejects.toBeInstanceOf(NodeExecutionError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("doesn't run once its owner left the project", async () => {
      await expect(run(claudeNode('https://api.anthropic.com/v1/messages'), projectWith([member('beto')]), false))
        .rejects.toThrow(/could not be resolved/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a public export (no session)', () => {
    it('reads data: static JSON runs', async () => {
      const schema = {
        nodes: [{ id: 'j', type: 'jsonInputNode', data: { jsonString: '{"menu":[1,2]}' } }],
        edges: [{ source: 'j', target: 'streamby', targetHandle: 'in-bottom', sourceHandle: 'out' }],
      };
      expect(await run(schema, projectWith([member('ana')]))).toEqual({ menu: [1, 2] });
    });

    it("never runs a node with someone's account credential", async () => {
      await expect(run(claudeNode('https://api.anthropic.com/v1/messages'), projectWith([member('ana')]))).rejects.toThrow(/can't run in a public export/);
      const byoc = {
        nodes: [{ id: 'd', type: 'dataSourceNode', data: { tableName: 't', connectionId: 'db-byoc' } }],
        edges: [{ source: 'd', target: 'streamby', targetHandle: 'in-bottom', sourceHandle: 'out' }],
      };
      await expect(run(byoc, projectWith([member('ana')]))).rejects.toThrow(/can't run in a public export/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never starts a job', async () => {
      const schema = {
        nodes: [{ id: 't', type: 'transcodeNode', data: { fileId: 'f1' } }],
        edges: [{ source: 'streamby', sourceHandle: 'out-top', target: 't', targetHandle: 'in-process' }],
      };
      await expect(run(schema, projectWith([member('ana')]))).rejects.toThrow(/can't run in a public export/);
    });
  });
});
