import mongoose from 'mongoose';
import { initProjectModel } from '../db/initProjectModel';
import { createMongoProjectProvider } from './mongoProjectProvider';
import { StorageAdapter } from '../types';

type SupportedDbType = 'mongo'; // futuro: 'postgres'

export interface DatabaseCredential {
  dbType: SupportedDbType;
  connectionString: string;
}

export function createDatabaseProvider(
  databases: DatabaseCredential[],
  adapter: StorageAdapter
) {
  // Solo una conexión mongo por ahora
  const mongoConfig = databases.find((db) => db.dbType === 'mongo');
  if (!mongoConfig) {
    throw new Error('No MongoDB configuration provided. Mongo is currently required.');
  }

  // Conexión a MongoDB
  const connection = mongoose.createConnection(mongoConfig.connectionString, {
    dbName: undefined, // Opcional: podrías extraer el nombre desde la URI si quisieras
  });

  const ProjectModel = initProjectModel(connection);
  const projectProvider = createMongoProjectProvider(ProjectModel, adapter);

  return {
    projectProvider,
    mongoConnection: connection,
  };
}
