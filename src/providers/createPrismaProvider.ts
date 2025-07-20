import { PrismaClient } from '@prisma/client';

export function createPrismaProvider(connectionString: string) {
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

  return prisma;
}