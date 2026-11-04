import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';

const SEARCH_LIMIT = 20;

export function userRouter(config: StreamByConfig): Router {
  const router = Router();
  const User = getModel('users');

  router.get('/users/search', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const q = (req.query.q as string || '').trim();

      if (!q) {
        return res.status(400).json({ message: 'Query param q is required' });
      }

      // Searched in the database (its username holding it, case aside), the first 20.
      const found = await User.find({ usernameContains: q }, { limit: SEARCH_LIMIT });

      const users = found
        .slice(0, SEARCH_LIMIT)
        .map((u: any) => ({
          id: u._id || u.id,
          username: u.username,
          profilePic: u.profilePic || '',
        }));

      res.json({ users });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to search users', details: err.message });
    }
  });

  return router;
}
