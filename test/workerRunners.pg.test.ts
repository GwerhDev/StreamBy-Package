import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';
import { registerModel } from '../src/models/manager';
import { runnerByToken, checkDeclaration, keepDeclaration, listOwnRunners, registerRunner, revokeRunner } from '../src/services/workerRunners';

// Against a local PostgreSQL (as pg.test.ts): a runner, what it declares and its shares, read
// back as SQL gives them.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const config: any = { storageProviders: [], authProvider: async () => ({}), databases: [{ id: 'pg-runners', type: 'sql', main: true, connectionString }] };
const USER = `test-runners-${Date.now()}`;

describe('worker runners in PostgreSQL', () => {
  beforeAll(async () => {
    await initConnections(config.databases);
    registerModel('worker_runners', ['pg-runners'], 'worker_runners', 'streamby');
    registerModel('worker_runner_shares', ['pg-runners'], 'worker_runner_shares', 'streamby');
    registerModel('projects', ['pg-runners'], 'projects', 'streamby');
  });

  afterAll(async () => {
    const pool = getConnection('pg-runners').client as Pool;
    await pool.query('DELETE FROM streamby.worker_runners WHERE "userId" = $1', [USER]);
  });

  it('registers a runner, finds it by its token, keeps what it declares, and revokes it', async () => {
    const { token, runner } = await registerRunner({ userId: USER, username: 'ada', role: 'viewer' }, { name: 'Render node' }, config);
    const found = await runnerByToken(`Bearer ${token}`);
    expect(found).toMatchObject({ id: runner.id, userId: USER, kinds: [], lastSeenAt: null });

    await keepDeclaration(found!, checkDeclaration({ kinds: ['render', 'lod'], categories: ['3d-models', 'images'], timeoutSeconds: 7200 }));
    const [listed] = await listOwnRunners(USER);
    expect(listed).toMatchObject({ id: runner.id, kinds: ['render', 'lod'], categories: ['3d-models', 'images'], online: true, shares: [] });
    expect((await runnerByToken(`Bearer ${token}`))!.timeoutSeconds).toBe(7200);

    expect(await revokeRunner(USER, runner.id)).toBe(true);
    expect(await runnerByToken(`Bearer ${token}`)).toBeNull();
  });
});
