import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SetupStreambyPgOptions, SetupResult } from '../config/types'; // Import SetupResult

export async function setupStreambyPg({
    pool,
    schema = 'streamby',
    reset = false,
    allowResetInProd = false, // New parameter
}: SetupStreambyPgOptions): Promise<SetupResult> { // Update return type
    const client = await pool.connect();
    const lockKey = `streamby:setup:${schema}`;
    const lockHash = `hashtext('${lockKey}')`;

    const result: SetupResult = {
        didCreateSchema: false,
        didCreateTables: false,
        didReset: false,
        errors: [],
    };

    try {
        // Production safety check
        if (process.env.NODE_ENV === 'production' && reset && !allowResetInProd) {
            const errorMessage = `Attempted to reset schema '${schema}' in production environment without explicit 'allowResetInProd' flag. Aborting to prevent data loss.`;
            result.errors.push(errorMessage);
            throw new Error(errorMessage);
        }

        const lockResult = await client.query(`SELECT pg_try_advisory_lock(${lockHash})::boolean AS locked;`);
        if (!lockResult.rows[0].locked) {
            const errorMessage = `Another setup process for schema '${schema}' is already running. Could not acquire advisory lock.`;
            result.errors.push(errorMessage);
            throw new Error(errorMessage);
        }

        await client.query('BEGIN;');

        let fullSql = '';

        // Read and append reset SQL if reset is true
        if (reset) {
            console.log(`[StreamByPgSetup] Resetting schema "${schema}"...`);
            const resetSqlPath = join(process.cwd(), 'src/sql/reset.sql');
            const resetSql = await fs.readFile(resetSqlPath, 'utf8');
            fullSql += resetSql;
            result.didReset = true;
            result.didCreateSchema = true; // Schema is recreated during reset
        } else {
            console.log(`[StreamByPgSetup] Ensuring schema "${schema}" exists...`);
            // If not resetting, the CREATE SCHEMA IF NOT EXISTS in setup.sql will handle it.
            // We can assume it will attempt to create if not exists.
            result.didCreateSchema = true;
        }

        // Read and append setup SQL
        console.log(`[StreamByPgSetup] Creating/updating tables and indexes in schema "${schema}"...`);
        const setupSqlPath = join(process.cwd(), 'src/sql/setup.sql');
        const setupSql = await fs.readFile(setupSqlPath, 'utf8');
        fullSql += setupSql;
        result.didCreateTables = true; // Assuming if setup.sql runs, tables are handled

        // Replace {{SCHEMA}} token with the actual schema name, ensuring proper quoting
        const finalSql = fullSql.replace(/{{SCHEMA}}/g, `"${schema}"`);

        await client.query(finalSql);
        await client.query('COMMIT;');
        console.log(`[StreamByPgSetup] Schema setup for "${schema}" completed successfully.`);

    } catch (error: any) {
        await client.query('ROLLBACK;');
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push(errorMessage);
        console.error(`[StreamByPgSetup] Error during schema setup for "${schema}":`, error);
        throw error; // Re-throw the error after logging and capturing
    } finally {
        await client.query(`SELECT pg_advisory_unlock(${lockHash});`);
        client.release();
    }

    return result;
}