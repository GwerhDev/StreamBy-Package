import { getConnection } from './connectionManager';
import { Pool } from 'pg';
import { MongoClient, Document } from 'mongodb';

export class Model<T extends Document> {
  private connectionId: string;
  private tableName: string;

  constructor(connectionId: string, tableName: string) {
    this.connectionId = connectionId;
    this.tableName = tableName;
  }

  async find(filter: any): Promise<T[]> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      const keys = Object.keys(filter);
      const values = Object.values(filter);
      const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
      const result = await connection.query(`SELECT * FROM "${this.tableName}" WHERE ${where}`, values);
      return result.rows;
    } else if (connection instanceof MongoClient) {
      const db = connection.db();
      const result = await db.collection<T>(this.tableName).find(filter).toArray();
      return result as T[];
    }
    return [];
  }

  async findOne(filter: any): Promise<T | null> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
        const keys = Object.keys(filter);
        const values = Object.values(filter);
        const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
        const result = await connection.query(`SELECT * FROM "${this.tableName}" WHERE ${where} LIMIT 1`, values);
        return result.rows[0] || null;
    } else if (connection instanceof MongoClient) {
        const db = connection.db();
        const result = await db.collection<T>(this.tableName).findOne(filter);
        return result as T | null;
    }
    return null;
  }

  async create(data: T): Promise<T> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
        const keys = Object.keys(data as any).join(', ');
        const values = Object.values(data as any);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        const result = await connection.query(`INSERT INTO "${this.tableName}" (${keys}) VALUES (${placeholders}) RETURNING *`, values);
        return result.rows[0];
    } else if (connection instanceof MongoClient) {
        const db = connection.db();
        const result = await db.collection<T>(this.tableName).insertOne(data as any);
        return { ...data, _id: result.insertedId } as T;
    }
    return data;
  }

  async update(filter: any, data: Partial<T>): Promise<number> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      const dataKeys = Object.keys(data);
      const filterKeys = Object.keys(filter);
      const values = [...Object.values(data), ...Object.values(filter)];
      const setClause = dataKeys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
      const whereClause = filterKeys.map((key, i) => `"${key}" = $${dataKeys.length + i + 1}`).join(' AND ');
      const result = await connection.query(`UPDATE "${this.tableName}" SET ${setClause} WHERE ${whereClause}`, values);
      return result.rowCount || 0;
    } else if (connection instanceof MongoClient) {
      const db = connection.db();
      const result = await db.collection<T>(this.tableName).updateMany(filter, { $set: data });
      return result.modifiedCount;
    }
    return 0;
  }

  async delete(filter: any): Promise<number> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      const keys = Object.keys(filter);
      const values = Object.values(filter);
      const where = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
      const result = await connection.query(`DELETE FROM "${this.tableName}" WHERE ${where}`, values);
      return result.rowCount || 0;
    } else if (connection instanceof MongoClient) {
      const db = connection.db();
      const result = await db.collection<T>(this.tableName).deleteMany(filter);
      return result.deletedCount;
    }
    return 0;
  }
}