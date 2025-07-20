import { PrismaClient } from '@prisma/client';
import { StorageAdapter, ProjectProvider, ExportProvider, ExportCollectionProvider } from '../types';
import { createPrismaExportProvider } from './prismaExportProvider';
import { createPrismaProjectProvider } from './prismaProjectProvider';
import { createPrismaExportCollectionProvider } from './prismaExportCollectionProvider';

export function createPrismaProvider(connectionString: string, adapter: StorageAdapter) {
  if (!connectionString) {
    console.warn('Connection string is not provided. Prisma client will not be initialized.');
    return null;
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: connectionString,
      },
    },
  });

  const exportProvider: ExportProvider = createPrismaExportProvider(prisma);
  const projectProvider: ProjectProvider = createPrismaProjectProvider(prisma, adapter);
  const exportCollectionProvider: ExportCollectionProvider = createPrismaExportCollectionProvider(prisma);

  return {
    prismaClient: prisma,
    exportProvider,
    projectProvider,
    exportCollectionProvider,
  };
}
