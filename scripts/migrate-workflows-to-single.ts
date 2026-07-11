/**
 * Migration script: collapse `project.workflows[]` (array) into the single
 * `project.workflow` object (TCORE-57).
 *
 * Usage:
 *   npx ts-node scripts/migrate-workflows-to-single.ts [--dry-run] [--drop-column]
 *
 * What it does (idempotent):
 *   MongoDB  — for every project that still has a `workflows` array and no
 *              `workflow` object, set `workflow = workflows[0]` and unset the
 *              legacy `workflows` array.
 *   Postgres — same, using the JSONB `workflow` / `workflows` columns. With
 *              --drop-column it also drops the legacy `workflows` column AFTER a
 *              successful backfill.
 *
 * The package already reads `workflow ?? workflows[0]` and writes only the new
 * `workflow` field, so this backfill is optional/eager cleanup — data self-heals
 * as projects are opened/saved. Run it to migrate everything at once.
 *
 * Environment variables (same as .env for dev.ts):
 *   MONGO_URI     — MongoDB connection string (skip Mongo step if unset)
 *   POSTGRES_URI  — PostgreSQL connection string (skip SQL step if unset)
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';
import { Client } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const DROP_COLUMN = process.argv.includes('--drop-column');

const MONGO_URI = process.env.MONGO_URI;
const POSTGRES_URI = process.env.POSTGRES_URI;

async function migrateMongo() {
  if (!MONGO_URI) { console.log('⏭  MONGO_URI not set — skipping Mongo.'); return; }
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const col = mongo.db().collection('projects');

  const filter = { workflow: { $exists: false }, 'workflows.0': { $exists: true } };
  const pending = await col.countDocuments(filter);
  console.log(`📦 Mongo: ${pending} project(s) to migrate.`);

  if (!DRY_RUN && pending > 0) {
    const res = await col.updateMany(filter, [
      { $set: { workflow: { $arrayElemAt: ['$workflows', 0] } } },
      { $unset: 'workflows' },
    ]);
    console.log(`  ✅ Mongo: migrated ${res.modifiedCount} project(s).`);
  }
  await mongo.close();
}

async function migrateSql() {
  if (!POSTGRES_URI) { console.log('⏭  POSTGRES_URI not set — skipping Postgres.'); return; }
  const pg = new Client({ connectionString: POSTGRES_URI });
  await pg.connect();

  // Ensure the target columns exist so the script is self-contained (runnable
  // before the 0.29.6 server deploy that adds them via ensureTablesExist).
  if (!DRY_RUN) {
    await pg.query(`
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS workflow  JSONB;
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS pipelines JSONB DEFAULT '[]';
    `);
  }

  // The legacy `workflows` column may not exist on newer schemas — guard the query.
  const hasCol = await pg.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'streamby' AND table_name = 'projects' AND column_name = 'workflows'`,
  );
  if (!hasCol.rowCount) {
    console.log('⏭  Postgres: no legacy "workflows" column — nothing to backfill.');
    await pg.end();
    return;
  }

  const pending = await pg.query(
    `SELECT count(*)::int AS n FROM streamby.projects
     WHERE workflow IS NULL AND workflows IS NOT NULL AND jsonb_array_length(workflows) > 0`,
  );
  console.log(`📦 Postgres: ${pending.rows[0].n} project(s) to migrate.`);

  if (!DRY_RUN) {
    const res = await pg.query(
      `UPDATE streamby.projects
         SET workflow = workflows->0
       WHERE workflow IS NULL AND workflows IS NOT NULL AND jsonb_array_length(workflows) > 0`,
    );
    console.log(`  ✅ Postgres: backfilled ${res.rowCount} project(s).`);

    if (DROP_COLUMN) {
      await pg.query('ALTER TABLE streamby.projects DROP COLUMN IF EXISTS workflows');
      console.log('  🗑  Postgres: dropped legacy "workflows" column.');
    }
  }
  await pg.end();
}

async function main() {
  console.log(`🚀 Workflows→workflow migration${DRY_RUN ? ' (DRY RUN — no writes)' : ''}…`);
  await migrateMongo();
  await migrateSql();
  console.log('─────────────────────────────────────────');
  console.log(DRY_RUN ? '  Dry run — no data was written.' : '  Done.');
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
