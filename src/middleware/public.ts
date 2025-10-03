import { Request, Response, NextFunction } from 'express';

export function publicRoute(req: Request, res: Response, next: NextFunction) {
  if (req.path.includes('/get-export/')) {
    return next();
  }
  return next();
}
