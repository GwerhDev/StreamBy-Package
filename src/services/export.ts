import { getModel } from '../models/manager';
import { ObjectId } from 'mongodb';
import { FieldDefinition, DatabaseType, StreamByConfig, ProjectInfo } from '../types';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { getConnection } from '../adapters/database/connectionManager';
import { createNoSQLExportCollection, createNoSQLRawExportCollection } from '../adapters/database/nosql';
import { createSQLExportTable, createSQLRawExportTable } from '../adapters/database/sql';
import fetch from 'node-fetch';
import { decrypt, isEncryptionKeySet } from '../utils/encryption';

interface CreateExportResult {
  exportId: string;
  collectionName: string;
  message: string;
}

export async function createExport(
  config: StreamByConfig,
  projectId: string,
  exportName: string,
  collectionName: string,
  jsonData: any,
  dbType: DatabaseType,
  exportType: 'structured' | 'raw' | 'externalApi',
  isPrivate?: boolean,
  allowedOrigin?: string[],
  apiUrl?: string,
  credentialId?: string,
): Promise<CreateExportResult> {

  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
                   config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  let result: { collectionName: string; exportId: string };

  if (exportType === 'externalApi') {
    if (!apiUrl) {
      throw new Error('API URL is required for externalApi export type.');
    }

    const ProjectModel = getModel('projects', 'nosql');
    const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

    if (!project) {
      throw new Error('Project not found.');
    }

    let headers: Record<string, string> = {};
    if (credentialId) {
      if (!isEncryptionKeySet()) {
        throw new Error('Encryption key is not set. Cannot use encrypted credentials.');
      }
      const credential = project.apiCredentials?.find(cred => cred.id === credentialId);
      if (!credential) {
        throw new Error(`Credential with ID ${credentialId} not found.`);
      }
      const decryptedValue = decrypt(credential.encryptedValue);
      const authPrefix = credential.prefix ? `${credential.prefix} ` : 'Bearer ';
      headers = {
        'Authorization': `${authPrefix}${decryptedValue}`,
        'Content-Type': 'application/json',
      };
    }

    try {
      const response = await fetch(apiUrl, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch from external API: ${response.statusText}`);
      }
      jsonData = await response.json();
    } catch (error: any) {
      throw new Error(`Error fetching from external API: ${error.message}`);
    }

    // For externalApi, we store the fetched data as a raw export
    if (dbType === 'nosql') {
      result = await createNoSQLRawExportCollection(connection.client as MongoClient, projectId, exportName, jsonData, 'GET');
    } else if (dbType === 'sql') {
      result = await createSQLRawExportTable(connection.client as Pool, projectId, exportName, jsonData);
    } else {
      throw new Error('Unsupported database type for externalApi export');
    }

  } else if (dbType === 'nosql') {
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
    { $push: { exports: { id: dbType === 'nosql' ? new ObjectId(result.exportId) : result.exportId, name: exportName, collectionName: result.collectionName, type: exportType, method: 'GET', private: isPrivate, allowedOrigin: allowedOrigin, apiUrl: apiUrl, credentialId: credentialId } } }
  );

  return { ...result, message: `${exportType} export created successfully` };
}

export async function updateExport(
  config: StreamByConfig,
  projectId: string,
  exportId: string,
  exportName: string,
  collectionName: string,
  jsonData: any,
  dbType: DatabaseType,
  exportType: 'structured' | 'raw' | 'externalApi',
  isPrivate?: boolean,
  allowedOrigin?: string[],
  apiUrl?: string,
  credentialId?: string,
): Promise<CreateExportResult> {
  const targetDb = config.databases?.find(db => db.type === dbType && db.main) ||
                   config.databases?.find(db => db.type === dbType);

  if (!targetDb) {
    throw new Error(`Database connection not found for type ${dbType}`);
  }
  const connection = getConnection(targetDb.id);

  let result: { collectionName: string; exportId: string };

  if (exportType === 'externalApi') {
    if (!apiUrl) {
      throw new Error('API URL is required for externalApi export type.');
    }

    const ProjectModel = getModel('projects', 'nosql');
    const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

    if (!project) {
      throw new Error('Project not found.');
    }

    let headers: Record<string, string> = {};
    if (credentialId) {
      if (!isEncryptionKeySet()) {
        throw new Error('Encryption key is not set. Cannot use encrypted credentials.');
      }
      const credential = project.apiCredentials?.find(cred => cred.id === credentialId);
      if (!credential) {
        throw new Error(`Credential with ID ${credentialId} not found.`);
      }
      const decryptedValue = decrypt(credential.encryptedValue);
      const authPrefix = credential.prefix ? `${credential.prefix} ` : 'Bearer ';
      headers = {
        'Authorization': `${authPrefix}${decryptedValue}`,
        'Content-Type': 'application/json',
      };
    }

    try {
      const response = await fetch(apiUrl, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch from external API: ${response.statusText}`);
      }
      jsonData = await response.json();
    } catch (error: any) {
      throw new Error(`Error fetching from external API: ${error.message}`);
    }

    // For externalApi, we update the fetched data as a raw export
    if (dbType === 'nosql') {
      const db = (connection.client as MongoClient).db();
      const updateData = {
        json: jsonData,
        name: exportName,
        updatedAt: new Date(),
        apiUrl: apiUrl,
        credentialId: credentialId,
      };
      await db.collection(collectionName).updateOne({ _id: new ObjectId(exportId) }, { $set: updateData });
      result = { collectionName, exportId };
    } else {
      throw new Error('Unsupported database type for externalApi export update');
    }

  } else if (dbType === 'nosql') {
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
    { $set: { 'exports.$.name': exportName, 'exports.$.collectionName': collectionName, 'exports.$.private': isPrivate, 'exports.$.allowedOrigin': allowedOrigin, 'exports.$.apiUrl': apiUrl, 'exports.$.credentialId': credentialId } }
  );

  return { ...result, message: `${exportType} export updated successfully` };
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
