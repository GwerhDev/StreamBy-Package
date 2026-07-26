/**
 * Migration script: embed `Credential.encryptedValue` directly into each
 * connection row as `encryptedCredential`, and empty `project.credentials[]`
 * (TCORE-71).
 *
 * Usage:
 *   npx ts-node scripts/migrate-embed-credentials.ts [--dry-run]
 *
 * What it does (idempotent):
 *   For every project with a non-empty `credentials` array, build a
 *   Map<credentialId, encryptedValue> from it. For each of connections[]
 *   (renamed from apiConnections — see TCORE-72/rename-connections migration),
 *   storageConnections[], dbConnections[], distributionConnections[],
 *   renderFarmConnections[] and exports[] (legacy externalApi entries): if the
 *   row has a legacy `credentialId` matching an entry in the map, set
 *   `encryptedCredential` to that ciphertext and drop `credentialId`. Then
 *   empty `project.credentials`.
 *
 *   encrypt()/decrypt() (src/utils/encryption.ts) use the same AES key for both
 *   `Credential.encryptedValue` and the new `Connection.encryptedCredential` —
 *   the ciphertext is copied byte-for-byte, no decrypt+re-encrypt round trip
 *   needed (this script only touches ciphertext strings, never the plaintext
 *   secret, and never needs STREAMBY_ENCRYPTION_KEY set).
 *
 *   MongoDB  — schemaless, so all six arrays are handled directly on the
 *              project document.
 *   Postgres — only credentials/connections/dbConnections/storageConnections/
 *              exports have JSONB columns today (distributionConnections and
 *              renderFarmConnections are Mongo-only phase-4-stub fields, per
 *              connectionManager.ts's ensureTablesExist) — those two are
 *              skipped for the SQL path since there's no column to read/write.
 *
 *   Does NOT drop the `credentials` column in Postgres — it's left as `'[]'`.
 *   Dropping it in Supabase, after verifying the migration, is a separate ops
 *   step (see TCORE-71's "Migracion y ops" section).
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

const MONGO_URI = process.env.MONGO_URI;
const POSTGRES_URI = process.env.POSTGRES_URI;

type LegacyCredential = { id: string; key: string; encryptedValue: string };

// Pure transform shared by both drivers: given a project-shaped object, rewrite
// every connection/export row that still carries a legacy `credentialId`
// referencing `project.credentials[]` into the embedded `encryptedCredential`
// form, and empty `credentials`. Returns changed:false (no-op) for a project
// that has no legacy credentials left to migrate.
function embedCredentialsInProject(project: any, arrayKeys: string[]): { project: any; changed: boolean } {
  const credentials: LegacyCredential[] = project.credentials ?? [];
  if (!credentials.length) return { project, changed: false };

  const byId = new Map(credentials.map((c) => [c.id, c.encryptedValue]));

  const migrateArray = (arr: any[] | undefined) =>
    (arr ?? []).map((item) => {
      if (!item?.credentialId) return item;
      const encryptedValue = byId.get(item.credentialId);
      const { credentialId, ...rest } = item;
      return encryptedValue ? { ...rest, encryptedCredential: encryptedValue } : rest;
    });

  const rewritten: any = { ...project, credentials: [] };
  for (const key of arrayKeys) {
    rewritten[key] = migrateArray(project[key]);
  }

  return { project: rewritten, changed: true };
}

const ALL_ARRAY_KEYS = [
  'connections',
  'storageConnections',
  'dbConnections',
  'distributionConnections',
  'renderFarmConnections',
  'exports',
];

const SQL_ARRAY_KEYS = ['connections', 'storageConnections', 'dbConnections', 'exports'];

async function migrateMongo() {
  if (!MONGO_URI) { console.log('⏭  MONGO_URI not set — skipping Mongo.'); return; }
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const col = mongo.db().collection('projects');

  const filter = { 'credentials.0': { $exists: true } };
  const pending = await col.find(filter).toArray();
  console.log(`📦 Mongo: ${pending.length} project(s) to migrate.`);

  let migrated = 0;
  for (const doc of pending) {
    const { project, changed } = embedCredentialsInProject(doc, ALL_ARRAY_KEYS);
    if (!changed) continue;

    if (!DRY_RUN) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            connections: project.connections,
            storageConnections: project.storageConnections,
            dbConnections: project.dbConnections,
            distributionConnections: project.distributionConnections,
            renderFarmConnections: project.renderFarmConnections,
            exports: project.exports,
            credentials: [],
          },
        },
      );
    }
    migrated++;
  }
  console.log(`  ✅ Mongo: ${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated} project(s).`);
  await mongo.close();
}

async function migrateSql() {
  if (!POSTGRES_URI) { console.log('⏭  POSTGRES_URI not set — skipping Postgres.'); return; }
  const pg = new Client({ connectionString: POSTGRES_URI });
  await pg.connect();

  const pending = await pg.query(
    `SELECT id, credentials, connections, "dbConnections", "storageConnections", exports
       FROM streamby.projects
      WHERE credentials IS NOT NULL AND jsonb_array_length(credentials) > 0`,
  );
  console.log(`📦 Postgres: ${pending.rowCount} project(s) to migrate.`);

  let migrated = 0;
  for (const row of pending.rows) {
    const { project, changed } = embedCredentialsInProject(
      {
        credentials: row.credentials,
        connections: row.connections,
        dbConnections: row.dbConnections,
        storageConnections: row.storageConnections,
        exports: row.exports,
      },
      SQL_ARRAY_KEYS,
    );
    if (!changed) continue;

    if (!DRY_RUN) {
      await pg.query(
        `UPDATE streamby.projects
            SET connections = $1, "dbConnections" = $2, "storageConnections" = $3,
                exports = $4, credentials = '[]'
          WHERE id = $5`,
        [
          JSON.stringify(project.connections),
          JSON.stringify(project.dbConnections),
          JSON.stringify(project.storageConnections),
          JSON.stringify(project.exports),
          row.id,
        ],
      );
    }
    migrated++;
  }
  console.log(`  ✅ Postgres: ${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated} project(s).`);
  await pg.end();
}

async function main() {
  console.log(`🚀 Embed-credentials migration (TCORE-71)${DRY_RUN ? ' (DRY RUN — no writes)' : ''}…`);
  await migrateMongo();
  await migrateSql();
  console.log('─────────────────────────────────────────');
  console.log(DRY_RUN ? '  Dry run — no data was written.' : '  Done.');
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
