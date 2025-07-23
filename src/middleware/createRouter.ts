import express, { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { deleteProjectImage, listFilesService } from '../services/file';
import { getPresignedProjectImageUrl } from '../services/presign';
import { getModel, registerModel } from '../models/manager';
import { createStorageProvider } from '../providers/storage';
import { getConnectedIds, initConnections } from '../adapters/database/connectionManager';

function isProjectMember(project: any, userId: string) {
  return project.members?.some((m: any) => m.userId?.toString() === userId?.toString());
}

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  initConnections(config.databases || []);

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);

  if (config.databases) {
    const allDbIds = config.databases.map(db => db.id);
    registerModel('projects', allDbIds, 'projects');
    registerModel('exports', allDbIds, 'exports');
  }

  const Project = getModel('projects');
  const Export = getModel('exports');

  router.get('/auth', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        throw new Error('Invalid or missing authentication context');
      }
      return res.status(200).json({ logged: true, ...auth });
    } catch (err) {
      return res.status(401).json({ logged: false });
    }
  });

  router.get('/databases', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const connectedDbIds = getConnectedIds();
      const databases = (config.databases || [])
        .filter(db => connectedDbIds.includes(db.id))
        .map(db => ({ name: db.id, value: db.type }));
      res.status(200).json({ databases });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get databases' });
    }
  });

  router.get('/upload-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }

      const url = await getPresignedProjectImageUrl(adapter, projectId);
      res.json(url);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate presigned URL', details: err.message });
    }
  });

  router.delete('/delete-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }

      await deleteProjectImage(adapter, projectId);
      const updated = await Project.update({ _id: projectId }, { image: '' });

      res.status(201).json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete image', details: err.message });
    }
  });

  router.get('/files', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = (req.query.projectId || req.headers['x-project-id']) as string;

      if (!projectId) {
        return res.status(403).json({ error: 'Unauthorized or missing projectId' });
      }

      const files = await listFilesService(adapter, req, projectId);
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list files', details: err });
    }
  });

  router.get('/projects', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const archivedQuery = req.query.archived;
      const filterArchived = archivedQuery !== undefined ? String(archivedQuery).toLowerCase() === 'true' : undefined;

      const allProjects = await Project.find({}); // Fetch all projects
      
      const projects = allProjects
        .filter(project => {
          const isMember = project.members?.some((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!isMember) return false;

          if (filterArchived !== undefined) {
            const currentUserMember = project.members?.find((member: any) => member.userId === auth.userId);
            return currentUserMember ? (currentUserMember.archived || false) === filterArchived : false;
          }
          return true;
        })
        .map(project => {
          const currentUserMember = project.members?.find((member: any) => member.userId === auth.userId);
          return {
            id: project._id || project.id,
            dbType: project.dbType,
            name: project.name,
            image: project.image || '',
            archived: currentUserMember ? currentUserMember.archived || false : false,
          };
        });
      res.json({ projects });
    } catch (err: any) {
      console.error('Error in /projects endpoint:', err);
      res.status(500).json({ error: 'Failed to list projects', details: err });
    }
  });

  router.post('/projects/create', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const { name, description, dbType } = req.body;

      const newProject = await Project.create({
        dbType: dbType || 'nosql',
        name,
        description: description || '',
        members: [{ userId: auth.userId, role: "admin", archived: false }]
      });

      res.status(201).json({ project: { ...newProject, id: newProject._id || newProject.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create project', details: err.message });
    }
  });

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      res.json({ project: { ...project, id: project._id || project.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project', details: err.message });
    }
  });

  router.patch('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      const updates = req.body;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Missing updates payload' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const updated = await Project.update({ _id: projectId }, updates);
      if (!updated) {
        return res.status(404).json({ error: 'Project not found or not updated' });
      }
      res.status(200).json({ success: true, project: { ...updated, id: updated._id || updated.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update project', details: err.message });
    }
  });

  router.delete('/projects/:id', async (req, res) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await Project.delete({ _id: projectId });

      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete project', details: err.message });
    }
  });

  router.patch('/projects/:id/archive', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await Project.update(
        { _id: projectId, "members.userId": auth.userId },
        { "members.$.archived": true, "members.$.archivedBy": auth.userId, "members.$.archivedAt": new Date() }
      );

      const updatedProject = await Project.findOne({ _id: projectId }); // Fetch the updated project

      const projects = (await Project.find({ members: { $elemMatch: { userId: auth.userId } } })).map(project => {
        const currentUserMember = project.members?.find((member: any) => member.userId === auth.userId);
        return {
          id: project._id || project.id,
          dbType: project.dbType,
          name: project.name,
          image: project.image || '',
          archived: currentUserMember ? currentUserMember.archived || false : false,
        };
      });

      // Replace the old project with the updated one in the list
      const finalProjects = projects.map(p => p.id === (updatedProject?._id || updatedProject?.id) ? ({ ...updatedProject, id: updatedProject._id || updatedProject.id, _id: undefined }) : p);

      res.status(200).json({ success: true, projects: finalProjects });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to archive project', details: err.message });
    }
  });

  router.patch('/projects/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await Project.update(
        { _id: projectId, "members.userId": auth.userId },
        { "members.$.archived": false, "members.$.archivedBy": null, "members.$.archivedAt": null }
      );

      const updatedProject = await Project.findOne({ _id: projectId }); // Fetch the updated project

      const projects = (await Project.find({ members: { $elemMatch: { userId: auth.userId } } })).map(project => {
        const currentUserMember = project.members?.find((member: any) => member.userId === auth.userId);
        return {
          id: project._id || project.id,
          dbType: project.dbType,
          name: project.name,
          image: project.image || '',
          archived: currentUserMember ? currentUserMember.archived || false : false,
        };
      });

      // Replace the old project with the updated one in the list
      const finalProjects = projects.map(p => p.id === (updatedProject?._id || updatedProject?.id) ? ({ ...updatedProject, id: updatedProject._id || updatedProject.id, _id: undefined }) : p);

      res.status(200).json({ success: true, projects: finalProjects });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to unarchive project', details: err.message });
    }
  });

  router.get('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const exportId = req.params.export_id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }

      const data = await Export.findOne({ _id: exportId });

      res.json({ data: { ...data, id: data._id || data.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch export data', details: err.message });
    }
  });

  router.post('/projects/:id/exports', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const { name, description, collectionName } = req.body;

      if (!name || !collectionName) {
        return res.status(400).json({ error: 'Missing export name or collectionName' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const newExport = await Export.create({
        name,
        description,
        collectionName,
        projectId
      });

      res.status(201).json({ data: { ...newExport, id: newExport._id || newExport.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create export', details: err.message });
    }
  });

  router.get('/projects/:id/members', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      res.json({ members: project.members });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project members', details: err.message });
    }
  });

  return router;
}
