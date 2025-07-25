import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';

export function authRouter(config: StreamByConfig): Router {
  const router = Router();

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
      return res.status(200).json({ logged: true, message: 'Authentication successful', ...auth });
    } catch (err: any) {
      return res.status(401).json({ logged: false, message: err.message });
    }
  });

  return router;
}
