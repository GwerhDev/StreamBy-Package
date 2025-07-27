import { Auth } from '../types';
import { Request, Response, NextFunction } from 'express';
import { StreamByConfig } from '../types';

export const authenticate = (config: StreamByConfig) => async (req: Request, res: Response, next: NextFunction) => {
  if (req.path.includes('/public-export/')) {
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


export function checkRole(auth: Auth, required: 'viewer' | 'editor' | 'admin') {
  const roles = ['viewer', 'editor', 'admin'];
  const userIdx = roles.indexOf(auth.role);
  const requiredIdx = roles.indexOf(required);

  if (userIdx < requiredIdx) {
    throw new Error(`Insufficient role: requires ${required}, found ${auth.role}`);
  }
}


