import { getConnection } from '../adapters/database/connectionManager';
import { Pool } from 'pg';
import { MongoClient, Document } from 'mongodb';
import { sqlAdapter } from '../adapters/database/sql';
import { nosqlAdapter } from '../adapters/database/nosql';

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
      return sqlAdapter.find(connection, this.tableName, filter);
    } else if (connection instanceof MongoClient) {
      return nosqlAdapter.find(connection, this.tableName, filter);
    }
    return [];
  }

  async findOne(filter: any): Promise<T | null> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      return sqlAdapter.findOne(connection, this.tableName, filter);
    } else if (connection instanceof MongoClient) {
      return nosqlAdapter.findOne(connection, this.tableName, filter);
    }
    return null;
  }

  async create(data: T): Promise<T> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      return sqlAdapter.create(connection, this.tableName, data);
    } else if (connection instanceof MongoClient) {
      return nosqlAdapter.create(connection, this.tableName, data);
    }
    return data;
  }

  async update(filter: any, data: Partial<T>): Promise<number> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      return sqlAdapter.update(connection, this.tableName, filter, data);
    } else if (connection instanceof MongoClient) {
      return nosqlAdapter.update(connection, this.tableName, filter, data);
    }
    return 0;
  }

  async delete(filter: any): Promise<number> {
    const connection = getConnection(this.connectionId);
    if (connection instanceof Pool) {
      return sqlAdapter.delete(connection, this.tableName, filter);
    } else if (connection instanceof MongoClient) {
      return nosqlAdapter.delete(connection, this.tableName, filter);
    }
    return 0;
  }
}
