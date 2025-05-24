import { ProjectProvider, ProjectInfo, StorageAdapter } from '../types';
import { Model } from 'mongoose';

export function createMongoProjectProvider(ProjectModel: Model<any>, adapter: StorageAdapter): ProjectProvider {
  return {
    async getById(projectId) {
      const project = await ProjectModel.findById(projectId);
      if (!project) throw new Error('Project not found');

      return formatProject(project);
    },

    async create(data) {
      const newProject = await ProjectModel.create({
        members: [
          {
            userId: data.members?.[0].userId,
            role: data.members?.[0].role,
            archived: false
          }
        ],
        name: data.name,
        description: data.description || '',
        image: data.image || '',
        rootFolders: data.rootFolders || [],
        allowUpload: data.allowUpload ?? true,
        allowSharing: data.allowSharing ?? false,
      });

      return formatProject(newProject);
    },

    async update(projectId, updates) {
      const updated = await ProjectModel.findByIdAndUpdate(projectId, updates, { new: true });
      if (!updated) throw new Error('Project not found');
      return formatProject(updated);
    },

    async list(userId?: string) {
      const all = await ProjectModel.find(userId
        ? { 'members': { $elemMatch: { userId, archived: { $ne: true } } } }
        : {});
      return all.map(formatProject);
    },

    async listArchived(userId?: string) {
      const all = await ProjectModel.find(userId
        ? { 'members': { $elemMatch: { userId, archived: true } } }
        : {});
      return all.map(formatProject);
    },

    async delete(projectId: string) {
      try {
        await ProjectModel.findByIdAndDelete(projectId);
        await adapter.deleteProjectDirectory(projectId);
        return { success: true };
      } catch (error) {
        throw new Error('Project not found');
      }
    },

    async archive(projectId, userId) {
      await ProjectModel.updateOne(
        { _id: projectId, 'members.userId': userId },
        { $set: { 'members.$.archived': true } }
      );
      return { success: true, projects: await this.list(userId), archivedProjects: await this.listArchived(userId) };
    },

    async unarchive(projectId, userId) {
      await ProjectModel.updateOne(
        { _id: projectId, 'members.userId': userId },
        { $set: { 'members.$.archived': false } }
      );
      return { success: true, projects: await this.list(userId), archivedProjects: await this.listArchived(userId) };
    }

  };
}

function formatProject(doc: any): ProjectInfo {
  return {
    id: doc._id.toString(),
    name: doc.name,
    image: doc.image,
    members: doc.members.map((m: any) => ({
      userId: m.userId,
      role: m.role,
      archived: m.archived ?? false
    })),
    description: doc.description,
    rootFolders: doc.rootFolders || [],
    settings: {
      allowUpload: doc.allowUpload,
      allowSharing: doc.allowSharing,
    }
  };
}
