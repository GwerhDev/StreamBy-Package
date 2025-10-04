import { Pool } from 'pg';
import { FieldDefinition } from '../../types';

export const createSQLExportTable = async (
  connection: Pool,
  projectId: string,
  exportName: string,
  fields: FieldDefinition[]
): Promise<{ collectionName: string; exportId: string }> => {
  const slug = exportName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const tableName = `export_${projectId}_${slug}`;

  const columns = fields.map(field => `"${field.name}" ${field.type}`).join(',');

  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      "projectId" UUID NOT NULL,
      __metadata JSONB NOT NULL,
      ${columns ? `, ${columns}` : ''}
    );
  `;

  await connection.query(createTableQuery);
  console.log(`✅ Table '${tableName}' created with metadata.`);

  const metadata = {
    fields,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Insert metadata as the first row, or a dedicated metadata row
  // For simplicity, we'll just create the table with the metadata column.
  // Actual metadata insertion for validation would happen on data inserts.

  return { collectionName: tableName, exportId: tableName };
};

export const createSQLRawExportTable = async (
  connection: Pool,
  projectId: string,
  exportName: string,
  jsonData?: any
): Promise<{ collectionName: string; exportId: string }> => {
  const slug = exportName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const tableName = `raw_export_${projectId}_${slug}`;

  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      data JSONB NOT NULL
    );
  `;

  await connection.query(createTableQuery);
  console.log(`✅ Raw table '${tableName}' created.`);

  // Insert the raw JSON data directly into the new table
  await connection.query(`INSERT INTO "${tableName}" (data) VALUES ($1)`, [jsonData]);
  console.log(`✅ Raw JSON data inserted into table '${tableName}'.`);

  return { collectionName: tableName, exportId: tableName };
};

export const sqlAdapter = {
  find: async (connection: Pool, tableName: string, filter: any, schema?: string): Promise<any[]> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    let query = `SELECT * FROM ${fullTableName}`;
    if (keys.length > 0) {
      const where = keys.map((key, i) => `"${key}" = ${i + 1}`).join(' AND ');
      query += ` WHERE ${where}`;
    }
    const result = await connection.query(query, values);
    return result.rows;
  },

  findOne: async (connection: Pool, tableName: string, filter: any, schema?: string): Promise<any | null> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = ${i + 1}`).join(' AND ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`SELECT * FROM ${fullTableName} WHERE ${where} LIMIT 1`, values);
    return result.rows[0] || null;
  },

  create: async (connection: Pool, tableName: string, data: any, schema?: string): Promise<any> => {
    const keys = Object.keys(data as any).map(key => `"${key}"`).join(', ');
    const values = Object.values(data as any);
    const placeholders = values.map((_, i) => `${i + 1}`).join(', ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`INSERT INTO ${fullTableName} (${keys}) VALUES (${placeholders}) RETURNING *`, values);
    return result.rows[0];
  },

  update: async (connection: Pool, tableName: string, filter: any, data: any, schema?: string): Promise<any | null> => {
    const dataKeys = Object.keys(data);
    const filterKeys = Object.keys(filter);
    const values = [...Object.values(data), ...Object.values(filter)];
    const setClause = dataKeys.map((key, i) => `"${key}" = ${i + 1}`).join(', ');
    const whereClause = filterKeys.map((key, i) => `"${key}" = ${dataKeys.length + i + 1}`).join(' AND ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`UPDATE ${fullTableName} SET ${setClause} WHERE ${whereClause} RETURNING *`, values);
    return result.rows[0] || null;
  },

  delete: async (connection: Pool, tableName: string, filter: any, schema?: string): Promise<number> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = ${i + 1}`).join(' AND ');
    const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
    const result = await connection.query(`DELETE FROM ${fullTableName} WHERE ${where}`, values);
    return result.rowCount || 0;
  },
};