import express, { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { createS3Adapter } from '../adapters/s3';
import { listFilesService, uploadFileService } from '../services/file';
import { createProjectService } from '../services/project';
import { getPresignedUrl } from '../services/presign';

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

  router.post('/upload-url', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }
  
      const { filename, contentType } = req.body;
  
      if (!filename || !contentType) {
        return res.status(400).json({ error: 'Missing filename or contentType' });
      }
  
      const url = await getPresignedUrl(adapter, filename, contentType);
      res.json({ url });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate presigned URL', details: err.message });
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

  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = (req.query.projectId || req.headers['x-project-id']) as string;

      if (!projectId || !auth.projects.includes(projectId)) {
        return res.status(403).json({ error: 'Unauthorized or missing projectId' });
      }

      const result = await uploadFileService(adapter, req, projectId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to upload file', details: err });
    }
  });

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      if (!projectId || !auth.projects.includes(projectId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const project = await config.projectProvider.getById(projectId);
      res.json({ project });
    } catch (err) {
      res.status(404).json({ error: 'Project not found', details: err });
    }
  });

  router.post('/projects', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const created = await createProjectService(req, config.projectProvider);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create project', details: err.message });
    }
  });

  return router;
}
