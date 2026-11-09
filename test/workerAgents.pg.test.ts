import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';
import { registerModel } from '../src/models/manager';
import { agentByToken, checkDeclaration, keepDeclaration, listOwnAgents, registerAgent, revokeAgent } from '../src/services/workerAgents';

// Against a local PostgreSQL (as pg.test.ts): an agent, what it declares and its shares, read
// back as SQL gives them.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const config: any = { storageProviders: [], authProvider: async () => ({}), databases: [{ id: 'pg-agents', type: 'sql', main: true, connectionString }] };
const USER = `test-agents-${Date.now()}`;

describe('worker agents in PostgreSQL', () => {
  beforeAll(async () => {
    await initConnections(config.databases);
    registerModel('worker_agents', ['pg-agents'], 'worker_agents', 'streamby');
    registerModel('worker_agent_shares', ['pg-agents'], 'worker_agent_shares', 'streamby');
    registerModel('projects', ['pg-agents'], 'projects', 'streamby');
  });

  afterAll(async () => {
    const pool = getConnection('pg-agents').client as Pool;
    await pool.query('DELETE FROM streamby.worker_agents WHERE "userId" = $1', [USER]);
  });

  it('registers an agent, finds it by its token, keeps what it declares, and revokes it', async () => {
    const { token, agent } = await registerAgent({ userId: USER, username: 'ada', role: 'viewer' }, { name: 'Render node' }, config);
    const found = await agentByToken(`Bearer ${token}`);
    expect(found).toMatchObject({ id: agent.id, userId: USER, kinds: [], lastSeenAt: null });

    await keepDeclaration(found!, checkDeclaration({ kinds: ['render', 'lod'], categories: ['3d-models', 'images'], timeoutSeconds: 7200 }));
    const [listed] = await listOwnAgents(USER);
    expect(listed).toMatchObject({ id: agent.id, kinds: ['render', 'lod'], categories: ['3d-models', 'images'], online: true, shares: [] });
    expect((await agentByToken(`Bearer ${token}`))!.timeoutSeconds).toBe(7200);

    expect(await revokeAgent(USER, agent.id)).toBe(true);
    expect(await agentByToken(`Bearer ${token}`)).toBeNull();
  });
});
