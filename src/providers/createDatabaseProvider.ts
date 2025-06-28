import mongoose from 'mongoose';
import { initProjectModel } from '../db/initProjectModel';
import { initUserModel } from '../db/initUserModel';
import { createMongoExportProvider } from './mongoExportProvider';
import { createMongoProjectProvider } from './mongoProjectProvider';
import { StorageAdapter } from '../types';
import { initExportModel } from '../db/initExportModel';

type SupportedDbType = 'mongo'; // futuro: 'postgres'

export interface DatabaseCredential {
  dbType: SupportedDbType;
  connectionString: string;
}

export function createDatabaseProvider(
  databases: DatabaseCredential[],
  adapter: StorageAdapter
) {
  const mongoConfig = databases.find((db) => db.dbType === 'mongo');
  if (!mongoConfig) {
    throw new Error('No MongoDB configuration provided. Mongo is currently required.');
  }

  const connection = mongoose.createConnection(mongoConfig.connectionString, {
    dbName: undefined,
  });

  const ExportModel = initExportModel(connection);
  const ProjectModel = initProjectModel(connection);
  const UserModel = initUserModel(connection);
  const exportProvider = createMongoExportProvider(ExportModel);
  const projectProvider = createMongoProjectProvider(ProjectModel, ExportModel, adapter);

  return {
    exportProvider,
    projectProvider,
    mongoConnection: connection,
  };
}
