import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';
import { jobStore, setJobStoreDatabase } from '../src/services/jobStore';

// Against a local PostgreSQL (as pg.test.ts): jobs as the main database keeps them.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const config: any = { storageProviders: [], authProvider: async () => ({}), databases: [{ id: 'pg-jobs', type: 'sql', main: true, connectionString }] };
const PROJECT = `test-jobs-${Date.now()}`;

const newJob = (over: object = {}) => ({
  jobId: crypto.randomUUID(), jobType: 'process' as const, userId: 'u1', projectId: PROJECT, assetId: 'a1',
  status: 'pending' as const, stage: 'queued', progress: 0, payload: { callbackBase: 'https://x' },
  worker: { source: 'builtin' as const, id: 'w', name: 'W' }, kind: 'lod', profile: { levels: 3 }, resultMode: 'derived' as const,
  attempts: 0, maxAttempts: 3, nextAttemptAt: new Date(Date.now() - 1000), createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('jobs in PostgreSQL', () => {
  beforeAll(async () => {
    await initConnections(config.databases);
    setJobStoreDatabase(config);
  });

  afterAll(async () => {
    const pool = getConnection('pg-jobs').client as Pool;
    await pool.query('DELETE FROM streamby.jobs WHERE "projectId" = $1', [PROJECT]);
  });

  it('keeps a job, its JSON fields and dates, as given', async () => {
    const job = newJob();
    await jobStore().insert(job);
    const back = await jobStore().get(job.jobId);
    expect(back).toMatchObject({ jobId: job.jobId, status: 'pending', worker: { id: 'w' }, profile: { levels: 3 }, payload: { callbackBase: 'https://x' } });
    expect(new Date(back!.nextAttemptAt!).getTime()).toBe(job.nextAttemptAt.getTime());
    expect((await jobStore().list({ projectId: PROJECT })).map(j => j.jobId)).toContain(job.jobId);
  });

  it('lets only one of several claims take a job', async () => {
    const job = newJob();
    await jobStore().insert(job);
    const claims = await Promise.all(Array.from({ length: 5 }, () =>
      jobStore().claim(job.jobId, ['pending'], { status: 'processing', stage: 'sent', updatedAt: new Date() })));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('claims by token and by lease', async () => {
    const job = newJob({ status: 'processing', callbackHash: 'a'.repeat(64), leaseUntil: new Date(Date.now() + 60_000) });
    await jobStore().insert(job);
    expect(await jobStore().claim(job.jobId, ['processing'], { stage: 'x' }, { callbackHash: 'b'.repeat(64) })).toBeNull();
    expect(await jobStore().claim(job.jobId, ['processing'], { stage: 'x' }, { leaseEndedBy: new Date() })).toBeNull();
    expect(await jobStore().claim(job.jobId, ['processing'], { stage: 'y' }, { callbackHash: 'a'.repeat(64) })).toMatchObject({ stage: 'y' });
  });

  it('finds the jobs due: pending and due, or with their lease ended', async () => {
    const due = newJob();
    const later = newJob({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const expired = newJob({ status: 'processing', leaseUntil: new Date(Date.now() - 1000) });
    const running = newJob({ status: 'processing', leaseUntil: new Date(Date.now() + 60_000) });
    const plain = newJob({ worker: null });
    for (const job of [due, later, expired, running, plain]) await jobStore().insert(job);
    const ids = (await jobStore().due(new Date(), 500)).map(j => j.jobId);
    expect(ids).toEqual(expect.arrayContaining([due.jobId, expired.jobId]));
    for (const id of [later.jobId, running.jobId, plain.jobId]) expect(ids).not.toContain(id);
  });

  it("deletes a project's jobs, and only its", async () => {
    const other = `${PROJECT}-other`;
    await jobStore().insert(newJob());
    await jobStore().insert(newJob({ projectId: other }));
    await jobStore().deleteProject(other);
    expect(await jobStore().list({ projectId: other })).toEqual([]);
    expect((await jobStore().list({ projectId: PROJECT })).length).toBeGreaterThan(0);
  });
});
