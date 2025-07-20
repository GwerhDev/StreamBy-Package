import { StorageAdapter, DatabaseCredential } from '../types';
import { createPrismaProvider } from './createPrismaProvider';
import { createMongooseProvider } from './createMongooseProvider';

export function createDatabaseProvider(
  databases: DatabaseCredential[],
  adapter: StorageAdapter
): DatabaseProviders {
  let mongoProviders: ReturnType<typeof createMongooseProvider> | undefined;
  let prismaProviders: ReturnType<typeof createPrismaProvider> | undefined;

  const mongoConfig = databases.find((db) => db.dbType === 'nosql');
  if (mongoConfig) {
    if (!mongoConfig.connectionString) {
      throw new Error('MongoDB connection string is required for mongo dbType.');
    }
    mongoProviders = createMongooseProvider(mongoConfig.connectionString, adapter) || undefined;
  }

  const prismaConfig = databases.find((db) => db.dbType === 'sql');
  if (prismaConfig) {
    if (!prismaConfig.connectionString) {
      throw new Error('Prisma connection string is required for prisma dbType.');
    }
    prismaProviders = createPrismaProvider(prismaConfig.connectionString, adapter) || undefined;
  }

  if (!mongoProviders && !prismaProviders) {
    throw new Error('At least one database configuration (mongo or prisma) is required.');
  }

  return {
    exportProvider: mongoProviders?.exportProvider || prismaProviders?.exportProvider,
    projectProviders: {
      nosql: mongoProviders?.projectProvider,
      sql: prismaProviders?.projectProvider,
    },
    exportCollectionProvider: mongoProviders?.exportCollectionProvider || prismaProviders?.exportCollectionProvider,
    mongoConnection: mongoProviders?.mongoConnection,
    prismaClient: prismaProviders?.prismaClient,
  };
}
