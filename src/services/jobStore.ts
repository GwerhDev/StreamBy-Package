import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { JobRecord, StreamByConfig } from '../types';

// Where jobs are kept: the main database (a `streamby.jobs` table in PostgreSQL, a `jobs`
// collection in MongoDB), so they survive restarts and every instance sees the same ones.
// Changing a job's state goes through `claim`, a single conditional update: of several
// instances, only one takes a job. Without a main database connected (tests, a host without
// one), jobs are kept in memory, as before.

export interface JobStore {
  insert(job: JobRecord): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  list(filter: { projectId: string; assetId?: string; limit?: number }): Promise<JobRecord[]>;
  update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord | null>;
  /**
   * Changes a job only if it's still in one of `statuses` (any, if none), and, if given, its
   * lease ended by `leaseEndedBy` and its callback hash is `callbackHash`.
   */
  claim(jobId: string, statuses: JobRecord['status'][], patch: Partial<JobRecord>, only?: ClaimConditions): Promise<JobRecord | null>;
  /** Worker jobs to look at now: queued and due, or dispatched with their lease ended. */
  due(now: Date, limit: number): Promise<JobRecord[]>;
  /** A deleted project's jobs. */
  deleteProject(projectId: string): Promise<void>;
}

export interface ClaimConditions { leaseEndedBy?: Date; callbackHash?: string }

const JSON_FIELDS = new Set(['payload', 'report', 'result', 'worker', 'profile', 'upload']);

// ── PostgreSQL ──

const sqlStore = (pool: Pool): JobStore => {
  const table = 'streamby.jobs';
  const fromRow = (row: any): JobRecord | null => {
    if (!row) return null;
    const { id, ...job } = row;
    return { ...job, jobId: id } as JobRecord;
  };
  const toColumns = (patch: Partial<JobRecord>) => {
    const entries = Object.entries(patch).filter(([key, value]) => key !== 'jobId' && value !== undefined);
    return {
      names: entries.map(([key]) => `"${key}"`),
      values: entries.map(([key, value]) => (JSON_FIELDS.has(key) && value !== null ? JSON.stringify(value) : value)),
    };
  };
  return {
    async insert(job) {
      const { names, values } = toColumns(job);
      const placeholders = values.map((_, i) => `$${i + 2}`);
      const { rows } = await pool.query(
        `INSERT INTO ${table} (id, ${names.join(', ')}) VALUES ($1, ${placeholders.join(', ')}) RETURNING *`,
        [job.jobId, ...values],
      );
      return fromRow(rows[0])!;
    },
    async get(jobId) {
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [jobId]);
      return fromRow(rows[0]);
    },
    async list({ projectId, assetId, limit = 100 }) {
      const { rows } = await pool.query(
        `SELECT * FROM ${table} WHERE "projectId" = $1 ${assetId ? 'AND "assetId" = $3' : ''} ORDER BY "createdAt" DESC LIMIT $2`,
        assetId ? [projectId, limit, assetId] : [projectId, limit],
      );
      return rows.map(row => fromRow(row)!);
    },
    async update(jobId, patch) {
      return this.claim(jobId, [], patch);
    },
    async claim(jobId, statuses, patch, only = {}) {
      const { names, values } = toColumns(patch);
      const sets = names.map((name, i) => `${name} = $${i + 2}`).join(', ');
      const params: unknown[] = [jobId, ...values];
      let where = 'id = $1';
      if (statuses.length) {
        params.push(statuses);
        where += ` AND status = ANY($${params.length})`;
      }
      if (only.leaseEndedBy) {
        params.push(only.leaseEndedBy);
        where += ` AND ("leaseUntil" IS NULL OR "leaseUntil" <= $${params.length})`;
      }
      if (only.callbackHash) {
        params.push(only.callbackHash);
        where += ` AND "callbackHash" = $${params.length}`;
      }
      const { rows } = await pool.query(`UPDATE ${table} SET ${sets} WHERE ${where} RETURNING *`, params);
      return fromRow(rows[0]);
    },
    async due(now, limit) {
      const { rows } = await pool.query(
        `SELECT * FROM ${table}
          WHERE worker IS NOT NULL AND (
            (status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1))
            OR (status = 'processing' AND "leaseUntil" <= $1))
          ORDER BY "createdAt" LIMIT $2`,
        [now, limit],
      );
      return rows.map(row => fromRow(row)!);
    },
    async deleteProject(projectId) {
      await pool.query(`DELETE FROM ${table} WHERE "projectId" = $1`, [projectId]);
    },
  };
};

