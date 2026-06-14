import { Client, Pool } from 'pg';
import { MongoClient, Db } from 'mongodb';
import { ExternalDbType, CreateTableSchema } from '../types';

// ─── Ephemeral connection helpers ─────────────────────────────────────────────

async function withPostgres<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withMongo<T>(connectionString: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const mongo = new MongoClient(connectionString);
  await mongo.connect();
  try {
    return await fn(mongo.db());
  } finally {
    await mongo.close();
  }
}

// ─── Operations ───────────────────────────────────────────────────────────────

export async function listTablesOrCollections(
  connectionString: string,
  dbType: ExternalDbType,
): Promise<string[]> {
  if (dbType === 'postgresql') {
    return withPostgres(connectionString, async client => {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      return result.rows.map(r => r.table_name);
    });
  }
  return withMongo(connectionString, async db => {
    const cols = await db.listCollections().toArray();
    return cols.map(c => c.name).sort();
  });
}

export async function createTableOrCollection(
  connectionString: string,
  dbType: ExternalDbType,
  schema: CreateTableSchema,
): Promise<void> {
  if (dbType === 'postgresql') {
    const columnDdl = schema.columns.map(col => {
      const nullable = col.nullable === false ? 'NOT NULL' : '';
      const pk = col.primaryKey ? 'PRIMARY KEY' : '';
      return `"${col.name}" ${col.type} ${nullable} ${pk}`.trim();
    }).join(', ');
    const ddl = `CREATE TABLE IF NOT EXISTS "${schema.tableName}" (${columnDdl})`;
    await withPostgres(connectionString, client => client.query(ddl).then(() => undefined));
    return;
  }
  await withMongo(connectionString, async db => {
    await db.createCollection(schema.tableName);
  });
}

