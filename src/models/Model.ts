import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { Pool } from 'pg';
import { MongoClient, Document, ObjectId, UpdateFilter } from 'mongodb';
import { sqlAdapter } from '../adapters/database/sql';
import { nosqlAdapter } from '../adapters/database/nosql';

export class Model<T extends Document> {
  private connectionIds: string[];
  private tableName: string;

  constructor(connectionIds: string[], tableName: string) {
    this.connectionIds = connectionIds;
    this.tableName = tableName;
  }

  useDbType(dbType: string): Model<T> {
    const filteredConnectionIds = this.connectionIds.filter(id => {
      const connection = getConnection(id);
      return connection.type === dbType;
    });
    return new Model<T>(filteredConnectionIds, this.tableName);
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

        let sqlResults: any[] = [];
        if (this.tableName === 'projects' && processedFilter.members && processedFilter.members.$elemMatch) {
          // Handle members filter for SQL projects
          const userId = processedFilter.members.$elemMatch.userId;
          const query = `
            SELECT p.*, pm."userId" as memberUserId, pm.archived as memberArchived
            FROM "projects" p
            JOIN "project_members" pm ON p.id = pm."projectId"
            WHERE pm."userId" = $1
          `;
          const result = await (connection as Pool).query(query, [userId]);
          sqlResults = result.rows.map(row => ({
            ...row,
            members: [{
              userId: row.memberUserId,
              archived: row.memberArchived,
              // Add other member fields if necessary
            }]
          }));
        } else {
          // General SQL find
          sqlResults = await sqlAdapter.find(connection as Pool, this.tableName, processedFilter);
        }

        for (const item of sqlResults) {
          const transformedItem = this.transformResult(item);
          if (this.tableName === 'projects' && !transformedItem.members) {
            // For projects, if members not already populated by join, fetch from project_members table
            const projectMembers = await sqlAdapter.find(connection as Pool, 'project_members', { projectId: transformedItem.id });
            (transformedItem as any).members = projectMembers.map((member: any) => ({
              userId: member.userId,
              role: member.role, // Assuming role is also stored in project_members
              archived: member.archived,
            }));
          }
          allResults.push(transformedItem);
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
        if (result) {
          const transformedResult = this.transformResult(result);
          if (this.tableName === 'projects') {
            // For projects, fetch members from project_members table
            const projectMembers = await sqlAdapter.find(connection as Pool, 'project_members', { projectId: transformedResult.id });
            (transformedResult as any).members = projectMembers.map((member: any) => ({
              userId: member.userId,
              role: member.role, // Assuming role is also stored in project_members
              archived: member.archived,
            }));
          }
          return transformedResult as T;
        }
      } else if (dbType === 'nosql') {
        if (processedFilter._id && typeof processedFilter._id === 'string') {
          try {
            processedFilter._id = new ObjectId(processedFilter._id);
          } catch (e) {
            // If it's not a valid ObjectId string, it might be a UUID from a SQL project.
            // In this case, this NoSQL connection won't find it, so we can just continue.
            continue;
          }
        }
        const result = await nosqlAdapter.findOne(connection as MongoClient, this.tableName, processedFilter);
        if (result) return result as T;
      }
    }
    return null;
  }

  async create(data: T): Promise<T> {
    const activeConnectionIds = this.connectionIds.filter(id => getConnectedIds().includes(id));
    
    // Determine the target database type from the data payload
    const targetDbType = (data as any).dbType || 'nosql'; // Default to nosql if not specified

    const allClientEntries = activeConnectionIds.map(id => getConnection(id));

    // Find the connection that matches the targetDbType
    const clientEntry = allClientEntries.find(entry => entry.type === targetDbType);

    if (!clientEntry) {
      throw new Error(`No active connection found for database type: ${targetDbType}`);
    }

    const connection = clientEntry.client;
    const dbType = clientEntry.type;

    if (dbType === 'sql') {
      const dataToInsert: any = {};
      let membersToInsert: any[] = [];

      // Iterate over the keys of the incoming data
      for (const key in data) {
        if (this.tableName === 'projects' && key === 'members') {
          membersToInsert = (data as any)[key];
        } else if (this.tableName === 'projects' && key.toLowerCase() === 'dbtype') {
          dataToInsert["dbType"] = (data as any)[key];
        } else {
          dataToInsert[key] = (data as any)[key];
        }
      }

      const created = await sqlAdapter.create(connection as Pool, this.tableName, dataToInsert);

      // Insert members into project_members table for SQL
      if (this.tableName === 'projects' && membersToInsert.length > 0) {
        for (const member of membersToInsert) {
          await sqlAdapter.create(connection as Pool, 'project_members', {
            projectId: created.id,
            userId: member.userId,
            role: member.role,
            archived: member.archived || false,
          });
        }
      }
      return created as T;
    } else if (dbType === 'nosql') {
      const created = await nosqlAdapter.create(connection as MongoClient, this.tableName, data);
      return created as T;
    }
    return data;
  }

  async update(filter: any, data: Partial<T>): Promise<T | null> {
    const existingProject = await this.findOne(filter); // Find the project first
    if (!existingProject) {
      return null; // Project not found
    }

    const targetDbType = (existingProject as any).dbType; // Get the actual dbType of the project

    // Find the connection that matches the targetDbType
    const clientEntry = this.connectionIds
      .map(id => getConnection(id))
      .find(entry => entry.type === targetDbType);

    if (!clientEntry) {
      throw new Error(`No active connection found for database type: ${targetDbType}`);
    }

    const connection = clientEntry.client;
    const dbType = clientEntry.type; // This will be the targetDbType

    let updateFilter: any = {}; // Initialize updateFilter here

    // Construct the updateFilter based on the actual dbType of the project
    if (dbType === 'sql') {
      updateFilter.id = existingProject.id; // Use the 'id' from the existingProject
    } else if (dbType === 'nosql') {
      // Ensure _id is an ObjectId for NoSQL updates
      if (existingProject._id && typeof existingProject._id === 'string') {
        try {
          updateFilter._id = new ObjectId(existingProject._id);
        } catch (e) {
          // If existingProject._id is not a valid ObjectId string, it's an error for NoSQL
          return null; // Or throw a more specific error
        }
      } else {
        updateFilter._id = existingProject._id; // Already an ObjectId or other valid type
      }
    }

    // Handle specific member archiving/unarchiving
    if (data["members.$.archived"] !== undefined && filter["_id"] && filter["members.userId"]) { // Use original filter for projectId and userIdToUpdate
      const originalProjectId = filter["_id"]; // Use the original projectId from the request filter
      const userIdToUpdate = filter["members.userId"];
      const newArchivedStatus = data["members.$.archived"];
      const archivedBy = data["members.$.archivedBy"];
      const archivedAt = data["members.$.archivedAt"];

      if (dbType === 'sql') {
        // For SQL, directly update the project_members table
        const memberUpdateResult = await sqlAdapter.update(
          connection as Pool,
          'project_members',
          { projectId: originalProjectId, userId: userIdToUpdate }, // originalProjectId is fine for SQL
          { archived: newArchivedStatus, archivedBy: archivedBy, archivedAt: archivedAt }
        );
        // After updating the member, fetch the full project to return
        if (memberUpdateResult) {
          const updatedProject = await this.findOne({ _id: originalProjectId });
          return updatedProject as T;
        }
      } else if (dbType === 'nosql') {
        const projectToUpdate = existingProject; // Already fetched

        const updatedMembers = (projectToUpdate as any).members.map((member: any) => {
          if (member.userId === userIdToUpdate) {
            return { ...member, archived: newArchivedStatus, archivedBy: archivedBy, archivedAt: archivedAt };
          }
          return member;
        });

        let objectIdOriginalProjectId: ObjectId;
        try {
          objectIdOriginalProjectId = new ObjectId(originalProjectId); // Convert originalProjectId to ObjectId for NoSQL
        } catch (e) {
          return null;
        }

        const result = await nosqlAdapter.update(connection as MongoClient, this.tableName, { _id: objectIdOriginalProjectId }, { members: updatedMembers });
        if (result) return result as T;
      }
    } else {
      // General update logic
      // Use the correctly constructed updateFilter
      if (dbType === 'sql') {
        const result = await sqlAdapter.update(connection as Pool, this.tableName, updateFilter, data);
        if (result) return result as T;
      } else if (dbType === 'nosql') {
        const result = await nosqlAdapter.update(connection as MongoClient, this.tableName, updateFilter, data as UpdateFilter<T>);
        if (result) return result as T;
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
        console.log(`SQL: Deleting from ${this.tableName} with filter:`, processedFilter);
        const count = await sqlAdapter.delete(connection as Pool, this.tableName, processedFilter);
        console.log(`SQL: Deleted ${count} rows from ${this.tableName}`);
        deletedCount += count;
      } else if (dbType === 'nosql') {
        if (processedFilter._id && typeof processedFilter._id === 'string') {
          try {
            processedFilter._id = new ObjectId(processedFilter._id);
          } catch (e) {
            // If it's not a valid ObjectId string, it might be a UUID from a SQL project.
            // In this case, this NoSQL connection won't find it, so we can just continue.
            continue;
          }
        }
        const count = await nosqlAdapter.delete(connection as MongoClient, this.tableName, processedFilter);
        deletedCount += count;
      }
    }
    return deletedCount;
  }
}