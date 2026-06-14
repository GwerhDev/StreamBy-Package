import { getModel } from '../models/manager';
import { ObjectId } from 'mongodb';
import { NodeSchema, DatabaseType, StreamByConfig } from '../types';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { getConnection } from '../adapters/database/connectionManager';
import { createNoSQLExportCollection } from '../adapters/database/nosql';
import { createSQLExportTable } from '../adapters/database/sql';

interface ExportResult {
  exportId: string;
  message: string;
}

export async function createExport(
  config: StreamByConfig,
  projectId: string,
  description: string,
  exportName: string,
  dbType: DatabaseType,
  exportType: 'json' | 'externalApi',
  isPrivate?: boolean,
  allowedOrigin?: string[],
  nodeSchema?: NodeSchema,
  useConnections?: boolean,
  useCredentials?: boolean,
  storageDbId?: string,
): Promise<ExportResult> {
  const targetDb = storageDbId
    ? config.databases?.find(db => db.id === storageDbId)
    : config.databases?.find(db => db.type === dbType && db.main) ||
      config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);
  const resolvedDbType = targetDb.type;

  let exportId: string;

  if (resolvedDbType === 'nosql') {
    const result = await createNoSQLExportCollection(connection.client as MongoClient, projectId, exportName, 'GET', nodeSchema);
    exportId = result.exportId;
  } else if (resolvedDbType === 'sql') {
    const result = await createSQLExportTable(connection.client as Pool, projectId, exportName, nodeSchema);
    exportId = result.exportId;
  } else {
    throw new Error('Unsupported database type');
  }

  const now = new Date();
  const exportEntry = {
    id: exportId, // Always a plain string; works for both UUID (SQL export) and ObjectId hex (nosql export)
    name: exportName,
    type: exportType,
    method: 'GET',
    private: isPrivate,
    allowedOrigin,
    nodeSchema,
    useConnections,
    useCredentials,
    description,
    storageDbId: targetDb.id,
    createdAt: now,
    updatedAt: now,
  };

  const ProjectModel = getModel('projects');
  const updated = await ProjectModel.update(
    { _id: projectId },
    { $push: { exports: exportEntry } } as any,
  );

  if (!updated) {
    throw new Error(`Failed to save export entry to project ${projectId}. The project may not exist or the database update failed.`);
  }

  return { exportId, message: `${exportType} export created successfully` };
}

export async function updateExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  description: string,
  exportName: string,
  dbType: DatabaseType,
  exportType: 'json' | 'externalApi',
  isPrivate?: boolean,
  allowedOrigin?: string[],
  devMode?: boolean,
  devPorts?: number[],
  nodeSchema?: NodeSchema,
  useConnections?: boolean,
  useCredentials?: boolean,
): Promise<ExportResult> {
  // Resolve the project to find where its raw export data lives
  const Project = getModel('projects');
  const project = await Project.findOne({ _id: projectId });
  const isSqlProject = (project as any)?.dbType === 'sql';

  // Find storageDbId from the export entry, or fall back to the legacy dbType lookup
  const exportEntry = (project as any)?.exports?.find((e: any) => String(e.id) === exportId);
  const resolvedStorageDbId = exportEntry?.storageDbId;

  const targetDb = resolvedStorageDbId
    ? config.databases?.find(db => db.id === resolvedStorageDbId)
    : config.databases?.find(db => db.type === dbType && db.main) ||
      config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  if (targetDb.type === 'nosql') {
    const db = (connection.client as MongoClient).db();
    await db.collection('exports').updateOne(
      { _id: new ObjectId(exportId) },
      { $set: { nodeSchema, description, updatedAt: new Date() } },
    );
  }
  // SQL raw export table update would go here if needed in future

  // Update the export entry in the project document
  if (isSqlProject) {
    // For SQL projects: read-modify-write the exports JSONB array
    const SqlProject = getModel('projects', 'sql');
    const currentExports: any[] = (project as any)?.exports ?? [];
    const updatedExports = currentExports.map((e: any) =>
      String(e.id) === exportId
        ? { ...e, name: exportName, private: isPrivate, allowedOrigin, devMode, devPorts, nodeSchema, useConnections, useCredentials, description }
        : e,
    );
    await SqlProject.update({ _id: projectId }, { exports: updatedExports } as any);
  } else {
    const NoSQLProject = getModel('projects');
    await NoSQLProject.update(
      { _id: new ObjectId(projectId), 'exports.id': { $in: [new ObjectId(exportId), exportId] } },
      { $set: { 'exports.$.name': exportName, 'exports.$.private': isPrivate, 'exports.$.allowedOrigin': allowedOrigin, 'exports.$.devMode': devMode, 'exports.$.devPorts': devPorts, 'exports.$.nodeSchema': nodeSchema, 'exports.$.useConnections': useConnections, 'exports.$.useCredentials': useCredentials, 'exports.$.description': description } },
    );
  }

  return { exportId, message: `${exportType} export updated successfully` };
}

export async function deleteExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  dbType: DatabaseType,
): Promise<{ message: string }> {
  // Resolve the project to find where its raw export data lives
  const Project = getModel('projects');
  const project = await Project.findOne({ _id: projectId });
  const isSqlProject = (project as any)?.dbType === 'sql';

  const exportEntry = (project as any)?.exports?.find((e: any) => String(e.id) === exportId);
  const resolvedStorageDbId = exportEntry?.storageDbId;

  const targetDb = resolvedStorageDbId
    ? config.databases?.find(db => db.id === resolvedStorageDbId)
    : config.databases?.find(db => db.type === dbType && db.main) ||
      config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  if (targetDb.type === 'nosql') {
    const db = (connection.client as MongoClient).db();
    await db.collection('exports').deleteOne({ _id: new ObjectId(exportId) });
  }
  // SQL export row deletion would go here if needed in future

  if (isSqlProject) {
    const SqlProject = getModel('projects', 'sql');
    await SqlProject.update({ _id: projectId }, { $pull: { exports: { id: exportId } } } as any);
  } else {
    const NoSQLProject = getModel('projects');
    await NoSQLProject.update(
      { _id: new ObjectId(projectId) },
      { $pull: { exports: { id: new ObjectId(exportId) } } },
    );
  }

  return { message: 'Export deleted successfully' };
}
