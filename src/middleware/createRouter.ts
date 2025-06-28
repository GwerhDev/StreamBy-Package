import express, { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { deleteProjectImage, listFilesService } from '../services/file';
import { getPresignedProjectImageUrl } from '../services/presign';
import { createStorageProvider } from '../providers/createStorageProvider';
import { createDatabaseProvider } from '../providers/createDatabaseProvider';

function isProjectMember(project: any, userId: string) {
  return project.members?.some((m: any) => m.userId?.toString() === userId?.toString());
}

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);

  const dbResult = config.projectProvider
    ? { projectProvider: config.projectProvider, exportProvider: config.exportProvider, mongoConnection: undefined }
    : createDatabaseProvider(config.databases!, adapter);

  const projectProvider = dbResult.projectProvider;
  const exportProvider = dbResult.exportProvider;

  router.get('/auth', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      res.status(200).json({ logged: true, ...auth });
    } catch (err) {
      res.status(401).json({ logged: false });
    }
  });

  router.get('/upload-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
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
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }

      await deleteProjectImage(adapter, projectId);
      const updated = await projectProvider.update(projectId, { image: '' });

      res.status(201).json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete image', details: err.message });
    }
  });

  router.get('/files', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = (req.query.projectId || req.headers['x-project-id']) as string;

      if (!projectId || !auth.projects.includes(projectId)) {
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
      const projects = await projectProvider.list(auth.userId);
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list projects', details: err });
    }
  });

  router.post('/projects/create', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);

      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const { name, description } = req.body;

      const newProject = await projectProvider.create({
        name,
        description: description || '',
        members: [{ userId: auth.userId, role: "admin" }]
      });

      res.status(201).json({ project: newProject });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create project', details: err.message });
    }
  });

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await projectProvider.getById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      res.json({ project });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project', details: err.message });
    }
  });

  router.patch('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      const updates = req.body;
      const project = await projectProvider.getById(projectId);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Missing updates payload' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const updated = await projectProvider.update(projectId, updates);
      res.status(200).json({ success: true, project: updated });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update project', details: err.message });
    }
  });

  router.delete('/projects/:id', async (req, res) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await projectProvider.getById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await projectProvider.delete(projectId);

      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete project', details: err.message });
    }
  });

  router.patch('/projects/:id/archive', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await projectProvider.getById(projectId);
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const result = await projectProvider.archive(projectId, auth.userId);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to archive project', details: err.message });
    }
  });

  router.patch('/projects/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await projectProvider.getById(projectId);
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const result = await projectProvider.unarchive(projectId, auth.userId);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to unarchive project', details: err.message });
    }
  });

  router.get('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;
      const exportId = req.params.export_id;

      const project = await projectProvider.getById(projectId);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }

      const data = await exportProvider!.getById(exportId);

      res.json({ data });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch export data', details: err.message });
    }
  });

  router.post('/projects/:id/exports', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;
      const { name, description, collectionName } = req.body;

      if (!name || !collectionName) {
        return res.status(400).json({ error: 'Missing export name or collectionName' });
      }

      const project = await projectProvider.getById(projectId);
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const newExport = await exportProvider!.create({
        name,
        description,
        collectionName,
        projectId
      });

      await projectProvider.addExportToProject(projectId, newExport.id);

      res.status(201).json({ data: newExport });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create export', details: err.message });
    }
  });

  router.get('/projects/:id/members', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await projectProvider.getById(projectId, true);
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
