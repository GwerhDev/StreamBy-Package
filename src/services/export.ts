import { getModel } from '../models/manager';
import { ObjectId } from 'mongodb';
import { NodeSchema, DatabaseType, StreamByConfig } from '../types';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { getConnection } from '../adapters/database/connectionManager';
import { createNoSQLRawExportCollection } from '../adapters/database/nosql';
import { createSQLRawExportTable } from '../adapters/database/sql';

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
): Promise<ExportResult> {
  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
    config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  let exportId: string;

  if (dbType === 'nosql') {
    const result = await createNoSQLRawExportCollection(connection.client as MongoClient, exportName, 'GET', nodeSchema);
    exportId = result.exportId;
  } else if (dbType === 'sql') {
    const result = await createSQLRawExportTable(connection.client as Pool, exportName, nodeSchema);
    exportId = result.exportId;
  } else {
    throw new Error('Unsupported database type');
  }

  const NoSQLProject = getModel('projects', 'nosql');
  await NoSQLProject.update(
    { _id: projectId },
    { $push: { exports: { id: new ObjectId(exportId), name: exportName, type: exportType, method: 'GET', private: isPrivate, allowedOrigin, nodeSchema, useConnections, useCredentials, description } } }
  );

  return { exportId, message: `${exportType} export created successfully` };
}

export async function updateExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  description: string,
  exportName: string,
  storedExportName: string,
  dbType: DatabaseType,
  exportType: 'json' | 'externalApi',
  isPrivate?: boolean,
  allowedOrigin?: string[],
  nodeSchema?: NodeSchema,
  useConnections?: boolean,
  useCredentials?: boolean,
): Promise<ExportResult> {
  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
    config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  const storedSlug = storedExportName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  if (dbType === 'nosql') {
    const db = (connection.client as MongoClient).db();
    await db.collection(storedSlug).updateOne(
      { _id: new ObjectId(exportId) },
      { $set: { nodeSchema, description, updatedAt: new Date() } }
    );
  } else {
    throw new Error('Unsupported database type for update');
  }

  const NoSQLProject = getModel('projects', 'nosql');
  await NoSQLProject.update(
    {
      _id: new ObjectId(projectId),
      'exports.id': { $in: [new ObjectId(exportId), exportId] }
    },
    { $set: { 'exports.$.name': exportName, 'exports.$.private': isPrivate, 'exports.$.allowedOrigin': allowedOrigin, 'exports.$.nodeSchema': nodeSchema, 'exports.$.useConnections': useConnections, 'exports.$.useCredentials': useCredentials, 'exports.$.description': description } }
  );

  return { exportId, message: `${exportType} export updated successfully` };
}

export async function deleteExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  dbType: DatabaseType,
  exportName: string,
): Promise<{ message: string }> {
  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
    config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  const slug = exportName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  if (dbType === 'nosql') {
    const db = (connection.client as MongoClient).db();
    await db.collection(slug).deleteOne({ _id: new ObjectId(exportId) });
  } else {
    throw new Error('Unsupported database type for delete');
  }

  const NoSQLProject = getModel('projects', 'nosql');
  await NoSQLProject.update(
    { _id: new ObjectId(projectId) },
    { $pull: { exports: { id: new ObjectId(exportId) } } }
  );

  return { message: 'Export deleted successfully' };
}
