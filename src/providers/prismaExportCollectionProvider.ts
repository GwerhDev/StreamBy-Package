import { PrismaClient } from '@prisma/client';

export function createPrismaExportCollectionProvider(prisma: PrismaClient) {
  return {
    async getById(id: string) {
      return prisma.exportCollection.findUnique({
        where: { id },
        include: { entries: true },
      });
    },
    async create(data: {
      projectId: string;
      name: string;
      entries: Array<{ key: string; value: string }>; // Asumiendo que las entries son key-value pairs
    }) {
      const { entries, ...rest } = data;
      return prisma.exportCollection.create({
        data: {
          ...rest,
          entries: {
            createMany: { data: entries },
          },
        },
        include: { entries: true },
      });
    },
    async update(id: string, data: {
      name?: string;
      entries?: Array<{ key: string; value: string }>;
    }) {
      const { entries, ...rest } = data;
      const updateData: any = { ...rest };

      if (entries) {
        // Eliminar entradas existentes y crear nuevas
        await prisma.exportEntry.deleteMany({ where: { exportCollectionId: id } });
        updateData.entries = {
          createMany: { data: entries },
        };
      }

      return prisma.exportCollection.update({
        where: { id },
        data: updateData,
        include: { entries: true },
      });
    },
    async delete(id: string) {
      await prisma.exportCollection.delete({ where: { id } });
      return { success: true };
    },
  };
}