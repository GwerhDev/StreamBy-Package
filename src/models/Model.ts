import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { Pool } from 'pg';
import { MongoClient, Document, ObjectId } from 'mongodb';
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
      const clientEntry = getConnection(connectionId);
      const connection = clientEntry.client;
      const dbType = clientEntry.type;
      let processedFilter = { ...filter };

      if (dbType === 'sql') {
        if (processedFilter._id) {
          processedFilter.id = processedFilter._id;
          delete processedFilter._id;
        }
        const sqlResults = await sqlAdapter.find(connection as Pool, this.tableName, processedFilter);
        for (const item of sqlResults) {
          allResults.push(this.transformResult(item));
        }
      } else if (dbType === 'nosql') {
        const nosqlResults = await nosqlAdapter.find(connection as MongoClient, this.tableName, processedFilter);
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
      const clientEntry = getConnection(connectionId);
      const connection = clientEntry.client;
      const dbType = clientEntry.type;
      let processedFilter = { ...filter };

      if (dbType === 'sql') {
        if (processedFilter._id) {
          processedFilter.id = processedFilter._id;
          delete processedFilter._id;
        }
        const result = await sqlAdapter.findOne(connection as Pool, this.tableName, processedFilter);
        if (result) return result as T;
      } else if (dbType === 'nosql') {
        const result = await nosqlAdapter.findOne(connection as MongoClient, this.tableName, processedFilter);
        if (result) return result as T;
      }
    }
    return null;
  }

  async create(data: T): Promise<T> {
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    const clientEntry = getConnection(activeConnectionIds[0]); // Use the first active connection for creation
    const connection = clientEntry.client;
    const dbType = clientEntry.type;

    if (dbType === 'sql') {
      const created = await sqlAdapter.create(connection as Pool, this.tableName, data);
      return created as T;
    } else if (dbType === 'nosql') {
      const created = await nosqlAdapter.create(connection as MongoClient, this.tableName, data);
      return created as T;
    }
    return data;
  }

  async update(filter: any, data: Partial<T>): Promise<T | null> {
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    for (const connectionId of activeConnectionIds) {
      const clientEntry = getConnection(connectionId);
      const connection = clientEntry.client;
      const dbType = clientEntry.type;
      let processedFilter = { ...filter };

      // Handle specific member archiving/unarchiving
      if (data["members.$.archived"] !== undefined && processedFilter["_id"] && processedFilter["members.userId"]) {
        const projectId = processedFilter["_id"];
        const userIdToUpdate = processedFilter["members.userId"];
        const newArchivedStatus = data["members.$.archived"];
        const archivedBy = data["members.$.archivedBy"];
        const archivedAt = data["members.$.archivedAt"];

        // Fetch the project to modify its members array
        const projectToUpdate = await this.findOne({ _id: projectId });
        if (!projectToUpdate || !projectToUpdate.members) {
          continue; // Project not found or has no members, try next connection
        }

        const updatedMembers = projectToUpdate.members.map((member: any) => {
          if (member.userId === userIdToUpdate) {
            return { ...member, archived: newArchivedStatus, archivedBy: archivedBy, archivedAt: archivedAt };
          }
          return member;
        });

        // Update the project with the modified members array
        const result = await (dbType === 'sql' ? sqlAdapter.update(connection as Pool, this.tableName, { id: projectId }, { members: updatedMembers }) : nosqlAdapter.update(connection as MongoClient, this.tableName, { _id: new ObjectId(projectId) }, { members: updatedMembers }));
        if (result) return result as T;

      } else {
        // General update logic
        if (dbType === 'sql') {
          if (processedFilter._id) {
            processedFilter.id = processedFilter._id;
            delete processedFilter._id;
          }
          const result = await sqlAdapter.update(connection as Pool, this.tableName, processedFilter, data);
          if (result) return result as T;
        } else if (dbType === 'nosql') {
          const result = await nosqlAdapter.update(connection as MongoClient, this.tableName, processedFilter, data);
          if (result) return result as T;
        }
      }
    }
    return null;
  }

  async delete(filter: any): Promise<number> {
    let deletedCount = 0;
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    for (const connectionId of activeConnectionIds) {
      const clientEntry = getConnection(connectionId);
      const connection = clientEntry.client;
      const dbType = clientEntry.type;
      let processedFilter = { ...filter };

      if (dbType === 'sql') {
        if (processedFilter._id) {
          processedFilter.id = processedFilter._id;
          delete processedFilter._id;
        }
        const count = await sqlAdapter.delete(connection as Pool, this.tableName, processedFilter);
        deletedCount += count;
      } else if (dbType === 'nosql') {
        const count = await nosqlAdapter.delete(connection as MongoClient, this.tableName, processedFilter);
        deletedCount += count;
      }
    }
    return deletedCount;
  }
}