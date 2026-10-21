import { Request, Response, NextFunction } from 'express';
import { StreamByConfig } from '../types';

// The one route open without a session: a project's public export, read
// (GET /:projectId/export/:exportName, see routes/export). Exactly that path -- not any path
// that has an "export" segment somewhere.
const PUBLIC_EXPORT = /^\/[^/]+\/export\/[^/]+\/?$/;
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export const isPublicRoute = (method: string, path: string): boolean =>
  READ_METHODS.includes(method.toUpperCase()) && PUBLIC_EXPORT.test(path);

export const authenticate = (config: StreamByConfig) => async (req: Request, res: Response, next: NextFunction) => {
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  try {
    const auth = await config.authProvider(req);
    if (!auth || !auth.userId || !auth.role) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    (req as any).auth = auth;
    next();
  } catch (error) {
    console.error('Authentication failed:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};


