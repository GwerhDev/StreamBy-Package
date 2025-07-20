import { PrismaClient } from '@prisma/client';
import { ExportProvider } from '../types';

export function createPrismaExportProvider(prisma: PrismaClient): ExportProvider {
  return {
    async getById(exportId: string): Promise<any> {
      return await prisma.export.findUnique({ where: { id: exportId } });
    },
    async create(data: {
      name: string;
      description?: string;
      collectionName: string;
      projectId: string;
    }): Promise<any> {
      return await prisma.export.create({ data });
    },
  };
}