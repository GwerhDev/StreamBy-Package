import { Pool } from 'pg';
import { setupStreambyPg } from '../src/pg/setup';
import { afterEach, beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('setupStreambyPg', () => {
    let pool: Pool;
    const connectionString = 'postgresql://postgres:mysecretpassword@localhost:5432/postgres';

    beforeAll(async () => {
        pool = new Pool({ connectionString });
        // Ensure the connection is working
        await pool.query('SELECT 1');
    });

    afterAll(async () => {
        await pool.end();
    });

    afterEach(async () => {
        // Clean up any schemas created during tests
        const client = await pool.connect();
        try {
            const res = await client.query(`
                SELECT schema_name FROM information_schema.schemata
                WHERE schema_name LIKE 'test_streamby_schema_%';
            `);
            for (const row of res.rows) {
                await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE;`);
            }
        } finally {
            client.release();
        }
    });

    it('should set up the schema idempotently (calling twice should not fail or duplicate objects)', async () => {
        const schemaName = `test_streamby_schema_${Date.now()}_idempotent`;

        // First setup
        const result1 = await setupStreambyPg({ pool, schema: schemaName });
        expect(result1.didCreateSchema).toBe(true);
        expect(result1.didCreateTables).toBe(true);
        expect(result1.didReset).toBe(false);
        expect(result1.errors).toEqual([]);

        // Get initial counts of tables and indexes
        const client = await pool.connect();
        const tablesBefore = await client.query(`
            SELECT count(*) FROM information_schema.tables
            WHERE table_schema = '${schemaName}';
        `);
        const indexesBefore = await client.query(`
            SELECT count(*) FROM pg_indexes
            WHERE schemaname = '${schemaName}';
        `);
        client.release();

        // Second setup
        const result2 = await setupStreambyPg({ pool, schema: schemaName });
        expect(result2.didCreateSchema).toBe(true); // Still true because IF NOT EXISTS was used
        expect(result2.didCreateTables).toBe(true); // Still true because IF NOT EXISTS was used
        expect(result2.didReset).toBe(false);
        expect(result2.errors).toEqual([]);

        // Verify no new tables or indexes were created (idempotency)
        const client2 = await pool.connect();
        const tablesAfter = await client2.query(`
            SELECT count(*) FROM information_schema.tables
            WHERE table_schema = '${schemaName}';
        `);
        const indexesAfter = await client2.query(`
            SELECT count(*) FROM pg_indexes
            WHERE schemaname = '${schemaName}';
        `);
        client2.release();

        expect(tablesAfter.rows[0].count).toEqual(tablesBefore.rows[0].count);
        expect(indexesAfter.rows[0].count).toEqual(indexesBefore.rows[0].count);
    }, 20000); // Increased timeout for DB operations

    it('should reset the schema when reset is true, then set it up again', async () => {
        const schemaName = `test_streamby_schema_${Date.now()}_reset`;
        const client = await pool.connect();

        try {
            // Initial setup
            await setupStreambyPg({ pool, schema: schemaName });

            // Insert some dummy data
            await client.query(`INSERT INTO "${schemaName}".users (email, password_hash) VALUES ('test@example.com', 'hash');`);
            const userCountBeforeReset = await client.query(`SELECT count(*) FROM "${schemaName}".users;`);
            expect(userCountBeforeReset.rows[0].count).toBe('1');

            // Reset then setup
            const resultReset = await setupStreambyPg({ pool, schema: schemaName, reset: true });
            expect(resultReset.didReset).toBe(true);
            expect(resultReset.didCreateSchema).toBe(true);
            expect(resultReset.didCreateTables).toBe(true);
            expect(resultReset.errors).toEqual([]);

            // Verify data is gone after reset
            const userCountAfterReset = await client.query(`SELECT count(*) FROM "${schemaName}".users;`);
            expect(userCountAfterReset.rows[0].count).toBe('0');

            // Call setup again without reset (should be idempotent)
            const resultSetupAgain = await setupStreambyPg({ pool, schema: schemaName });
            expect(resultSetupAgain.didReset).toBe(false);
            expect(resultSetupAgain.didCreateSchema).toBe(true);
            expect(resultSetupAgain.didCreateTables).toBe(true);
            expect(resultSetupAgain.errors).toEqual([]);

            // Verify schema is still operational (e.g., can insert data)
            await client.query(`INSERT INTO "${schemaName}".users (email, password_hash) VALUES ('another@example.com', 'anotherhash');`);
            const userCountAfterSecondSetup = await client.query(`SELECT count(*) FROM "${schemaName}".users;`);
            expect(userCountAfterSecondSetup.rows[0].count).toBe('1');

        } finally {
            client.release();
        }
    }, 20000); // Increased timeout for DB operations

    it('should throw an error if reset is true in production without allowResetInProd', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const schemaName = `test_streamby_schema_${Date.now()}_prod_reset`;

        try {
            await expect(setupStreambyPg({ pool, schema: schemaName, reset: true })).rejects.toThrow(
                /Attempted to reset schema.*in production environment/
            );
        } finally {
            process.env.NODE_ENV = originalNodeEnv; // Restore original NODE_ENV
        }
    });

    it('should allow reset in production if allowResetInProd is true', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const schemaName = `test_streamby_schema_${Date.now()}_prod_reset_allowed`;

        try {
            const result = await setupStreambyPg({ pool, schema: schemaName, reset: true, allowResetInProd: true });
            expect(result.didReset).toBe(true);
            expect(result.errors).toEqual([]);
        } finally {
            process.env.NODE_ENV = originalNodeEnv; // Restore original NODE_ENV
        }
    });
});
