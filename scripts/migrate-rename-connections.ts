/**
 * Migration script: rename the `ApiConnection` concept to `Connection`.
 *
 * Usage:
 *   npx ts-node scripts/migrate-rename-connections.ts [--dry-run]
 *
 * What it does (idempotent), all on the `projects` collection/table:
 *   1. Field rename: `apiConnections` -> `connections`.
 *      Mongo: $rename. Postgres: ALTER TABLE ... RENAME COLUMN (schema-level,
 *      runs once regardless of --dry-run since it doesn't touch row data).
 *   2. Node-type rename inside every saved ReactFlow nodeSchema: any node with
 *      `type: 'apiConnectionNode'` becomes `type: 'connectionNode'`. This
 *      touches nodeSchema wherever it's embedded on `projects`:
 *        - project.workflow.nodeSchema.nodes[]
 *        - project.exports[].nodeSchema.nodes[]   (exports live embedded in
 *          the project doc/row — see services/export.ts's `exports.$.*`
 *          updates; this is the authoritative copy, kept in sync on edits)
 *      and separately, the standalone `pipelines` collection (Mongo only —
 *      pipelines have no SQL table, see middleware/routes/pipeline.ts):
 *        - pipeline.nodeSchema.nodes[]
 *   3. Drop leftover `credentialNode` nodes (TCORE-72 removed this node type —
 *      the standalone Credential picker/creator on the canvas — but never
 *      swept already-saved nodeSchemas). Any node with `type: 'credentialNode'`
 *      is deleted, along with every edge that had it as source or target
 *      (otherwise you'd be left with dangling edges pointing at nothing).
 *      ReactFlow doesn't crash on an unregistered node type, it silently falls
 *      back to its plain default box — which is why this was easy to miss
 *      until someone actually opened an old canvas and saw the orphaned node.
 *
 *   Deliberately NOT touched: the legacy raw `exports` collection (Mongo) /
 *   table (SQL) created by createNoSQLExportCollection/createSQLExportTable.
 *   It stashes its own nodeSchema snapshot at creation time but is never kept
 *   in sync afterwards (services/export.ts's updateExport only refreshes the
 *   SQL raw table "in the future" per its own comment, and nothing reads this
 *   copy back for rendering) — it's a stale, unused-for-schema legacy copy,
 *   not a second source of truth.
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

const OLD_NODE_TYPE = 'apiConnectionNode';
const NEW_NODE_TYPE = 'connectionNode';
const RETIRED_NODE_TYPE = 'credentialNode';

// Renames the ApiConnection node type and strips retired credentialNode nodes
// (plus any edge touching one) from a single saved nodeSchema.
function migrateNodeSchema(nodeSchema: any): { nodeSchema: any; changed: boolean } {
  if (!nodeSchema?.nodes?.length) return { nodeSchema, changed: false };
  let changed = false;

  const removedIds = new Set<string>();
  const nodes = nodeSchema.nodes
    .filter((n: any) => {
      if (n?.type !== RETIRED_NODE_TYPE) return true;
      removedIds.add(n.id);
      changed = true;
      return false;
    })
    .map((n: any) => {
      if (n?.type !== OLD_NODE_TYPE) return n;
      changed = true;
      return { ...n, type: NEW_NODE_TYPE };
    });

  let edges = nodeSchema.edges;
  if (removedIds.size && Array.isArray(edges)) {
    const before = edges.length;
    edges = edges.filter((e: any) => !removedIds.has(e?.source) && !removedIds.has(e?.target));
    if (edges.length !== before) changed = true;
  }

  return { nodeSchema: changed ? { ...nodeSchema, nodes, edges } : nodeSchema, changed };
}

// Pure transform shared by Mongo/Postgres: rewrites project.workflow and
// project.exports[] node types, and renames apiConnections -> connections.
function embedConnectionsRename(project: any): { project: any; changed: boolean } {
  let changed = false;
  const result: any = { ...project };

  if (project.apiConnections !== undefined) {
    result.connections = project.apiConnections;
    delete result.apiConnections;
    changed = true;
  }

  if (project.workflow) {
    const { nodeSchema, changed: workflowChanged } = migrateNodeSchema(project.workflow.nodeSchema);
    if (workflowChanged) {
      result.workflow = { ...project.workflow, nodeSchema };
      changed = true;
    }
  }

  if (project.exports?.length) {
    let exportsChanged = false;
    const exports = project.exports.map((e: any) => {
      const { nodeSchema, changed: exportChanged } = migrateNodeSchema(e?.nodeSchema);
      if (!exportChanged) return e;
      exportsChanged = true;
      return { ...e, nodeSchema };
    });
    if (exportsChanged) {
      result.exports = exports;
      changed = true;
    }
  }

  return { project: result, changed };
}

async function migrateMongoProjects() {
  if (!MONGO_URI) { console.log('⏭  MONGO_URI not set — skipping Mongo projects.'); return; }
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const col = mongo.db().collection('projects');

  const all = await col.find({}).toArray();
  console.log(`📦 Mongo projects: ${all.length} to inspect.`);

  let migrated = 0;
  for (const doc of all) {
    const { project, changed } = embedConnectionsRename(doc);
    if (!changed) continue;

    if (!DRY_RUN) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: { connections: project.connections, workflow: project.workflow, exports: project.exports },
          ...(doc.apiConnections !== undefined ? { $unset: { apiConnections: '' } } : {}),
        },
      );
    }
    migrated++;
  }
  console.log(`  ✅ Mongo projects: ${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated} project(s).`);
  await mongo.close();
}

async function migrateMongoPipelines() {
  if (!MONGO_URI) { console.log('⏭  MONGO_URI not set — skipping Mongo pipelines.'); return; }
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const col = mongo.db().collection('pipelines');

  const all = await col.find({}).toArray();
  console.log(`📦 Mongo pipelines: ${all.length} to inspect.`);

  let migrated = 0;
  for (const doc of all) {
    const { nodeSchema, changed } = migrateNodeSchema(doc.nodeSchema);
    if (!changed) continue;
    if (!DRY_RUN) {
      await col.updateOne({ _id: doc._id }, { $set: { nodeSchema } });
    }
    migrated++;
  }
  console.log(`  ✅ Mongo pipelines: ${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated} pipeline(s).`);
  await mongo.close();
}

async function migrateSqlProjects() {
  if (!POSTGRES_URI) { console.log('⏭  POSTGRES_URI not set — skipping Postgres.'); return; }
  const pg = new Client({ connectionString: POSTGRES_URI });
  await pg.connect();

  // Schema-level rename — safe to run every time (IF EXISTS / column already
  // renamed on subsequent runs makes this a no-op), independent of --dry-run
  // since it's a metadata change, not a data rewrite.
  if (!DRY_RUN) {
    const hasOldCol = await pg.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'streamby' AND table_name = 'projects' AND column_name = 'apiConnections'`,
    );
    if (hasOldCol.rowCount) {
      await pg.query('ALTER TABLE streamby.projects RENAME COLUMN "apiConnections" TO connections;');
      console.log('  ✅ Postgres: renamed column "apiConnections" -> connections.');
    } else {
      console.log('  ⏭  Postgres: column "apiConnections" not present (already renamed or fresh schema).');
    }
  } else {
    console.log('  (dry run) Postgres: would rename column "apiConnections" -> connections if present.');
  }

  const rows = await pg.query(`SELECT id, workflow, exports FROM streamby.projects`);
  console.log(`📦 Postgres projects: ${rows.rowCount} to inspect for nodeSchema node-type rename.`);

  let migrated = 0;
  for (const row of rows.rows) {
    let changed = false;
    let workflow = row.workflow;
    let exportsCol = row.exports;

    if (workflow) {
      const result = migrateNodeSchema(workflow.nodeSchema);
      if (result.changed) { workflow = { ...workflow, nodeSchema: result.nodeSchema }; changed = true; }
    }

    if (Array.isArray(exportsCol) && exportsCol.length) {
      let exportsChanged = false;
      const updatedExports = exportsCol.map((e: any) => {
        const result = migrateNodeSchema(e?.nodeSchema);
        if (!result.changed) return e;
        exportsChanged = true;
        return { ...e, nodeSchema: result.nodeSchema };
      });
      if (exportsChanged) { exportsCol = updatedExports; changed = true; }
    }

    if (!changed) continue;

    if (!DRY_RUN) {
      await pg.query(
        `UPDATE streamby.projects SET workflow = $1, exports = $2 WHERE id = $3`,
        [JSON.stringify(workflow), JSON.stringify(exportsCol), row.id],
      );
    }
    migrated++;
  }
  console.log(`  ✅ Postgres projects: ${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated} row(s) for node-type rename.`);
  await pg.end();
}

async function main() {
  console.log(`🚀 Rename ApiConnection→Connection migration${DRY_RUN ? ' (DRY RUN — no writes)' : ''}…`);
  await migrateMongoProjects();
  await migrateMongoPipelines();
  await migrateSqlProjects();
  console.log('─────────────────────────────────────────');
  console.log(DRY_RUN ? '  Dry run — no data was written.' : '  Done.');
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