export async function queryRecords(
  connectionString: string,
  dbType: ExternalDbType,
  tableName: string,
  limit = 50,
  offset = 0,
): Promise<any[]> {
  if (dbType === 'postgresql') {
    return withPostgres(connectionString, async client => {
      const result = await client.query(
        `SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows;
    });
  }
  return withMongo(connectionString, async db => {
    return db.collection(tableName).find().limit(limit).skip(offset).toArray();
  });
}

export async function insertRecord(
  connectionString: string,
  dbType: ExternalDbType,
  tableName: string,
  record: Record<string, unknown>,
): Promise<any> {
  if (dbType === 'postgresql') {
    return withPostgres(connectionString, async client => {
      const keys = Object.keys(record);
      const values = Object.values(record);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const result = await client.query(
        `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      return result.rows[0];
    });
  }
  return withMongo(connectionString, async db => {
    const result = await db.collection(tableName).insertOne(record as any);
    return { ...record, _id: result.insertedId };
  });
}

export async function updateRecord(
  connectionString: string,
  dbType: ExternalDbType,
  tableName: string,
  recordId: string,
  updates: Record<string, unknown>,
): Promise<any | null> {
  if (dbType === 'postgresql') {
    return withPostgres(connectionString, async client => {
      const keys = Object.keys(updates).filter(k => k !== 'id');
      if (!keys.length) return null;
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const result = await client.query(
        `UPDATE "${tableName}" SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
        [...keys.map(k => updates[k]), recordId],
      );
      return result.rows[0] ?? null;
    });
  }
  return withMongo(connectionString, async db => {
    const { ObjectId } = await import('mongodb');
    const { _id, ...fields } = updates as any;
    let filter: any;
    try { filter = { _id: new ObjectId(recordId) }; } catch { filter = { _id: recordId }; }
    return db.collection(tableName).findOneAndUpdate(filter, { $set: fields }, { returnDocument: 'after' });
  });
}

export async function deleteRecord(
  connectionString: string,
  dbType: ExternalDbType,
  tableName: string,
  recordId: string,
): Promise<boolean> {
  if (dbType === 'postgresql') {
    return withPostgres(connectionString, async client => {
      const result = await client.query(`DELETE FROM "${tableName}" WHERE id = $1`, [recordId]);
      return (result.rowCount ?? 0) > 0;
    });
  }
  return withMongo(connectionString, async db => {
    const { ObjectId } = await import('mongodb');
    let filter: any;
    try { filter = { _id: new ObjectId(recordId) }; } catch { filter = { _id: recordId }; }
    const result = await db.collection(tableName).deleteOne(filter);
    return result.deletedCount > 0;
  });
}

// ─── Internal (pool-based) variants ──────────────────────────────────────────
// These operate on already-connected Pool / MongoClient from connectionManager.
//
// nosql storage pattern: all user records go into a single 'records' collection
// with _projectId and _tableName metadata fields. Table membership is tracked in
// a separate '_tables' collection. SQL keeps the legacy db_{projectId}_{tableName}
// table-per-collection pattern which is appropriate for relational databases.

function quoteSqlTable(tableName: string): string {
  const parts = tableName.split('.');
  return parts.length === 2 ? `"${parts[0]}"."${parts[1]}"` : `"${tableName}"`;
}

const RECORD_META_PROJECTION = { _projectId: 0, _tableName: 0 };

export async function listTablesInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  projectId?: string,
): Promise<string[]> {
  const prefix = projectId ? `db_${projectId}_` : null;
  if (dbType === 'sql') {
    const result = await (client as Pool).query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE'
         AND table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
         ${prefix ? `AND table_name LIKE $1` : ''}
       ORDER BY table_schema, table_name`,
      prefix ? [`${prefix}%`] : [],
    );
    return result.rows.map(r => {
      const full = r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`;
      return prefix ? full.slice(prefix.length) : full;
    });
  }
  const db = (client as MongoClient).db();
  if (!projectId) {
    const cols = await db.listCollections().toArray();
    return cols.map(c => c.name).sort();
  }
  const tables = await db.collection('_tables').find({ _projectId: projectId }).toArray();
  return tables.map((t: any) => t.tableName).sort();
}

export async function queryRecordsInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  tableName: string,
  limit = 50,
  offset = 0,
  projectId?: string,
): Promise<any[]> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${tableName}` : tableName;
    const result = await (client as Pool).query(
      `SELECT * FROM ${quoteSqlTable(fullName)} LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows;
  }
  const db = (client as MongoClient).db();
  const filter: any = {};
  if (projectId) filter._projectId = projectId;
  if (tableName) filter._tableName = tableName;
  return db.collection('records').find(filter, { projection: RECORD_META_PROJECTION }).limit(limit).skip(offset).toArray();
}

export async function queryRecordByIdInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  tableName: string,
  recordId: string,
  projectId?: string,
): Promise<any | null> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${tableName}` : tableName;
    const result = await (client as Pool).query(
      `SELECT * FROM ${quoteSqlTable(fullName)} WHERE id = $1 LIMIT 1`,
      [recordId],
    );
    return result.rows[0] ?? null;
  }
  const db = (client as MongoClient).db();
  const meta: any = {};
  if (projectId) meta._projectId = projectId;
  if (tableName) meta._tableName = tableName;
  const opts = { projection: RECORD_META_PROJECTION };
  let doc = await db.collection('records').findOne({ ...meta, _id: recordId as any }, opts);
  if (!doc) {
    try {
      const { ObjectId } = await import('mongodb');
      doc = await db.collection('records').findOne({ ...meta, _id: new ObjectId(recordId) }, opts);
    } catch { /* invalid ObjectId format — not found */ }
  }
  return doc;
}

export async function createTableOrCollectionInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  schema: CreateTableSchema,
  projectId?: string,
): Promise<void> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${schema.tableName}` : schema.tableName;
    const columnDdl = schema.columns.map(col => {
      const nullable = col.nullable === false ? 'NOT NULL' : '';
      const pk = col.primaryKey ? 'PRIMARY KEY' : '';
      return `"${col.name}" ${col.type} ${nullable} ${pk}`.trim();
    }).join(', ');
    await (client as Pool).query(
      `CREATE TABLE IF NOT EXISTS ${quoteSqlTable(fullName)} (${columnDdl})`,
    );
    return;
  }
  const db = (client as MongoClient).db();
  await db.collection('_tables').insertOne({
    _projectId: projectId ?? null,
    tableName: schema.tableName,
    createdAt: new Date(),
  });
}

export async function insertRecordInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  tableName: string,
  record: Record<string, unknown>,
  projectId?: string,
): Promise<any> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${tableName}` : tableName;
    const keys = Object.keys(record);
    const values = Object.values(record);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const result = await (client as Pool).query(
      `INSERT INTO ${quoteSqlTable(fullName)} (${cols}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return result.rows[0];
  }
  const db = (client as MongoClient).db();
  const doc = { _projectId: projectId ?? null, _tableName: tableName, ...record };
  const result = await db.collection('records').insertOne(doc as any);
  return { ...record, _id: result.insertedId };
}

export async function updateRecordInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  tableName: string,
  recordId: string,
  updates: Record<string, unknown>,
  projectId?: string,
): Promise<any | null> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${tableName}` : tableName;
    const keys = Object.keys(updates).filter(k => k !== 'id');
    if (!keys.length) return null;
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const result = await (client as Pool).query(
      `UPDATE ${quoteSqlTable(fullName)} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map(k => updates[k]), recordId],
    );
    return result.rows[0] ?? null;
  }
  const { ObjectId } = await import('mongodb');
  const { _id, _projectId: _p, _tableName: _t, ...fields } = updates as any;
  const meta: any = {};
  if (projectId) meta._projectId = projectId;
  if (tableName) meta._tableName = tableName;
  let idFilter: any;
  try { idFilter = new ObjectId(recordId); } catch { idFilter = recordId; }
  return (client as MongoClient).db().collection('records').findOneAndUpdate(
    { ...meta, _id: idFilter },
    { $set: fields },
    { returnDocument: 'after', projection: RECORD_META_PROJECTION },
  );
}

export async function deleteRecordInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  tableName: string,
  recordId: string,
  projectId?: string,
): Promise<boolean> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${tableName}` : tableName;
    const result = await (client as Pool).query(
      `DELETE FROM ${quoteSqlTable(fullName)} WHERE id = $1`,
      [recordId],
    );
    return (result.rowCount ?? 0) > 0;
  }
  const { ObjectId } = await import('mongodb');
  const meta: any = {};
  if (projectId) meta._projectId = projectId;
  if (tableName) meta._tableName = tableName;
  let idFilter: any;
  try { idFilter = new ObjectId(recordId); } catch { idFilter = recordId; }
  const result = await (client as MongoClient).db().collection('records').deleteOne({ ...meta, _id: idFilter });
  return result.deletedCount > 0;
}

export async function deleteTableOrCollection(
  connectionString: string,
  dbType: ExternalDbType,
  tableName: string,
): Promise<void> {
  if (dbType === 'postgresql') {
    await withPostgres(connectionString, client =>
      client.query(`DROP TABLE IF EXISTS "${tableName}"`).then(() => undefined),
    );
    return;
  }
  await withMongo(connectionString, async db => {
    await db.dropCollection(tableName);
  });
}

export async function deleteTableOrCollectionInternal(
  client: Pool | MongoClient,
  dbType: 'sql' | 'nosql',
  tableName: string,
  projectId?: string,
): Promise<void> {
  if (dbType === 'sql') {
    const fullName = projectId ? `db_${projectId}_${tableName}` : tableName;
    await (client as Pool).query(`DROP TABLE IF EXISTS ${quoteSqlTable(fullName)}`);
    return;
  }
  const db = (client as MongoClient).db();
  const meta: any = {};
  if (projectId) meta._projectId = projectId;
  if (tableName) meta._tableName = tableName;
  await db.collection('records').deleteMany(meta);
  await db.collection('_tables').deleteOne({ _projectId: projectId ?? null, tableName });
}
