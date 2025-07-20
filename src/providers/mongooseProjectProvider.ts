import { ProjectProvider, ProjectInfo, StorageAdapter, ProjectListInfo } from '../types';
import { Model } from 'mongoose';

export function createMongooseProjectProvider(ProjectModel: Model<any>, ExportModel: Model<any>, adapter: StorageAdapter): ProjectProvider {
  return {
    async getById(projectId, populateMembers = false) {
      let query = ProjectModel.findById(projectId).populate('exports', ['_id', 'collectionName']);
      if (populateMembers) {
        // No longer populating 'members.userId' to avoid dependency on external User model
      }
      const project = await query;
      if (!project) throw new Error('Project not found');
      return formatProject(project);
    },

    async create(data) {
      const newProject = await ProjectModel.create({
        dbType: data.dbType,
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
        rootFolders: data.folders || [],
        allowUpload: data.allowUpload ?? true,
        allowSharing: data.allowSharing ?? false,
      });

      return formatProject(newProject);
    },

    async update(projectId, updates) {
      const updated = await ProjectModel.findByIdAndUpdate(projectId, updates, { new: true }).populate('exports', ['_id', 'collectionName']);
      if (!updated) throw new Error('Project not found');
      return formatProject(updated);
    },

    async list(userId?: string) {
      const all = await ProjectModel.find(userId
        ? { 'members': { $elemMatch: { userId } } }
        : {});
      return all.map(doc => formatProjectList(doc, userId));
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
      return { success: true, projects: await this.list(userId) };
    },

    async unarchive(projectId, userId) {
      await ProjectModel.updateOne(
        { _id: projectId, 'members.userId': userId },
        { $set: { 'members.$.archived': false } }
      );
      return { success: true, projects: await this.list(userId) };
    },

    async getExport(projectId: string, exportId: string) {
      const exportDoc = await ExportModel.findOne({ _id: exportId, project: projectId });
      if (!exportDoc) throw new Error('Export not found');
      return exportDoc;
    },

    async addExportToProject(projectId: string, exportId: string) {
      await ProjectModel.findByIdAndUpdate(
        projectId,
        { $push: { exports: exportId } }
      );
    }

  };

  function formatProject(doc: any): ProjectInfo {
    return {
      id: doc._id.toString(),
      dbType: doc.dbType,
      name: doc.name,
      image: doc.image,
      members: doc.members.map((m: any) => ({
        userId: m.userId,
        role: m.role,
        archived: m.archived ?? false
      })),
      description: doc.description,
      folders: doc.rootFolders || [],
      settings: {
        allowUpload: doc.allowUpload,
        allowSharing: doc.allowSharing,
      },
      exports: doc.exports || []
    };
  }

  function formatProjectList(doc: any, userId?: string): ProjectListInfo {
    const archived = doc.members?.find((m: any) => m.userId?.toString() === userId)?.archived ?? false;

    return {
      id: doc._id.toString(),
      dbType: doc.dbType,
      name: doc.name,
      image: doc.image,
      archived
    };
  }
}
