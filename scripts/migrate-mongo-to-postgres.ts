/**
 * Migration script: Move all projects from MongoDB to PostgreSQL.
 *
 * Usage:
 *   npx ts-node scripts/migrate-mongo-to-postgres.ts [--dry-run]
 *
 * What it does:
 *   1. Reads all projects from MongoDB `projects` collection.
 *   2. Inserts each into PostgreSQL `streamby.projects` (with all JSONB fields).
 *   3. Inserts each project's members into `streamby.project_members`.
 *   4. Sets `storageDbId` = MONGO_CONFIG_ID on every embedded export entry,
 *      so callers know the raw export data lives in MongoDB.
 *   5. Deletes the project from MongoDB (skipped in --dry-run mode).
 *
 * Raw export collections (named by the project's ObjectId hex) are NOT deleted
 * from MongoDB — they remain accessible via `storageDbId`.
 *
 * Environment variables required (same as .env for dev.ts):
 *   MONGO_URI         — MongoDB connection string
 *   POSTGRES_URI      — PostgreSQL connection string
 *   MONGO_CONFIG_ID   — (optional) The StreamBy config `id` for the MongoDB database.
 *                       Defaults to 'mongo' (matches dev.ts config).
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient, ObjectId } from 'mongodb';
import { Client } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');

const MONGO_URI      = process.env.MONGO_URI;
const POSTGRES_URI   = process.env.POSTGRES_URI;
const MONGO_CONFIG_ID = process.env.MONGO_CONFIG_ID ?? 'mongo';

if (!MONGO_URI || !POSTGRES_URI) {
  console.error('❌ MONGO_URI and POSTGRES_URI must be set in .env');
  process.exit(1);
}

async function main() {
  console.log(`🚀 Starting migration${DRY_RUN ? ' (DRY RUN — no writes)' : ''}…`);

  const mongo = new MongoClient(MONGO_URI!);
  const pg = new Client({ connectionString: POSTGRES_URI! });

  await mongo.connect();
  await pg.connect();
  console.log('✅ Connected to both databases.');

  const db = mongo.db();
  const projects = await db.collection('projects').find({}).toArray();
  console.log(`📦 Found ${projects.length} project(s) in MongoDB.`);

  let migrated = 0;
  let skipped  = 0;
  let members  = 0;

  for (const project of projects) {
    const projectId = (project._id as ObjectId).toHexString();

    // Check if already migrated (idempotent)
    const existing = await pg.query('SELECT id FROM streamby.projects WHERE id = $1', [projectId]);
    if (existing.rowCount && existing.rowCount > 0) {
      console.log(`  ⏭  Skipping ${projectId} (already in PostgreSQL)`);
      skipped++;
      continue;
    }

    // Inject storageDbId into every export entry so callers know where raw data lives
    const exports = ((project.exports as any[]) ?? []).map((e: any) => ({
      ...e,
      id: e.id ? String(e.id) : String(new ObjectId()),
      storageDbId: e.storageDbId ?? MONGO_CONFIG_ID,
    }));

    const allowedOrigin  = project.allowedOrigin  ?? [];
    const credentials    = (project.credentials   ?? []).map((c: any) => ({ ...c, id: String(c.id ?? new ObjectId()) }));
    const apiConnections = (project.apiConnections ?? []).map((c: any) => ({ ...c, id: String(c.id ?? new ObjectId()) }));
    const dbConnections  = (project.dbConnections  ?? []).map((c: any) => ({ ...c, id: String(c.id ?? new ObjectId()) }));

    if (!DRY_RUN) {
      await pg.query(
        `INSERT INTO streamby.projects
           (id, name, description, image, "allowedOrigin", exports, credentials, "apiConnections", "dbConnections", "dbType", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'sql', $10, $11)`,
        [
          projectId,
          project.name ?? '',
          project.description ?? null,
          project.image ?? null,
          JSON.stringify(allowedOrigin),
          JSON.stringify(exports),
          JSON.stringify(credentials),
          JSON.stringify(apiConnections),
          JSON.stringify(dbConnections),
          project.createdAt ?? new Date(),
          project.updatedAt ?? new Date(),
        ],
      );

      // Insert members
      for (const member of (project.members as any[]) ?? []) {
        await pg.query(
          `INSERT INTO streamby.project_members
             (id, "projectId", "userId", role, archived, "archivedBy", "archivedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT ("projectId", "userId") DO NOTHING`,
          [
            String(new ObjectId()),
            projectId,
            member.userId,
            member.role ?? 'member',
            member.archived ?? false,
            member.archivedBy ?? null,
            member.archivedAt ?? null,
          ],
        );
        members++;
      }

      // Delete from MongoDB now that the project is safely in PostgreSQL
      await db.collection('projects').deleteOne({ _id: project._id });
    } else {
      console.log(`  🔍 Would migrate: ${projectId} "${project.name}" (${(project.members ?? []).length} members, ${exports.length} exports)`);
      members += (project.members ?? []).length;
    }

    migrated++;
    if (!DRY_RUN) console.log(`  ✅ Migrated: ${projectId} "${project.name}"`);
  }

  await mongo.close();
  await pg.end();

  console.log('');
  console.log('─────────────────────────────────────────');
  console.log(`  Projects migrated : ${migrated}`);
  console.log(`  Members migrated  : ${members}`);
  console.log(`  Already in PG     : ${skipped}`);
  if (DRY_RUN) console.log('  (Dry run — no data was written or deleted)');
  console.log('─────────────────────────────────────────');
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
