import { Request, Response, NextFunction } from 'express';

export function publicRoute(req: Request, res: Response, next: NextFunction) {
  if (req.path.includes('/public-export/')) {
    return next();
  }
  return next();
}
