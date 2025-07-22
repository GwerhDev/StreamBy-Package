import { Pool } from 'pg';

export const sqlAdapter = {
  find: async (connection: Pool, tableName: string, filter: any): Promise<any[]> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
    const result = await connection.query(`SELECT * FROM "${tableName}" WHERE ${where}`, values);
    return result.rows;
  },

  findOne: async (connection: Pool, tableName: string, filter: any): Promise<any | null> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = ${i + 1}`).join(' AND ');
    const result = await connection.query(`SELECT * FROM "${tableName}" WHERE ${where} LIMIT 1`, values);
    return result.rows[0] || null;
  },

  create: async (connection: Pool, tableName: string, data: any): Promise<any> => {
    const keys = Object.keys(data as any).join(', ');
    const values = Object.values(data as any);
    const placeholders = values.map((_, i) => `${i + 1}`).join(', ');
    const result = await connection.query(`INSERT INTO "${tableName}" (${keys}) VALUES (${placeholders}) RETURNING *`, values);
    return result.rows[0];
  },

  update: async (connection: Pool, tableName: string, filter: any, data: any): Promise<any | null> => {
    const dataKeys = Object.keys(data);
    const filterKeys = Object.keys(filter);
    const values = [...Object.values(data), ...Object.values(filter)];
    const setClause = dataKeys.map((key, i) => `"${key}" = ${i + 1}`).join(', ');
    const whereClause = filterKeys.map((key, i) => `"${key}" = ${dataKeys.length + i + 1}`).join(' AND ');
    const result = await connection.query(`UPDATE "${tableName}" SET ${setClause} WHERE ${whereClause} RETURNING *`, values);
    return result.rows[0] || null;
  },

  delete: async (connection: Pool, tableName: string, filter: any): Promise<number> => {
    const keys = Object.keys(filter);
    const values = Object.values(filter);
    const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
    const result = await connection.query(`DELETE FROM "${tableName}" WHERE ${where}`, values);
    return result.rowCount || 0;
  },
};