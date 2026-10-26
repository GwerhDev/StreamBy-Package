import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';

// Stored records in memory, by model; every write recorded.
const store: Record<string, any[]> = { projects: [], user_integrations: [] };
const writes: { model: string; filter: any; data: any }[] = [];
const fakeModel = (name: string): any => {
  const model: any = {
    find: async () => store[name] ?? [],
    findOne: async (q: any) => (store[name] ?? []).find(r => r._id === q?._id || (q?.id && r.id === q.id)) ?? null,
    create: async (doc: any) => doc,
    update: async (filter: any, data: any) => {
      writes.push({ model: name, filter, data });
      const record = (store[name] ?? []).find(r => r._id === filter?._id || (filter?.id && r.id === filter.id));
      if (record && !Object.keys(data).some(k => k.startsWith('$'))) Object.assign(record, data);
      return record;
    },
  };
  model.useDbType = () => model;
  return model;
};
// A worker's name resolves to a public address (no network in tests).
vi.mock('dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('dns')>();
  return { ...original, promises: { ...original.promises, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } };
});
vi.mock('../src/models/manager', () => ({ getModel: (name: string) => fakeModel(name), registerModel: () => {} }));
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/database/connectionManager')>()),
  initConnections: async () => {},
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));

const { setEncryptionKey, encrypt, decrypt, isCurrentEncryption } = await import('../src/utils/encryption');
const { reencryptStoredCredentials } = await import('../src/services/reencryptCredentials');

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
// A value as it was stored before: AES-256-CBC, "<iv hex>:<ciphertext hex>".
const legacyEncrypt = (text: string, keyHex: string) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
  return iv.toString('hex') + ':' + Buffer.concat([cipher.update(text), cipher.final()]).toString('hex');
};

beforeEach(() => {
  setEncryptionKey(KEY_A);
  store.projects = [];
  store.user_integrations = [];
  writes.length = 0;
});

describe('encryption', () => {
  it('is AES-GCM naming its key, and decrypts back', () => {
    const stored = encrypt('sk-secret');
    expect(stored).toMatch(/^v2:[0-9a-f]{16}:/);
    expect(stored).not.toContain('sk-secret');
    expect(decrypt(stored)).toBe('sk-secret');
    expect(encrypt('sk-secret')).not.toBe(stored);
  });

  it('tells an altered value apart, instead of decrypting it to garbage', () => {
    const parts = encrypt('sk-secret').split(':');
    const ct = Buffer.from(parts[4], 'base64url');
    ct[0] ^= 1;
    parts[4] = ct.toString('base64url');
    expect(() => decrypt(parts.join(':'))).toThrow(/altered/);
  });

  it('still reads what was stored before (CBC)', () => {
    expect(decrypt(legacyEncrypt('old-secret', KEY_A))).toBe('old-secret');
  });

  it('rotates: a value of a previous key still decrypts; new ones use the current key', () => {
    const withA = encrypt('secret');
    setEncryptionKey(KEY_B, [KEY_A]);
    expect(decrypt(withA)).toBe('secret');
    expect(isCurrentEncryption(withA)).toBe(false);
    expect(isCurrentEncryption(encrypt('secret'))).toBe(true);
    // Without the previous key, it's said so.
    setEncryptionKey(KEY_B);
    expect(() => decrypt(withA)).toThrow(/not configured/);
  });
});

describe('reencryptStoredCredentials', () => {
  it('brings every stored credential to the current encryption, plain ones included', async () => {
    store.projects = [{
      _id: 'p1',
      connections: [{ id: 'c1', encryptedCredential: legacyEncrypt('api-token', KEY_A) }],
      dbConnections: [{ id: 'd1', encryptedCredential: legacyEncrypt('postgres://u:p@h/db', KEY_A) }, { id: 'd2', source: 'builtin' }],
      distributionConnections: [{ id: 'dist', encryptedCredential: 'plain-distribution-key' }],
      renderFarmConnections: [{ id: 'rf', encryptedCredential: 'plain-farm-key' }],
    }];
    store.user_integrations = [{ id: 'i1', encryptedCredential: legacyEncrypt('sk-ant', KEY_A), encryptedAccessToken: legacyEncrypt('at', KEY_A) }];

    expect(await reencryptStoredCredentials()).toEqual({ updated: 2, failed: 0 });
    const [project] = store.projects;
    const values = [
      project.connections[0], project.dbConnections[0], project.distributionConnections[0], project.renderFarmConnections[0],
    ].map(c => c.encryptedCredential);
    expect(values.every(isCurrentEncryption)).toBe(true);
    expect(values.map(decrypt)).toEqual(['api-token', 'postgres://u:p@h/db', 'plain-distribution-key', 'plain-farm-key']);
    expect(project.dbConnections[1]).toEqual({ id: 'd2', source: 'builtin' });
    expect(decrypt(store.user_integrations[0].encryptedCredential)).toBe('sk-ant');
    expect(decrypt(store.user_integrations[0].encryptedAccessToken)).toBe('at');

    // Once current, nothing changes.
    writes.length = 0;
    expect(await reencryptStoredCredentials()).toEqual({ updated: 0, failed: 0 });
    expect(writes).toEqual([]);
  });

  it('re-encrypts what a previous key holds with the current one', async () => {
    const withA = encrypt('secret');
    store.user_integrations = [{ id: 'i1', encryptedCredential: withA }];
    setEncryptionKey(KEY_B, [KEY_A]);
    await reencryptStoredCredentials();
    expect(isCurrentEncryption(store.user_integrations[0].encryptedCredential)).toBe(true);
    expect(decrypt(store.user_integrations[0].encryptedCredential)).toBe('secret');
  });

  // Non-destructive: a value is only ever replaced by its own re-encryption.
  it('leaves a value it can\'t decrypt as it is, and says so', async () => {
    const otherKey = legacyEncrypt('secret', 'cc'.repeat(32));
    store.projects = [{ _id: 'p1', connections: [{ id: 'c1', encryptedCredential: otherKey }] }];
    expect(await reencryptStoredCredentials()).toEqual({ updated: 0, failed: 1 });
    expect(store.projects[0].connections[0].encryptedCredential).toBe(otherKey);
  });
});

describe("a project's worker (render farms included)", () => {
  it('stores its credential encrypted, and never answers with it', async () => {
    store.projects = [{ _id: 'p1', id: 'p1', members: [{ userId: 'u1', role: 'editor', status: 'active' }] }];
    const { createStreamByRouter } = await import('../src/middleware/createRouter');
    const app = express();
    app.use(express.json());
    app.use(createStreamByRouter({
      storageProviders: [], adapter: {} as any, databases: [{ id: 'mongo', type: 'nosql', main: true }], encrypt: KEY_A,
      authProvider: async () => ({ userId: 'u1', username: 'u1', role: 'viewer' } as any),
    }));
    const res = await request(app).post('/projects/p1/workers')
      .send({ name: 'Farm', provider: 'deadline', endpoint: 'https://farm.example.com', credential: 'farm-secret', kinds: ['render'], categories: ['3d-models'] });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('farm-secret');
    const stored = writes.find(w => w.data?.$push?.renderFarmConnections)!.data.$push.renderFarmConnections;
    expect(isCurrentEncryption(stored.encryptedCredential)).toBe(true);
    expect(decrypt(stored.encryptedCredential)).toBe('farm-secret');
  });
});
