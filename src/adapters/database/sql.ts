import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { FieldDefinition } from '../../types';

function serializeForPg(v: unknown): unknown {
  if (Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Date))) {
    return JSON.stringify(v);
  }
  return v;
}

export const createSQLExportTable = async (
  connection: Pool,
  projectId: string,
  exportName: string,
  nodeSchema?: any
): Promise<{ exportId: string }> => {
  const exportId = randomUUID();
  await connection.query(
    `INSERT INTO "exports" (id, "projectId", node_schema, name, method, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'GET', NOW(), NOW())`,
    [exportId, projectId, nodeSchema ? JSON.stringify(nodeSchema) : null, exportName],
  );
  return { exportId };
};

export const sqlAdapter = {
  find: async (connection: Pool, tableName: string, filter: any, schema?: string): Promise<any[]> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    let query = `SELECT * FROM ${fullTableName}`;
    if (keys.length > 0) {
      const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
      query += ` WHERE ${where}`;
    }
    const result = await connection.query(query, values);
    return result.rows;
  },

  findOne: async (connection: Pool, tableName: string, filter: any, schema?: string): Promise<any | null> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`SELECT * FROM ${fullTableName} WHERE ${where} LIMIT 1`, values);
    return result.rows[0] || null;
  },

  create: async (connection: Pool, tableName: string, data: any, schema?: string): Promise<any> => {
    const keys = Object.keys(data as any).map(key => `"${key}"`).join(', ');
    const values = Object.values(data as any).map(serializeForPg);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`INSERT INTO ${fullTableName} (${keys}) VALUES (${placeholders}) RETURNING *`, values);
    return result.rows[0];
  },

  update: async (connection: Pool, tableName: string, filter: any, data: any, schema?: string): Promise<any | null> => {
    const dataKeys = Object.keys(data);
    const filterKeys = Object.keys(filter);
    const values = [...Object.values(data).map(serializeForPg), ...Object.values(filter)];
    const setClause = dataKeys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
    const whereClause = filterKeys.map((key, i) => `"${key}" = $${dataKeys.length + i + 1}`).join(' AND ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`UPDATE ${fullTableName} SET ${setClause} WHERE ${whereClause} RETURNING *`, values);
    return result.rows[0] || null;
  },

  delete: async (connection: Pool, tableName: string, filter: any, schema?: string): Promise<number> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`DELETE FROM ${fullTableName} WHERE ${where}`, values);
    return result.rowCount || 0;
  },
};