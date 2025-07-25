import { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../../types';
import { deleteProjectImage, listFilesService } from '../../services/file';
import { getPresignedProjectImageUrl } from '../../services/presign';
import { createStorageProvider } from '../../providers/storage';
import { getModel } from '../../models/manager';

export function storageRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);
  const Project = getModel('projects');

  router.get('/upload-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ message: 'Missing projectId' });
      }

      const response = await getPresignedProjectImageUrl(adapter, projectId);

      res.status(200).json({ ...response, message: 'Presigned URL generated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate presigned URL', details: err.message });
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
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ message: 'Missing projectId' });
      }

      await deleteProjectImage(adapter, projectId);
      const updated = await Project.update({ _id: projectId }, { image: '' });

      res.status(201).json({ ...updated, message: 'Image deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete image', details: err.message });
    }
  });

  router.get('/storages', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = (req.query.projectId || req.headers['x-project-id']) as string;

      if (!projectId) {
        return res.status(403).json({ message: 'Unauthorized or missing projectId' });
      }

      const files = await listFilesService(adapter, req, projectId);
      res.json({ files, message: 'Files listed successfully' });
    } catch (err) {
      res.status(500).json({ message: 'Failed to list files', details: err });
    }
  });

  return router;
}
