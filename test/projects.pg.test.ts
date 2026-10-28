import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';
import { registerModel, getModel } from '../src/models/manager';

// Against a local PostgreSQL (as pg.test.ts): the schema StreamBy makes at startup takes a
// project as the routes write it.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const NAME = `test-project-${Date.now()}`;

describe('projects in PostgreSQL', () => {
  beforeAll(async () => {
    await initConnections([{ id: 'pg-projects', type: 'sql', main: true, connectionString }]);
    registerModel('projects', ['pg-projects'], 'projects', 'streamby');
  });

  afterAll(async () => {
    const pool = getConnection('pg-projects').client as Pool;
    await pool.query('DELETE FROM streamby.projects WHERE name = $1', [NAME]);
  });

  it('makes a project as POST /projects/create does, and keeps its connections', async () => {
    const Project = getModel('projects');
    const created: any = await Project.create({
      dbType: 'sql', name: NAME, description: '', image: '', allowedOrigin: [], public: false, category: 'film',
      members: [{ userId: 'u1', username: 'u1', role: 'admin', status: 'active', archived: false }],
      dbConnections: [], storageConnections: [], integrationConnections: [],
    } as any);
    const id = created._id ?? created.id;

    await Project.update({ _id: id }, {
      integrationConnections: [{ id: 'ic1', provider: 'claude', integrationId: 'i1', source: 'integration' }],
      distributionConnections: [{ id: 'd1', name: 'CDN' }],
      renderFarmConnections: [{ id: 'r1', name: 'Farm' }],
    } as any);

    const stored: any = await Project.findOne({ _id: id });
    expect(stored).toMatchObject({ name: NAME, public: false, category: 'film' });
    expect(stored.integrationConnections.map((c: any) => c.id)).toEqual(['ic1']);
    expect(stored.distributionConnections.map((c: any) => c.id)).toEqual(['d1']);
    expect(stored.renderFarmConnections.map((c: any) => c.id)).toEqual(['r1']);
    expect(stored.members.map((m: any) => m.userId)).toEqual(['u1']);
  });

  // Deleting an account's integration disconnects the project connections using it: the
  // projects are asked for by it, not all read and filtered.
  it("finds the projects one of whose connections uses an integration, by it", async () => {
    const Project = getModel('projects');
    const made = async (suffix: string, lists: Record<string, unknown[]>) => {
      const created: any = await Project.create({
        dbType: 'sql', name: `${NAME}${suffix}`, description: '', image: '', allowedOrigin: [], public: false, category: 'film',
        members: [{ userId: 'u1', username: 'u1', role: 'admin', status: 'active', archived: false }],
        dbConnections: [], storageConnections: [], integrationConnections: [], ...lists,
      } as any);
      return String(created._id ?? created.id);
    };
    const usesIt = await made('-db', { dbConnections: [{ id: 'c1', integrationId: 'int-find', source: 'integration' }] });
    const usesItToo = await made('-svc', { integrationConnections: [{ id: 'c2', integrationId: 'int-find', source: 'integration' }] });
    await made('-other', { storageConnections: [{ id: 'c3', integrationId: 'int-other', source: 'integration' }] });
    const found: any[] = await Project.find({ connectedIntegration: 'int-find' });
    expect(found.map(p => String(p._id ?? p.id)).sort()).toEqual([usesIt, usesItToo].sort());
    const pool = getConnection('pg-projects').client as Pool;
    await pool.query('DELETE FROM streamby.projects WHERE name LIKE $1', [`${NAME}-%`]);
  });
});
