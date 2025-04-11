import express, { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { createS3Adapter } from '../adapters/s3';

export function createStreamByRouter(config: StreamByConfig): Router {
  const router = express.Router();

  const adapter: StorageAdapter = (() => {
    switch (config.storageProvider.type) {
      case 's3':
        return createS3Adapter(config.storageProvider.config);
      default:
        throw new Error('Unsupported storage type');
    }
  })();

  router.get('/files', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const files = await adapter.listFiles(auth.projectId);
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list files', details: err });
    }
  });

  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const result = await adapter.uploadFile(req, auth.projectId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to upload file', details: err });
    }
  });

  return router;
}