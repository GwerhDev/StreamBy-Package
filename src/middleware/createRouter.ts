import express, { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { createS3Adapter } from '../adapters/s3';
import { deleteProjectImage, listFilesService } from '../services/file';
import { getPresignedProjectImageUrl, getPresignedUrl } from '../services/presign';

function isProjectMember(project: any, userId: string) {
  return project.members?.some((m: any) => m.userId?.toString() === userId?.toString());
}

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  const adapter: StorageAdapter = config.adapter || (() => {
    switch (config.storageProvider.type) {
      case 's3':
        return createS3Adapter(config.storageProvider.config);
      default:
        throw new Error('Unsupported storage type');
    }
  })();

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
      const updated = await config.projectProvider.update(projectId, { image: '' });

      res.status(201).json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete image', details: err.message });
    }
  });

  router.post('/upload-url', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const { filename, contentType, projectId } = req.body;
      if (!filename || !contentType || !projectId) {
        return res.status(400).json({ error: 'Missing filename, contentType, or projectId' });
      }

      const url = await getPresignedUrl(adapter, contentType, projectId);
      res.json(url);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate upload URL', details: err.message });
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

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await config.projectProvider.getById(projectId);
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

  router.post('/projects/create', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);

      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const { name, description } = req.body;

      const newProject = await config.projectProvider.create({
        name,
        description: description || '',
        members: [{ userId: auth.userId, role: "admin" }]
      });

      res.status(201).json({ project: newProject });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create project', details: err.message });
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
      const project = await config.projectProvider.getById(projectId);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Missing updates payload' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const updated = await config.projectProvider.update(projectId, updates);
      res.status(200).json({ success: true, project: updated });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update project', details: err.message });
    }
  });

  router.delete('/projects/:id', async (req, res) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const project = await config.projectProvider.getById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await config.projectProvider.delete(projectId);

      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete project', details: err.message });
    }
  });

  router.get('/projects', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projects = await config.projectProvider.list(auth.userId);
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list projects', details: err });
    }
  });

  return router;
}
