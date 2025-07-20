import mongoose from 'mongoose';
import { initProjectModel } from '../db/initProjectModel';
import { createMongooseExportProvider } from './mongooseExportProvider';
import { createMongooseProjectProvider } from './mongooseProjectProvider';
import { StorageAdapter, DatabaseCredential } from '../types';
import { initExportModel } from '../db/initExportModel';
import { createPrismaProvider } from './createPrismaProvider';
import { PrismaClient } from '@prisma/client';
import { createPrismaExportProvider } from './prismaExportProvider';
import { createPrismaProjectProvider } from './prismaProjectProvider';
import { createPrismaExportCollectionProvider } from './prismaExportCollectionProvider';

export function createDatabaseProvider(
  databases: DatabaseCredential[],
  adapter: StorageAdapter
) {
  let mongoConnection: mongoose.Connection | undefined;
  let prismaClient: PrismaClient | undefined;

  const mongoConfig = databases.find((db) => db.dbType === 'nosql');
  if (mongoConfig) {
    if (!mongoConfig.connectionString) {
      throw new Error('MongoDB connection string is required for mongo dbType.');
    }
    mongoConnection = mongoose.createConnection(mongoConfig.connectionString, {
      dbName: undefined,
    });
  }

  const prismaConfig = databases.find((db) => db.dbType === 'sql');
  if (prismaConfig) {
    if (!prismaConfig.connectionString) {
      throw new Error('Prisma connection string is required for prisma dbType.');
    }
    prismaClient = createPrismaProvider(prismaConfig.connectionString) || undefined;
  }

  if (!mongoConnection && !prismaClient) {
    throw new Error('At least one database configuration (mongo or prisma) is required.');
  }

  // If mongoConnection is not defined, we can't create mongo-based providers
  const ExportModel = mongoConnection ? initExportModel(mongoConnection) : undefined;
  const ProjectModel = mongoConnection ? initProjectModel(mongoConnection) : undefined;

  const mongoExportProvider = ExportModel ? createMongooseExportProvider(ExportModel) : undefined;
  const mongoProjectProvider = ProjectModel && ExportModel ? createMongooseProjectProvider(ProjectModel, ExportModel, adapter) : undefined;

  const prismaExportProvider = prismaClient ? createPrismaExportProvider(prismaClient) : undefined;
  const prismaProjectProvider = prismaClient ? createPrismaProjectProvider(prismaClient, adapter) : undefined;
  const prismaExportCollectionProvider = prismaClient ? createPrismaExportCollectionProvider(prismaClient) : undefined;

  return {
    exportProvider: mongoExportProvider || prismaExportProvider,
    projectProviders: {
      nosql: mongoProjectProvider,
      sql: prismaProjectProvider,
    },
    exportCollectionProvider: prismaExportCollectionProvider, // Solo Prisma tiene este por ahora
    mongoConnection,
    prismaClient,
  };
}
