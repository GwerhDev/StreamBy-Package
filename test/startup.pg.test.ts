import { describe, it, expect, vi, afterEach } from 'vitest';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';

// Against a local PostgreSQL (as pg.test.ts): StreamBy's tables, made at startup.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';

afterEach(() => vi.restoreAllMocks());

describe("StreamBy's tables at startup", () => {
  it('are made by instances starting together, one at a time, leaving no lock behind', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stamp = Date.now();
    await Promise.all([1, 2, 3].map(n => initConnections([{ id: `startup-${stamp}-${n}`, type: 'sql', connectionString }])));
    expect(errors).toEqual([]);

    const pool = getConnection(`startup-${stamp}-1`).client as Pool;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS held FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.objid = (hashtext('streamby:ensure-tables')::bigint & 4294967295)::oid`,
    );
    expect(rows[0].held).toBe(0);
  });
});
