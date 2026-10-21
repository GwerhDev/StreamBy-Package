import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';
import { registerModel } from '../src/models/manager';
import { createApiToken, listApiTokens, resolveApiToken, revokeApiToken } from '../src/services/apiTokens';

// Against a local PostgreSQL (as pg.test.ts): what's stored, read back as SQL gives it.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const config = { storageProviders: [], authProvider: async () => ({}) as any, databases: [{ id: 'pg-tokens', type: 'sql' as const, main: true, connectionString }] };
const USER = `test-api-tokens-${Date.now()}`;

describe('API tokens in PostgreSQL', () => {
  beforeAll(async () => {
    await initConnections(config.databases);
    registerModel('api_tokens', ['pg-tokens'], 'api_tokens', 'streamby');
  });

  afterAll(async () => {
    const pool = getConnection('pg-tokens').client as Pool;
    // Only the rows made here go; the pool stays (initConnections holds one of its clients).
    await pool.query('DELETE FROM streamby.api_tokens WHERE "userId" = $1', [USER]);
  });

  it('makes, resolves, marks as used, lists and revokes a token', async () => {
    const all = await createApiToken(USER, { name: 'all', access: 'write', projectIds: '*', expiresInDays: null }, config);
    const some = await createApiToken(USER, { name: 'some', access: 'read', projectIds: ['p1', 'p2'], expiresInDays: 7 }, config);

    expect(await resolveApiToken(all.token)).toMatchObject({ userId: USER, scope: { access: 'write', projectIds: '*' } });
    expect(await resolveApiToken(some.token)).toMatchObject({ userId: USER, scope: { access: 'read', projectIds: ['p1', 'p2'] } });

    await new Promise(resolve => setTimeout(resolve, 200));
    const listed = await listApiTokens(USER);
    expect(listed.map(t => t.name).sort()).toEqual(['all', 'some']);
    expect(listed.every(t => t.lastUsedAt)).toBe(true);
    expect(listed.find(t => t.name === 'all')?.projectIds).toBe('*');
    expect(JSON.stringify(listed)).not.toContain(all.token);

    expect(await revokeApiToken(USER, some.info.id)).toBe(true);
    expect(await resolveApiToken(some.token)).toBeNull();
    expect(await resolveApiToken(all.token)).not.toBeNull();
  });

  it('an expired one no longer resolves', async () => {
    const { token, info } = await createApiToken(USER, { name: 'soon gone', access: 'read', projectIds: ['p1'], expiresInDays: 7 }, config);
    const pool = getConnection('pg-tokens').client as Pool;
    await pool.query(`UPDATE streamby.api_tokens SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [info.id]);
    expect(await resolveApiToken(token)).toBeNull();
  });
});
