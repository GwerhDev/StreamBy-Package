import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { Pool } from 'pg';
import { MongoClient, Document } from 'mongodb';
import { sqlAdapter } from '../adapters/database/sql';
import { nosqlAdapter } from '../adapters/database/nosql';

export class Model<T extends Document> {
  private connectionIds: string[];
  private tableName: string;

  constructor(connectionIds: string[], tableName: string) {
    this.connectionIds = connectionIds;
    this.tableName = tableName;
  }

  async find(filter: any): Promise<T[]> {
    const allResults: T[] = [];
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));

    for (const connectionId of activeConnectionIds) {
      const connection = getConnection(connectionId);
      if (connection instanceof Pool) {
        const sqlResults = await sqlAdapter.find(connection, this.tableName, filter);
        for (const item of sqlResults) {
          allResults.push(this.transformResult(item));
        }
      } else if (connection instanceof MongoClient) {
        const nosqlResults = await nosqlAdapter.find(connection, this.tableName, filter);
        for (const item of nosqlResults) {
          allResults.push(this.transformResult(item));
        }
      }
    }
    return allResults;
  }

  private transformResult(item: any): T {
    const transformedItem: any = { ...item };
    if (transformedItem._id && !transformedItem.id) {
      transformedItem.id = transformedItem._id.toString();
    }
    return transformedItem as T;
  }

  async findOne(filter: any): Promise<T | null> {
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    for (const connectionId of activeConnectionIds) {
      const connection = getConnection(connectionId);
      let processedFilter = { ...filter };

      if (connection instanceof Pool) {
        if (processedFilter._id) {
          processedFilter.id = processedFilter._id;
          delete processedFilter._id;
        }
        const result = await sqlAdapter.findOne(connection, this.tableName, processedFilter);
        if (result) return result as T;
      } else if (connection instanceof MongoClient) {
        const result = await nosqlAdapter.findOne(connection, this.tableName, processedFilter);
        if (result) return result as T;
      }
    }
    return null;
  }

  async create(data: T): Promise<T> {
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    const connection = getConnection(activeConnectionIds[0]); // Use the first active connection for creation
    if (connection instanceof Pool) {
      const created = await sqlAdapter.create(connection, this.tableName, data);
      return created as T;
    } else if (connection instanceof MongoClient) {
      const created = await nosqlAdapter.create(connection, this.tableName, data);
      return created as T;
    }
    return data;
  }

  async update(filter: any, data: Partial<T>): Promise<T | null> {
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    for (const connectionId of activeConnectionIds) {
      const connection = getConnection(connectionId);
      let processedFilter = { ...filter };

      if (connection instanceof Pool) {
        if (processedFilter._id) {
          processedFilter.id = processedFilter._id;
          delete processedFilter._id;
        }
        const result = await sqlAdapter.update(connection, this.tableName, processedFilter, data);
        if (result) return result as T;
      } else if (connection instanceof MongoClient) {
        const result = await nosqlAdapter.update(connection, this.tableName, processedFilter, data);
        if (result) return result as T;
      }
    }
    return null;
  }

  async delete(filter: any): Promise<number> {
    let deletedCount = 0;
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    for (const connectionId of activeConnectionIds) {
      const connection = getConnection(connectionId);
      let processedFilter = { ...filter };

      if (connection instanceof Pool) {
        if (processedFilter._id) {
          processedFilter.id = processedFilter._id;
          delete processedFilter._id;
        }
        const count = await sqlAdapter.delete(connection, this.tableName, processedFilter);
        deletedCount += count;
      } else if (connection instanceof MongoClient) {
        const count = await nosqlAdapter.delete(connection, this.tableName, processedFilter);
        deletedCount += count;
      }
    }
    return deletedCount;
  }
}