// ── MongoDB ──

const mongoStore = (client: MongoClient): JobStore => {
  const col = () => client.db().collection('jobs');
  const fromDoc = (doc: any): JobRecord | null => {
    if (!doc) return null;
    const { _id, ...job } = doc;
    return job as JobRecord;
  };
  const clean = (patch: Partial<JobRecord>) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  return {
    async insert(job) {
      await col().insertOne({ ...clean(job) });
      return job;
    },
    async get(jobId) {
      return fromDoc(await col().findOne({ jobId }));
    },
    async list({ projectId, assetId, limit = 100 }) {
      const docs = await col().find({ projectId, ...(assetId ? { assetId } : {}) }).sort({ createdAt: -1 }).limit(limit).toArray();
      return docs.map(doc => fromDoc(doc)!);
    },
    async update(jobId, patch) {
      return this.claim(jobId, [], patch);
    },
    async claim(jobId, statuses, patch, only = {}) {
      const filter: any = { jobId };
      if (statuses.length) filter.status = { $in: statuses };
      if (only.leaseEndedBy) filter.$or = [{ leaseUntil: null }, { leaseUntil: { $exists: false } }, { leaseUntil: { $lte: only.leaseEndedBy } }];
      if (only.callbackHash) filter.callbackHash = only.callbackHash;
      return fromDoc(await col().findOneAndUpdate(filter, { $set: clean(patch) }, { returnDocument: 'after' }));
    },
    async due(now, limit) {
      const docs = await col().find({
        worker: { $ne: null },
        $or: [
          { status: 'pending', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
          { status: 'processing', leaseUntil: { $lte: now } },
        ],
      }).sort({ createdAt: 1 }).limit(limit).toArray();
      return docs.map(doc => fromDoc(doc)!);
    },
    async deleteProject(projectId) {
      await col().deleteMany({ projectId });
    },
  };
};

// ── In memory (no main database) ──

const memoryStore = (): JobStore => {
  const jobs = new Map<string, JobRecord>();
  const copy = (job: JobRecord | undefined) => (job ? { ...job } : null);
  return {
    async insert(job) { jobs.set(job.jobId, { ...job }); return { ...job }; },
    async get(jobId) { return copy(jobs.get(jobId)); },
    async list({ projectId, assetId, limit = 100 }) {
      return [...jobs.values()]
        .filter(job => job.projectId === projectId && (!assetId || job.assetId === assetId))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit)
        .map(job => ({ ...job }));
    },
    async update(jobId, patch) { return this.claim(jobId, [], patch); },
    async claim(jobId, statuses, patch, only = {}) {
      const job = jobs.get(jobId);
      if (!job || (statuses.length && !statuses.includes(job.status))) return null;
      if (only.leaseEndedBy && job.leaseUntil && new Date(job.leaseUntil) > only.leaseEndedBy) return null;
      if (only.callbackHash && job.callbackHash !== only.callbackHash) return null;
      Object.assign(job, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
      return { ...job };
    },
    async due(now, limit) {
      return [...jobs.values()]
        .filter(job => job.worker && (
          (job.status === 'pending' && (!job.nextAttemptAt || new Date(job.nextAttemptAt) <= now))
          || (job.status === 'processing' && job.leaseUntil && new Date(job.leaseUntil) <= now)))
        .slice(0, limit)
        .map(job => ({ ...job }));
    },
    async deleteProject(projectId) {
      for (const [id, job] of jobs) if (job.projectId === projectId) jobs.delete(id);
    },
  };
};

let mainDbId: string | undefined;
let memory: JobStore | undefined;

/** The router's main database, where jobs are kept. */
export const setJobStoreDatabase = (config: StreamByConfig) => {
  mainDbId = config.databases?.find(db => db.main)?.id;
};

export function jobStore(): JobStore {
  if (mainDbId && getConnectedIds().includes(mainDbId)) {
    const entry = getConnection(mainDbId);
    return entry.type === 'sql' ? sqlStore(entry.client as Pool) : mongoStore(entry.client as MongoClient);
  }
  return (memory ??= memoryStore());
}
