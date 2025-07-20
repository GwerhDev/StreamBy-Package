import { PrismaClient } from '@prisma/client';
import { config } from '../config';

export function createPrismaProvider() {
  if (!config.supabaseString) {
    console.warn('SUPABASE_STRING is not set. Prisma client will not be initialized.');
    return null;
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: config.supabaseString,
      },
    },
  });

  return prisma;
}