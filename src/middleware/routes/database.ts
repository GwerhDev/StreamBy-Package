import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getConnectedIds } from '../../adapters/database/connectionManager';

export function databaseRouter(config: StreamByConfig): Router {
  const router = Router();

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

  return router;
}
