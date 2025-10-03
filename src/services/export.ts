import { getModel } from '../models/manager';
import { ObjectId } from 'mongodb';
import { FieldDefinition, DatabaseType } from '../types';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { getConnection } from '../adapters/database/connectionManager';
import { createNoSQLExportCollection, createNoSQLRawExportCollection } from '../adapters/database/nosql';
import { createSQLExportTable, createSQLRawExportTable } from '../adapters/database/sql';

interface CreateExportResult {
  exportId: string;
  collectionName: string;
  message: string;
}

import { StreamByConfig } from '../types';

export async function createExport(
  config: StreamByConfig,
  projectId: string,
  exportName: string,
  collectionName: string,
  jsonData: any,
  dbType: DatabaseType,
  isPrivate?: boolean,
  allowedOrigin?: string[]
): Promise<CreateExportResult> {

  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
                   config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  let result: { collectionName: string; exportId: string };

  if (dbType === 'nosql') {
    result = await createNoSQLRawExportCollection(connection.client as MongoClient, projectId, exportName, jsonData, 'GET');
  } else if (dbType === 'sql') {
    result = await createSQLRawExportTable(connection.client as Pool, projectId, exportName, jsonData);
  } else {
    throw new Error('Unsupported database type');
  }

  // Update the project with the new export reference
  // Assuming project metadata is always in NoSQL (MongoDB)
  const NoSQLProject = getModel('projects', 'nosql');
  await NoSQLProject.update(
    { _id: projectId },
    { $push: { exports: { id: dbType === 'nosql' ? new ObjectId(result.exportId) : result.exportId, name: exportName, collectionName: result.collectionName, type: 'raw', method: 'GET', private: isPrivate, allowedOrigin: allowedOrigin } } }
  );

  return { ...result, message: 'Raw export created successfully' };
}

export async function updateExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  exportName: string,
  collectionName: string,
  jsonData: any,
  dbType: DatabaseType,
  isPrivate?: boolean,
  allowedOrigin?: string[]
): Promise<CreateExportResult> {
  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
                   config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  let result: { collectionName: string; exportId: string };

  if (dbType === 'nosql') {
    const db = (connection.client as MongoClient).db();
    const updateData = {
      json: jsonData,
      name: exportName,
      updatedAt: new Date()
    };

    
    await db.collection(collectionName).updateOne({ _id: new ObjectId(exportId) }, { $set: updateData });
    result = { collectionName, exportId };
  } else {
    throw new Error('Unsupported database type for update');
  }
  
  const NoSQLProject = getModel('projects', 'nosql');
    
  await NoSQLProject.update(
    { 
      _id: new ObjectId(projectId), 
      'exports.id': { $in: [new ObjectId(exportId), exportId] } 
    },
    { $set: { 'exports.$.name': exportName, 'exports.$.collectionName': collectionName, 'exports.$.private': isPrivate, 'exports.$.allowedOrigin': allowedOrigin } }
  );
  console.log(result);

  return { ...result, message: 'Raw export updated successfully' };
}

export async function deleteExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  dbType: DatabaseType,
  collectionName: string
): Promise<{ message: string }> {
  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
                   config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  if (dbType === 'nosql') {
    const db = (connection.client as MongoClient).db();
    await db.collection(collectionName).deleteOne({ _id: new ObjectId(exportId) });
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
