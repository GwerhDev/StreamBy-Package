import { PrismaClient } from '@prisma/client';
import { ProjectProvider, ProjectInfo, StorageAdapter, ProjectListInfo } from '../types';

export function createPrismaProjectProvider(prisma: PrismaClient, adapter: StorageAdapter): ProjectProvider {
  return {
    async getById(projectId, populateMembers = false) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          exports: { select: { id: true, collectionName: true } },
          members: populateMembers ? true : false,
        },
      });
      if (!project) throw new Error('Project not found');
      return formatProject(project);
    },

    async create(data) {
      const newProject = await prisma.project.create({
        data: {
          dbType: data.dbType,
          name: data.name,
          description: data.description || '',
          image: data.image || '',
          allowUpload: data.allowUpload ?? true,
          allowSharing: data.allowSharing ?? false,
          members: {
            create: data.members?.[0] ? {
              userId: data.members[0].userId,
              role: data.members[0].role,
              archived: false,
            } : undefined,
          },
        },
        include: {
          exports: { select: { id: true, collectionName: true } },
          members: true,
        },
      });
      return formatProject(newProject);
    },

    async update(projectId, updates) {
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          name: updates.name,
          description: updates.description,
          image: updates.image,
          allowUpload: updates.settings?.allowUpload,
          allowSharing: updates.settings?.allowSharing,
        },
        include: {
          exports: { select: { id: true, collectionName: true } },
          members: true,
        },
      });
      if (!updated) throw new Error('Project not found');
      return formatProject(updated);
    },

    async list(userId?: string) {
      const all = await prisma.project.findMany({
        where: userId ? { members: { some: { userId } } } : {},
        include: {
          members: true,
        },
      });
      return all.map(doc => formatProjectList(doc, userId));
    },

    async delete(projectId: string) {
      try {
        await prisma.project.delete({ where: { id: projectId } });
        await adapter.deleteProjectDirectory(projectId);
        return { success: true };
      } catch (error) {
        throw new Error('Project not found');
      }
    },

    async archive(projectId, userId) {
      await prisma.member.updateMany({
        where: { projectId, userId },
        data: { archived: true },
      });
      return { success: true, projects: await this.list(userId) };
    },

    async unarchive(projectId, userId) {
      await prisma.member.updateMany({
        where: { projectId, userId },
        data: { archived: false },
      });
      return { success: true, projects: await this.list(userId) };
    },

    async getExport(projectId: string, exportId: string) {
      const exportDoc = await prisma.export.findFirst({
        where: { id: exportId, projectId: projectId },
      });
      if (!exportDoc) throw new Error('Export not found');
      return exportDoc;
    },

    async addExportToProject(projectId: string, exportId: string) {
      // En Prisma, la relación ya está definida en el modelo Export.
      // No es necesario actualizar el Project directamente.
      // Si se necesita vincular un Export existente a un Project, se haría al crear o actualizar el Export.
      // Por ejemplo, al crear un Export:
      // prisma.export.create({ data: { ..., projectId: projectId } });
      // O al actualizar un Export:
      // prisma.export.update({ where: { id: exportId }, data: { projectId: projectId } });
      // Dado que el método original de Mongoose solo añade el ID, asumimos que el Export ya existe y tiene el projectId correcto.
      // Si la lógica requiere añadir un Export existente a un Project, y el Export no tiene el projectId, se debería actualizar el Export.
      // Por ahora, no se requiere ninguna acción aquí si la relación ya está establecida en el modelo Export.
    },
  };

  function formatProject(doc: any): ProjectInfo {
    return {
      id: doc.id,
      dbType: doc.dbType,
      name: doc.name,
      image: doc.image,
      members: doc.members.map((m: any) => ({
        userId: m.userId,
        username: m.username, // Asumimos que el username y email se obtendrán de un servicio externo si es necesario
        email: m.email,
        role: m.role,
        archived: m.archived ?? false
      })),
      description: doc.description,
      folders: doc.folders || [], // Prisma usa 'folders' en lugar de 'rootFolders'
      settings: {
        allowUpload: doc.allowUpload,
        allowSharing: doc.allowSharing,
      },
      exports: doc.exports || []
    };
  }

  function formatProjectList(doc: any, userId?: string): ProjectListInfo {
    const archived = doc.members?.find((m: any) => m.userId === userId)?.archived ?? false;

    return {
      id: doc.id,
      name: doc.name,
      image: doc.image,
      archived
    };
  }
}